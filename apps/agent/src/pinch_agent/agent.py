from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, Callable, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pinch_router.context import build_routing_context
from pinch_router.engine import CheckpointRouter
from pinch_router.schemas import TraceInput

from .tools import TOOL_SPEC, WorkspaceTools


class AgentState(TypedDict):
    messages: Annotated[list[dict[str, str]], add_messages]
    step: int
    action: dict[str, Any]
    events: list[dict[str, Any]]
    final_answer: str


def _action(content: str) -> dict[str, Any]:
    start = content.find("{")
    if start < 0:
        return {"type": "final", "answer": content}
    try:
        value, _ = json.JSONDecoder().raw_decode(content[start:])
        tool_names = {tool["name"] for tool in TOOL_SPEC}
        if value.get("type") == "tool" and value.get("name") in {tool["name"] for tool in TOOL_SPEC}:
            return value
        if value.get("type") in tool_names:
            return {"type": "tool", "name": value["type"], "arguments": value.get("arguments", {})}
        if value.get("type") == "final":
            return value
    except json.JSONDecodeError:
        pass
    return {"type": "final", "answer": content}


class RoutedAgent:
    def __init__(
        self,
        router: CheckpointRouter,
        workspace: Path,
        max_steps: int = 8,
        candidate_labels: list[str] | None = None,
        preference: int = 2,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        mode: str = "router",
        selected_model: str | None = None,
    ) -> None:
        self.router = router
        self.tools = WorkspaceTools(workspace)
        self.max_steps = max_steps
        self.candidate_labels = candidate_labels
        self.preference = preference
        self.on_event = on_event
        self.mode = mode
        self.selected_model = selected_model
        self.graph = self._build_graph()

    def _build_graph(self):
        graph = StateGraph(AgentState)
        graph.add_node("model", self._model)
        graph.add_node("tool", self._tool)
        graph.add_edge(START, "model")
        graph.add_conditional_edges("model", self._next, {"tool": "tool", "end": END})
        graph.add_edge("tool", "model")
        return graph.compile()

    @staticmethod
    def _trace_messages(messages: list[Any]) -> list[dict[str, str]]:
        role_map = {"human": "user", "ai": "assistant"}
        normalized: list[dict[str, str]] = []
        for message in messages:
            if isinstance(message, dict):
                role = message["role"]
                content = message["content"]
            else:
                role = role_map.get(message.type, message.type)
                content = message.content
            normalized.append({"role": role, "content": str(content)})
        return normalized

    def _model(self, state: AgentState) -> dict[str, Any]:
        messages = self._trace_messages(state["messages"])
        trace = TraceInput.model_validate(
            {
                "messages": messages,
                "tools": [{"name": item["name"], "description": str(item["arguments"])} for item in TOOL_SPEC],
                "agent_state": {"step": state["step"], "mode": "tool_or_final"},
                "actual_input_tokens": max(1, sum(len(message["content"]) for message in messages) // 4),
                "candidate_labels": self.candidate_labels,
                "preference": self.preference,
            }
        )
        route = self.router.route(trace, build_routing_context(trace))
        route_event = {
            "event": "router_decision",
            "step": state["step"],
            "routed_label": route.selected_label,
            "candidates": [candidate.__dict__ for candidate in route.candidates],
            "router_latency_ms": route.router_latency_ms,
        }
        if self.on_event is not None:
            profile_name = self.router.models[route.selected_label].execution_profile
            executed_model = self.router.config.execution_profiles[profile_name].model_name
            self.on_event(route_event)
            self.on_event({
                "event": "model_call_started",
                "step": state["step"],
                "routed_label": route.selected_label,
                "executed_model": executed_model,
            })
        execution = self.router.execute_selected(route, trace)
        action = _action(execution.content)
        model_cfg = self.router.models.get(route.selected_label)
        event = {
            "event": "model_response",
            "step": state["step"],
            "routed_label": route.selected_label,
            "candidates": [candidate.__dict__ for candidate in route.candidates],
            "router_latency_ms": route.router_latency_ms,
            "executed_model": execution.actual_model_name,
            "model_latency_ms": execution.latency_ms,
            "content": execution.content,
            "reasoning": execution.reasoning_content,
            "action": action,
            "usage": execution.usage,
            "input_price_per_million": model_cfg.input_price_per_million if model_cfg else 0.0,
            "output_price_per_million": model_cfg.output_price_per_million if model_cfg else 0.0,
        }
        if state["step"] >= self.max_steps:
            action = {"type": "final", "answer": "Stopped: agent reached maximum step count."}
        if self.on_event is not None:
            self.on_event(event)
        return {"messages": [{"role": "assistant", "content": execution.content}], "step": state["step"] + 1, "action": action, "events": state["events"] + [event]}

    def _tool(self, state: AgentState) -> dict[str, Any]:
        action = state["action"]
        try:
            result = self.tools.execute(action["name"], action.get("arguments", {}))
        except Exception as error:
            result = f"tool error: {error}"
        event = {"event": "tool_result", "step": state["step"], "tool": action["name"], "result": result}
        if self.on_event is not None:
            self.on_event(event)
        return {"messages": [{"role": "user", "content": f"Tool result for {action['name']}:\n{result}\nChoose the next JSON action."}], "events": state["events"] + [event]}

    def _next(self, state: AgentState) -> Literal["tool", "end"]:
        if state["action"].get("type") == "tool" and state["step"] < self.max_steps:
            return "tool"
        return "end"

    def run(self, prompt: str) -> dict[str, Any]:
        system = (
            "You are a PinchBench workspace agent. Complete the task using only the listed tools when needed. "
            "Respond with exactly one JSON object and no markdown: "
            'For example, to inspect files return exactly {"type":"tool","name":"list_files","arguments":{"path":"."}}. '
            'For a tool call use {"type":"tool","name":"read_file|list_files|write_file","arguments":{...}} '
            'or {"type":"final","answer":"..."}. Available tools: ' + json.dumps(TOOL_SPEC)
        )
        result = self.graph.invoke({"messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}], "step": 0, "action": {}, "events": [], "final_answer": ""})
        answer = result["action"].get("answer", "")
        return {"answer": answer, "events": result["events"]}
