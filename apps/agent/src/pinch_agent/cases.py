from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class PinchCase:
    case_id: str
    prompt: str
    workspace_files: list[Any]


def load_case(skill_dir: Path, case_id: str) -> PinchCase:
    path = skill_dir / "tasks" / f"{case_id}.md"
    if not path.exists():
        raise FileNotFoundError(f"PinchBench case not found: {path}")
    _, frontmatter, body = path.read_text(encoding="utf-8").split("---", 2)
    metadata = yaml.safe_load(frontmatter)
    prompt = body.split("## Prompt", 1)[1].split("## Expected Behavior", 1)[0].strip()
    return PinchCase(metadata["id"], prompt, metadata.get("workspace_files", []))


def prepare_workspace(skill_dir: Path, case: PinchCase, workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    for spec in case.workspace_files:
        if isinstance(spec, str):
            source_rel = spec
            dest_rel = spec
            content = None
        elif isinstance(spec, dict):
            content = spec.get("content")
            source_rel = spec.get("source") or spec.get("path") or spec.get("dest")
            dest_rel = spec.get("dest") or spec.get("path") or spec.get("source")
        else:
            raise ValueError(f"unsupported workspace_files entry for {case.case_id}: {spec!r}")

        if not dest_rel:
            raise ValueError(f"workspace_files entry missing destination for {case.case_id}: {spec!r}")

        destination = workspace / str(dest_rel)
        destination.parent.mkdir(parents=True, exist_ok=True)

        if content is not None:
            destination.write_text(str(content), encoding="utf-8")
            continue

        if not source_rel:
            raise ValueError(f"workspace_files entry missing source for {case.case_id}: {spec!r}")

        source = skill_dir / "assets" / str(source_rel)
        if not source.exists():
            raise FileNotFoundError(f"workspace asset not found for {case.case_id}: {source}")

        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(source, destination)
