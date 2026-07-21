#!/usr/bin/env python3
"""Replay scenario JSONL against OpenAI-compatible candidate models."""
from __future__ import annotations
import argparse, json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def records(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip(): yield json.loads(line)

def slug(value: str) -> str: return "".join(c if c.isalnum() or c in "-_" else "-" for c in value).strip("-")
def now() -> str: return datetime.now(timezone.utc).isoformat()

def anthropic_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate replayable OpenAI-style tool history to Anthropic blocks."""
    converted = []
    for message in messages:
        role = message["role"]
        if role == "tool":
            converted.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": message.get("tool_call_id", ""), "content": message.get("content", ""), "is_error": message.get("is_error", False)}]})
        elif role == "assistant":
            blocks = []
            if message.get("content"): blocks.append({"type": "text", "text": message["content"]})
            for call in message.get("tool_calls", []):
                function = call.get("function", {})
                try: arguments = json.loads(function.get("arguments", "{}"))
                except (TypeError, json.JSONDecodeError): arguments = {}
                blocks.append({"type": "tool_use", "id": call.get("id", ""), "name": function.get("name", ""), "input": arguments})
            converted.append({"role": "assistant", "content": blocks})
        else:
            converted.append({"role": role, "content": message.get("content", "")})
    return converted

def call(model: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    req = scenario["request"]; api_format = model.get("api_format", "openai")
    payload = {"model": model.get("model", model["name"]), "messages": req["messages"], "temperature": model.get("temperature", 0), "max_tokens": model.get("max_tokens", 4096)}
    if api_format == "anthropic":
        system = [m["content"] for m in payload["messages"] if m["role"] == "system"]
        payload["messages"] = anthropic_messages([m for m in payload["messages"] if m["role"] != "system"])
        if system: payload["system"] = "\n".join(system)
        payload["tools"] = [{"name": t["function"]["name"], "description": t["function"].get("description", ""), "input_schema": t["function"].get("parameters", {})} for t in req.get("tools", [])]
    elif req.get("tools"): payload["tools"] = req["tools"]
    key = model.get("api_key", "")
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": "openclaw-eval/0.1"}
    if api_format == "anthropic": headers = {"Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "User-Agent": "openclaw-eval/0.1"}
    started = time.monotonic()
    try:
        endpoint = "/messages" if api_format == "anthropic" else "/chat/completions"
        request = Request(model["base_url"].rstrip("/") + endpoint, data=json.dumps(payload).encode(), headers=headers, method="POST")
        with urlopen(request, timeout=float(model.get("timeout", 180))) as response: data = json.loads(response.read())
        if api_format == "anthropic":
            blocks = data.get("content", []); message={"content":"\n".join(b.get("text", "") for b in blocks if b.get("type") == "text"), "tool_calls":[{"id":b.get("id"),"type":"function","function":{"name":b.get("name"),"arguments":json.dumps(b.get("input", {}))}} for b in blocks if b.get("type") == "tool_use"]}; usage=data.get("usage", {})
        else: message = data["choices"][0]["message"]; usage = data.get("usage", {})
        return {"id": scenario["id"], "model": model["name"], "category": scenario.get("category"), "task_id": scenario.get("task_id"),
                "prediction": message.get("content") or "", "tool_calls": message.get("tool_calls") or [],
                "token_in": usage.get("prompt_tokens", usage.get("input_tokens", 0)),
                "token_out": usage.get("completion_tokens", usage.get("output_tokens", 0)),
                "latency_ms": round((time.monotonic()-started)*1000), "status": "ok", "completed_at": now()}
    except (HTTPError, URLError, TimeoutError, KeyError, ValueError) as exc:
        if isinstance(exc, HTTPError):
            try: detail = exc.read().decode("utf-8", errors="replace")[:2000]
            except OSError: detail = ""
            error = f"HTTP {exc.code}: {detail or exc.reason}"
        else: error = str(exc)
        return {"id": scenario["id"], "model": model["name"], "category": scenario.get("category"), "task_id": scenario.get("task_id"),
                "prediction": "", "tool_calls": [], "token_in": 0, "token_out": 0,
                "latency_ms": round((time.monotonic()-started)*1000), "status": "error", "error": error, "completed_at": now()}

def main() -> int:
    p=argparse.ArgumentParser(description="Run candidate-model inference with checkpoint/resume")
    p.add_argument("--scenarios", type=Path, required=True); p.add_argument("--models", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True); p.add_argument("--state-dir", type=Path); p.add_argument("--limit", type=int, default=0)
    args=p.parse_args(); scenarios=list(records(args.scenarios)); scenarios=scenarios[:args.limit or None]
    models=json.loads(args.models.read_text()).get("models", [])
    if not models: raise SystemExit("models config must contain a non-empty 'models' array")
    for model in models:
        output=args.output_dir/slug(model["name"]); output.mkdir(parents=True, exist_ok=True); state=(args.state_dir or args.output_dir)/slug(model["name"]); state.mkdir(parents=True, exist_ok=True); checkpoint=state/"checkpoint.jsonl"; predictions=output/"predictions.jsonl"
        previous={r["id"]:r for r in records(checkpoint)} if checkpoint.exists() else {}
        pending=[s for s in scenarios if previous.get(s["id"], {}).get("status") != "ok"]
        workers=int(model.get("concurrency", 1)); print(f"[{model['name']}] pending {len(pending)}/{len(scenarios)}")
        with checkpoint.open("a", encoding="utf-8") as out, ThreadPoolExecutor(max_workers=workers) as pool:
            futures=[pool.submit(call, model, s) for s in pending]
            for future in as_completed(futures): out.write(json.dumps(future.result(), ensure_ascii=False)+"\n"); out.flush()
        final={r["id"]:r for r in records(checkpoint)}
        with predictions.open("w", encoding="utf-8") as out:
            for s in scenarios: out.write(json.dumps(final[s["id"]], ensure_ascii=False)+"\n")
        counts={status: sum(row.get("status")==status for row in final.values()) for status in {row.get("status") for row in final.values()}}
        (output/"summary.json").write_text(json.dumps({"model":model["name"],"total":len(scenarios),"status_counts":counts},indent=2),encoding="utf-8")
    return 0
if __name__ == "__main__": raise SystemExit(main())
