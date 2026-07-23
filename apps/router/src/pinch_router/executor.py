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


class ProviderExecutor:
    """Execute a routed turn through a locally configured provider."""
    def __init__(self, profile_name: str, profile: ExecutionProfile) -> None:
        self.profile_name = profile_name
        self.profile = profile

    def execute(self, trace: TraceInput) -> ModelExecution:
        api_key = self.profile.api_key
        if not api_key:
            raise RuntimeError(f"Missing API key for execution profile {self.profile_name}")
        if self.profile.api_type == "anthropic":
            payload, headers = self._anthropic_request(trace, api_key)
        else:
            payload = {"model": self.profile.model_name, "messages": provider_messages(trace)}
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        request = Request(
            self._endpoint(),
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
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
        content, reasoning = self._response_content(body)
        return ModelExecution(
            execution_profile=self.profile_name,
            actual_model_name=str(body.get("model", self.profile.model_name)),
            content=content,
            reasoning_content=reasoning,
            provider_request_id=body.get("id"),
            latency_ms=round((time.perf_counter() - started) * 1000),
            usage=body.get("usage") or {},
        )

    def _endpoint(self) -> str:
        if self.profile.endpoint:
            return self.profile.endpoint
        if not self.profile.base_url:
            raise RuntimeError(f"Execution profile {self.profile_name} needs endpoint or base_url")
        suffix = "/messages" if self.profile.api_type == "anthropic" else "/chat/completions"
        return f"{self.profile.base_url.rstrip('/')}{suffix}"

    def _anthropic_request(self, trace: TraceInput, api_key: str) -> tuple[dict[str, object], dict[str, str]]:
        system: list[str] = []
        messages: list[dict[str, str]] = []
        for message in trace.messages:
            if message.role in {"system", "developer"}:
                system.append(message.content)
            else:
                role = "assistant" if message.role == "assistant" else "user"
                messages.append({"role": role, "content": message.content})
        payload: dict[str, object] = {
            "model": self.profile.model_name,
            "max_tokens": 4096,
            "messages": messages,
        }
        if system:
            payload["system"] = "\n\n".join(system)
        return payload, {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

    def _response_content(self, body: dict[str, object]) -> tuple[str, str | None]:
        if self.profile.api_type == "anthropic":
            blocks = body.get("content") or []
            if not isinstance(blocks, list):
                raise RuntimeError(f"Unexpected Anthropic-compatible response: {body}")
            content = "".join(str(block.get("text", "")) for block in blocks if isinstance(block, dict) and block.get("type") == "text")
            reasoning = "".join(str(block.get("thinking", "")) for block in blocks if isinstance(block, dict) and block.get("type") == "thinking") or None
            return content, reasoning
        try:
            message = body["choices"][0]["message"]  # type: ignore[index]
        except (KeyError, IndexError, TypeError) as error:
            raise RuntimeError(f"Unexpected OpenAI-compatible response: {body}") from error
        if not isinstance(message, dict):
            raise RuntimeError(f"Unexpected OpenAI-compatible response: {body}")
        return str(message.get("content") or ""), message.get("reasoning_content") if isinstance(message.get("reasoning_content"), str) else None
