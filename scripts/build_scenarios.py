#!/usr/bin/env python3
"""Convert captured OpenClaw API traces into replayable scenario JSONL.

This is a lossless trace-to-inference boundary: every source API trace becomes
one scenario. Sampling belongs in a later dataset-selection stage, not here.
"""
from __future__ import annotations
import argparse, json, re
from pathlib import Path
from typing import Any


def text(value: Any) -> str:
    """Extract visible text; tool blocks remain structured trajectory data."""
    if isinstance(value, str): result = value
    elif isinstance(value, list): result = "\n".join(text(x) for x in value)
    elif isinstance(value, dict): result = str(value.get("text", "")) if value.get("type") == "text" else ""
    else: result = "" if value is None else str(value)
    # Internal routing marker used by the concurrent collector. It is not part
    # of the user scenario and must not affect candidate-model inference.
    return re.sub(r"\s*\[PINCHBENCH_TRACE task_id=[^\s\]]+ category=[^\s\]]+\]", "", result)


def tool_calls(content: Any) -> list[dict[str, Any]]:
    calls = []
    for block in content if isinstance(content, list) else []:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            calls.append({"id": block.get("id", ""), "type": "function", "function": {
                "name": block.get("name", ""), "arguments": json.dumps(block.get("input", {}), ensure_ascii=False)}})
    return calls


def openai_request(request: dict[str, Any]) -> dict[str, Any]:
    """Preserve assistant tool calls and user tool results for replay."""
    messages = []
    system = text(request.get("system"))
    if system: messages.append({"role": "system", "content": system})
    for message in request.get("messages", []):
        role, content = message.get("role", "user"), message.get("content")
        if role == "assistant":
            item: dict[str, Any] = {"role": "assistant", "content": text(content)}
            calls = tool_calls(content)
            if calls: item["tool_calls"] = calls
            messages.append(item)
            continue
        visible = text(content)
        if visible: messages.append({"role": role, "content": visible})
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                result = {"role": "tool", "tool_call_id": block.get("tool_use_id", ""), "content": text(block.get("content"))}
                if block.get("is_error"): result["is_error"] = True
                messages.append(result)
    tools = [{"type": "function", "function": {"name": t.get("name"), "description": t.get("description", ""), "parameters": t.get("input_schema", {})}}
             for t in request.get("tools", []) if t.get("name")]
    return {"messages": messages, "tools": tools}


def response_text(response: dict[str, Any]) -> str:
    return text(response.get("content", []))


def main() -> int:
    p = argparse.ArgumentParser(description="Build router scenarios from logger-proxy JSONL traces")
    p.add_argument("--trace-dir", type=Path, required=True, help="Directory containing api_logs/**/*.jsonl")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()
    files = sorted(args.trace_dir.rglob("*.jsonl"))
    if not files: raise SystemExit(f"No JSONL traces found under {args.trace_dir}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    trace_root = args.trace_dir.resolve()
    # New run layout stores traces at runs/<run-id>/collect/traces.  Retain
    # compatibility with the former runs/<run-id>/api_logs location.
    source_run_id = trace_root.parent.parent.name if trace_root.name == "traces" and trace_root.parent.name == "collect" else trace_root.parent.name
    written = 0
    with args.output.open("w", encoding="utf-8") as out:
        for path in files:
            for line in path.read_text(encoding="utf-8").splitlines():
                try: trace = json.loads(line)
                except json.JSONDecodeError: continue
                request, response, meta = trace.get("request", {}), trace.get("response", {}), trace.get("_meta", {})
                if not request.get("messages"): continue
                trace_id = meta.get("id") or f"{path.relative_to(args.trace_dir)}:{written}"
                scenario_id = f"{source_run_id}:{trace_id}"
                record = {"id": scenario_id, "source_run_id": source_run_id, "source_trace_id": trace_id, "call_index": meta.get("call_index"), "task_id": meta.get("task_id"),
                          "category": meta.get("category"), "request": openai_request(request),
                          "reference": {"response_text": response_text(response), "tool_calls": tool_calls(response.get("content", [])), "raw_response": response},
                          "source": str(path)}
                out.write(json.dumps(record, ensure_ascii=False) + "\n"); written += 1
                if args.limit and written >= args.limit: break
            if args.limit and written >= args.limit: break
    print(f"Wrote {written} scenarios (one per source API trace) to {args.output}")
    return 0

if __name__ == "__main__": raise SystemExit(main())
