from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class CreateRunRequest(BaseModel):
    case_id: str
    mode: Literal["router", "model"] = "router"
    selected_model: str | None = None
    candidate_labels: list[str] | None = None
    preference: int = Field(default=2, ge=1, le=6)
    max_steps: int = Field(default=8, ge=1, le=20)


class RunCreated(BaseModel):
    run_id: str
    status: str
    events_url: str
