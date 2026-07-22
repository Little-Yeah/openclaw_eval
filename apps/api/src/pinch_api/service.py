from __future__ import annotations

import asyncio
import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pinch_agent.agent import RoutedAgent
from pinch_agent.cases import load_case, prepare_workspace
from pinch_router.engine import CheckpointRouter

from .models import CreateRunRequest

DEFAULT_CANDIDATE_LABELS = ["deepseek-v4-flash", "deepseek-v4-pro"]


class RunService:
    def __init__(self, root: Path, router: CheckpointRouter) -> None:
        self.root = root
        self.router = router
        self.runs_dir = root / "apps" / "api" / "var" / "runs"
        self.skill_dir = root / "pinchbench-skill"
        self.queues: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        self.lock = threading.Lock()
        self.sequence: dict[str, int] = {}

    def _run_dir(self, run_id: str) -> Path:
        path = (self.runs_dir / run_id).resolve()
        if path.parent != self.runs_dir.resolve():
            raise KeyError(run_id)
        return path

    def _metadata_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "run.json"

    def _load_metadata(self, run_id: str) -> dict[str, Any]:
        path = self._metadata_path(run_id)
        if not path.exists():
            raise KeyError(run_id)
        return json.loads(path.read_text())

    def _save_metadata(self, run_id: str, payload: dict[str, Any]) -> None:
        self._metadata_path(run_id).write_text(json.dumps(payload, ensure_ascii=False, indent=2))

    async def create(self, request: CreateRunRequest) -> dict[str, Any]:
        case = load_case(self.skill_dir, request.case_id)
        run_id = f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        run_dir = self._run_dir(run_id)
        workspace = run_dir / "workspace"
        run_dir.mkdir(parents=True)
        prepare_workspace(self.skill_dir, case, workspace)
        metadata = {
            "run_id": run_id,
            "case_id": case.case_id,
            "status": "queued",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "workspace": str(workspace),
            "request": request.model_dump(),
        }
        self._save_metadata(run_id, metadata)
        self.sequence[run_id] = 0
        self.queues[run_id] = set()
        asyncio.create_task(self._execute(run_id, case.prompt, workspace, request))
        return metadata

    async def _execute(self, run_id: str, prompt: str, workspace: Path, request: CreateRunRequest) -> None:
        self._update_status(run_id, "running")
        self.publish(run_id, {"event": "run_started", "case_id": request.case_id})
        loop = asyncio.get_running_loop()

        def on_event(event: dict[str, Any]) -> None:
            # The Agent runs in a worker thread. Wait for each event to be
            # committed on the event loop before it takes another step so SSE
            # preserves model → tool → model ordering.
            asyncio.run_coroutine_threadsafe(self._publish_async(run_id, event), loop).result()

        try:
            agent = RoutedAgent(
                self.router,
                workspace,
                max_steps=request.max_steps,
                candidate_labels=request.candidate_labels or DEFAULT_CANDIDATE_LABELS,
                preference=request.preference,
                on_event=on_event,
            )
            result = await asyncio.to_thread(agent.run, prompt)
            self._update_status(run_id, "completed", final_answer=result["answer"], summary=self._summary(run_id))
            self.publish(run_id, {"event": "run_completed", "final_answer": result["answer"]})
        except Exception as error:
            self._update_status(run_id, "failed", error=str(error), summary=self._summary(run_id))
            self.publish(run_id, {"event": "run_failed", "error": str(error)})

    async def _publish_async(self, run_id: str, event: dict[str, Any]) -> None:
        self.publish(run_id, event)

    def _update_status(self, run_id: str, status: str, **extra: Any) -> None:
        with self.lock:
            metadata = self._load_metadata(run_id)
            metadata["status"] = status
            metadata.update(extra)
            if status in {"completed", "failed"}:
                metadata["completed_at"] = datetime.now(timezone.utc).isoformat()
            self._save_metadata(run_id, metadata)

    def publish(self, run_id: str, event: dict[str, Any]) -> None:
        with self.lock:
            sequence = self.sequence.get(run_id, 0) + 1
            self.sequence[run_id] = sequence
            payload = {"run_id": run_id, "sequence": sequence, "timestamp": datetime.now(timezone.utc).isoformat(), **event}
            with (self._run_dir(run_id) / "events.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
            queues = list(self.queues.get(run_id, set()))
        for queue in queues:
            queue.put_nowait(payload)

    def get(self, run_id: str) -> dict[str, Any]:
        return self._load_metadata(run_id)

    def list_runs(self) -> list[dict[str, Any]]:
        records = []
        for path in self.runs_dir.glob("*/run.json"):
            try:
                records.append(json.loads(path.read_text()))
            except json.JSONDecodeError:
                continue
        return sorted(records, key=lambda item: item.get("created_at", ""), reverse=True)

    def delete(self, run_id: str) -> None:
        """Remove one completed demo run, including its disposable workspace."""
        with self.lock:
            metadata = self._load_metadata(run_id)
            if metadata.get("status") in {"queued", "running"}:
                raise RuntimeError("a running test cannot be deleted")
            shutil.rmtree(self._run_dir(run_id))
            self.queues.pop(run_id, None)
            self.sequence.pop(run_id, None)

    def history(self, run_id: str) -> list[dict[str, Any]]:
        self._load_metadata(run_id)
        path = self._run_dir(run_id) / "events.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def _summary(self, run_id: str) -> dict[str, Any]:
        events = self.history(run_id)
        models: list[str] = []
        tools: list[str] = []
        estimated_cost = 0.0
        steps = 0
        for event in events:
            if event.get("event") == "router_decision":
                steps += 1
                model = event.get("routed_label")
                if model and model not in models:
                    models.append(model)
                for candidate in event.get("candidates", []):
                    if candidate.get("label") == model:
                        estimated_cost += float(candidate.get("predicted_cost", 0.0))
                        break
            if event.get("event") == "tool_result" and event.get("tool") not in tools:
                tools.append(event["tool"])
        return {"steps": steps, "router_estimated_cost": estimated_cost, "routed_models": models, "tools": tools}

    def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        self._load_metadata(run_id)
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.queues.setdefault(run_id, set()).add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self.queues.get(run_id, set()).discard(queue)
