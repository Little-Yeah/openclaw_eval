from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pinch_agent.cases import load_case
from pinch_router.engine import CheckpointRouter

from .models import CreateRunRequest, RunCreated
from .service import RunService


ROOT = Path(__file__).resolve().parents[4]


@asynccontextmanager
async def lifespan(app: FastAPI):
    router = CheckpointRouter(ROOT / "apps" / "router" / "var" / "assets", ROOT / "apps" / "router" / "config" / "models.json")
    app.state.runs = RunService(ROOT, router)
    yield


app = FastAPI(title="Pinch Routed Agent API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])


def runs(request: Request) -> RunService:
    return request.app.state.runs


@app.get("/")
async def index() -> dict[str, str]:
    return {
        "service": "Pinch Routed Agent API",
        "health": "/api/health",
        "cases": "/api/cases",
        "frontend": "http://127.0.0.1:5173",
    }


from .service import RunService, DEFAULT_CANDIDATE_LABELS


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/models")
async def list_models(request: Request) -> dict[str, object]:
    router = runs(request).router
    items = []
    for label in DEFAULT_CANDIDATE_LABELS:
        if label in router.models:
            cfg = router.models[label]
            profile = router.config.execution_profiles.get(cfg.execution_profile)
            items.append({
                "label": cfg.label,
                "input_price_per_million": cfg.input_price_per_million,
                "output_price_per_million": cfg.output_price_per_million,
                "latency_seconds": cfg.latency_seconds,
                "execution_profile": cfg.execution_profile,
                "model_name": profile.model_name if profile else cfg.label,
            })
    return {"items": items, "default_candidates": DEFAULT_CANDIDATE_LABELS}


@app.get("/api/cases")
async def list_cases() -> dict[str, object]:
    items = []
    for path in sorted((ROOT / "pinchbench-skill" / "tasks").glob("task_*.md")):
        _, frontmatter, _ = path.read_text(encoding="utf-8").split("---", 2)
        metadata = yaml.safe_load(frontmatter)
        items.append({key: metadata.get(key) for key in ("id", "name", "category", "grading_type", "timeout_seconds")})
    return {"items": items, "total": len(items)}


@app.get("/api/cases/{case_id}")
async def get_case(case_id: str) -> dict[str, object]:
    try:
        case = load_case(ROOT / "pinchbench-skill", case_id)
    except (FileNotFoundError, IndexError, KeyError) as error:
        raise HTTPException(404, f"unknown case: {case_id}") from error
    return {"id": case.case_id, "prompt": case.prompt, "workspace_files": case.workspace_files}


@app.post("/api/runs", response_model=RunCreated, status_code=202)
async def create_run(payload: CreateRunRequest, request: Request) -> dict[str, str]:
    try:
        record = await runs(request).create(payload)
    except FileNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    return {"run_id": record["run_id"], "status": record["status"], "events_url": f"/api/runs/{record['run_id']}/events"}


@app.get("/api/runs")
async def list_runs(request: Request) -> dict[str, object]:
    return {"items": runs(request).list_runs()}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> dict[str, object]:
    try:
        return runs(request).get(run_id)
    except KeyError as error:
        raise HTTPException(404, "unknown run") from error


@app.delete("/api/runs/{run_id}", status_code=204)
async def delete_run(run_id: str, request: Request) -> None:
    try:
        runs(request).delete(run_id)
    except KeyError as error:
        raise HTTPException(404, "unknown run") from error
    except RuntimeError as error:
        raise HTTPException(409, str(error)) from error


@app.get("/api/runs/{run_id}/events/history")
async def history(run_id: str, request: Request) -> dict[str, object]:
    try:
        return {"items": runs(request).history(run_id)}
    except KeyError as error:
        raise HTTPException(404, "unknown run") from error


@app.get("/api/runs/{run_id}/events")
async def events(run_id: str, request: Request) -> StreamingResponse:
    service = runs(request)
    try:
        queue = service.subscribe(run_id)
        initial = service.history(run_id)
    except KeyError as error:
        raise HTTPException(404, "unknown run") from error

    async def stream() -> AsyncIterator[str]:
        last_sequence = 0
        try:
            for event in initial:
                last_sequence = max(last_sequence, event["sequence"])
                yield f"event: {event['event']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["event"] in {"run_completed", "run_failed"}:
                    return
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event["sequence"] > last_sequence:
                    last_sequence = event["sequence"]
                    yield f"event: {event['event']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["event"] in {"run_completed", "run_failed"}:
                    break
        finally:
            service.unsubscribe(run_id, queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def main() -> None:
    import uvicorn

    # The demo is a small monorepo: changes to the Agent or Router must reload
    # the API process too, otherwise a running `make demo` would keep old code.
    uvicorn.run(
        "pinch_api.app:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        reload_dirs=[str(ROOT / "apps" / name / "src") for name in ("api", "agent", "router")],
    )
