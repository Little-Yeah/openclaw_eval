#!/usr/bin/env python3
"""Config-driven entry point for trace collection, inference, and evaluation."""
from __future__ import annotations
import argparse, json, os, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load_config(path: Path) -> dict:
    try: return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc: raise SystemExit(f"Invalid config {path}: {exc}")

def run(command: list[str], *, config_path: Path | None = None) -> int:
    print("+", " ".join(command))
    env = dict(os.environ)
    if config_path: env["PINCHBENCH_CONFIG"] = str(config_path.resolve())
    return subprocess.run(command, cwd=ROOT, env=env).returncode

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

def update_metadata(run_dir: Path, stage: str, status: str, command: list[str], exit_code: int | None = None) -> None:
    path = run_dir / "metadata" / "run.json"; path.parent.mkdir(parents=True, exist_ok=True)
    try: meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        identity = {"run_id": run_dir.name}
        if run_dir.parent.name == "experiments": identity = {"run_id": run_dir.parent.parent.name, "experiment_id": run_dir.name}
        meta = {**identity, "stages": {}}
    meta.setdefault("stages", {})
    entry = meta["stages"].setdefault(stage, {"started_at": now(), "command": command})
    entry["status"] = status
    if status == "running": entry["started_at"] = now(); entry["command"] = command; meta["status"] = "running"
    else:
        entry["finished_at"] = now(); entry["exit_code"] = exit_code
        if status == "failed": meta["status"] = "failed"
        elif status == "success" and stage == "dataset": meta["status"] = "ready"
        elif status == "success" and stage == "evaluate": meta["status"] = "success"
    path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

def run_stage(run_dir: Path, stage: str, command: list[str], *, config_path: Path | None = None) -> int:
    update_metadata(run_dir, stage, "running", command)
    code = run(command, config_path=config_path)
    update_metadata(run_dir, stage, "success" if code == 0 else "failed", command, code)
    return code

def main() -> int:
    p=argparse.ArgumentParser(description="Config-driven OpenClaw router data pipeline")
    p.add_argument("stage", choices=("collect", "scenarios", "inference", "evaluate"))
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--experiment-id", help="Required for inference/evaluate; isolates one model-pool and judge configuration")
    args=p.parse_args(); cfg=load_config(args.config); run_dir=ROOT/"runs"/args.run_id
    py=sys.executable
    if args.stage == "collect":
        oc=cfg.get("openclaw", {}); provider=oc.get("trace_provider", {}); model=provider.get("model")
        if not model: raise SystemExit("config.openclaw.trace_provider.model is required")
        cmd=[py,str(ROOT/"scripts"/("resume_bench_pool.py" if args.resume else "run_bench_pool.py")),"--model",model,"--run-id",args.run_id,"--workers",str(oc.get("workers",3)),"--config",str(args.config.resolve())]
        if oc.get("suite", "all") != "all": cmd += ["--suite", str(oc["suite"])]
        if oc.get("trace_only", True) and not args.resume: cmd.append("--trace-only")
        return run_stage(run_dir, "collect", cmd, config_path=args.config)
    scenarios=run_dir/"dataset"/"requests.jsonl"
    if args.stage == "scenarios":
        cmd=[py,str(ROOT/"scripts"/"build_scenarios.py"),"--trace-dir",str(run_dir/"collect"/"traces"),"--output",str(scenarios)]
        if args.limit: cmd += ["--limit",str(args.limit)]
        return run_stage(run_dir, "dataset", cmd)
    if not scenarios.exists(): raise SystemExit(f"Build scenarios first: {scenarios}")
    if not args.experiment_id: raise SystemExit("--experiment-id is required for inference and evaluate")
    experiment_dir=run_dir/"experiments"/args.experiment_id
    state_dir=experiment_dir/"_state"; config_dir=state_dir/"config"; config_dir.mkdir(parents=True,exist_ok=True)
    if args.stage == "inference":
        models={"models":cfg.get("inference",{}).get("models",[])}
        if not models["models"]: raise SystemExit("config.inference.models is required")
        models_path=config_dir/"candidate_models.json"; models_path.write_text(json.dumps(models,indent=2),encoding="utf-8")
        cmd=[py,str(ROOT/"scripts"/"inference.py"),"--scenarios",str(scenarios),"--models",str(models_path),"--output-dir",str(experiment_dir/"inference"),"--state-dir",str(state_dir/"inference")]
        if args.limit: cmd += ["--limit",str(args.limit)]
        return run_stage(experiment_dir, "inference", cmd)
    judge=cfg.get("evaluate",{}).get("judge")
    if not judge: raise SystemExit("config.evaluate.judge is required")
    judge_path=config_dir/"judge.json"; judge_path.write_text(json.dumps(judge,indent=2),encoding="utf-8")
    cmd=[py,str(ROOT/"scripts"/"evaluate.py"),"--scenarios",str(scenarios),"--predictions-dir",str(experiment_dir/"inference"),"--judge",str(judge_path),"--output-dir",str(experiment_dir/"evaluate"),"--state-dir",str(state_dir/"evaluate")]
    return run_stage(experiment_dir, "evaluate", cmd)

if __name__ == "__main__": raise SystemExit(main())
