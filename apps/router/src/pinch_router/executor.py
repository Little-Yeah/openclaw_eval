from __future__ import annotations

import json
import time
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .schemas import ExecutionProfile, TraceInput


@dataclass(frozen=True)
class ModelExecution:
    execution_profile: str
    actual_model_name: str
    content: str
    reasoning_content: str | None
    provider_request_id: str | None
    latency_ms: int
    usage: dict[str, object]


def provider_messages(trace: TraceInput) -> list[dict[str, str]]:
    """Serialize the demo trace into the provider's simple text chat format."""
    messages: list[dict[str, str]] = []
    for message in trace.messages:
        if message.role == "developer":
            role = "system"
        elif message.role == "tool":
            role = "user"
        else:
            role = message.role
        messages.append({"role": role, "content": message.content})
    return messages


class MiniMaxExecutor:
    def __init__(self, profile_name: str, profile: ExecutionProfile) -> None:
        self.profile_name = profile_name
        self.profile = profile

    def execute(self, trace: TraceInput) -> ModelExecution:
        api_key = self.profile.api_key
        if not api_key:
            raise RuntimeError(f"Missing API key for execution profile {self.profile_name}")
        payload = {
            "model": self.profile.model_name,
            "messages": provider_messages(trace),
        }
        request = Request(
            self.profile.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urlopen(request, timeout=self.profile.timeout_seconds) as response:  # noqa: S310 - endpoint comes from local config
                body = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Model provider returned HTTP {error.code}: {detail}") from error
        except URLError as error:
            raise RuntimeError(f"Model provider request failed: {error.reason}") from error
        try:
            message = body["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as error:
            raise RuntimeError(f"Unexpected model provider response: {body}") from error
        return ModelExecution(
            execution_profile=self.profile_name,
            actual_model_name=str(body.get("model", self.profile.model_name)),
            content=str(message.get("content") or ""),
            reasoning_content=message.get("reasoning_content"),
            provider_request_id=body.get("id"),
            latency_ms=round((time.perf_counter() - started) * 1000),
            usage=body.get("usage") or {},
        )
