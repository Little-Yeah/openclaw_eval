from __future__ import annotations

import json
from pathlib import Path

from pinch_router.context import build_routing_context
from pinch_router.schemas import TraceInput


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    task = (ROOT / "pinchbench-skill" / "tasks" / "task_test_generation.md").read_text(encoding="utf-8")
    prompt = task.split("## Prompt", 1)[1].split("## Expected Behavior", 1)[0].strip()

    tools = [
        {"name": "list_files", "arguments": {"path": "relative path, default ."}},
        {"name": "read_file", "arguments": {"path": "relative file path", "start_line": "optional", "end_line": "optional"}},
        {"name": "write_file", "arguments": {"path": "relative file path", "content": "text"}},
    ]
    system = (
        "You are a PinchBench workspace agent. Complete the task using only the listed tools when needed. "
        "Respond with exactly one JSON object and no markdown: "
        'For example, to inspect files return exactly {"type":"tool","name":"list_files","arguments":{"path":"."}}. '
        'For a tool call use {"type":"tool","name":"read_file|list_files|write_file","arguments":{...}} '
        'or {"type":"final","answer":"..."}. Available tools: '
        + json.dumps(tools)
    )

    events = [
        json.loads(line)
        for line in (ROOT / "apps" / "api" / "var" / "runs" / "run_20260722_161554_23473b8b" / "events.jsonl").read_text(encoding="utf-8").splitlines()
        if line
    ]

    step0 = events[3]
    tool1 = events[4]
    step1 = events[7]
    tool2 = events[8]

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": step0["content"]},
        {"role": "user", "content": f"Tool result for read_file:\n{tool1['result']}\nChoose the next JSON action."},
        {"role": "assistant", "content": step1["content"]},
        {"role": "user", "content": f"Tool result for write_file:\n{tool2['result']}\nChoose the next JSON action."},
    ]

    trace = TraceInput.model_validate(
        {
            "messages": messages,
            "tools": [
                {"name": "list_files", "description": str(tools[0]["arguments"])},
                {"name": "read_file", "description": str(tools[1]["arguments"])},
                {"name": "write_file", "description": str(tools[2]["arguments"])},
            ],
            "agent_state": {"step": 2, "mode": "tool_or_final"},
            "actual_input_tokens": max(1, sum(len(message["content"]) for message in messages) // 4),
            "candidate_labels": ["deepseek-v4-flash", "deepseek-v4-pro"],
            "preference": 1,
        }
    )

    context = build_routing_context(trace)
    print("---TRACE_INPUT_JSON_START---")
    print(trace.model_dump_json(indent=2))
    print("---TRACE_INPUT_JSON_END---")
    print(f"WAS_TRUNCATED={context.was_truncated}")
    print(f"ACTUAL_INPUT_TOKENS={trace.actual_input_tokens}")
    print("---ROUTING_CONTEXT_START---")
    print(context.text)
    print("---ROUTING_CONTEXT_END---")


if __name__ == "__main__":
    main()
