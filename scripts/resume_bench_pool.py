#!/usr/bin/env python3
"""Resume a migrated legacy run by scheduling only tasks with no captured trace."""
from __future__ import annotations
import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def completed_tasks(run_dir: Path) -> set[str]:
    completed = set()
    for path in (run_dir / "collect" / "traces").rglob("task_*.jsonl"):
        if path.stat().st_size:
            completed.add(path.stem)
    return completed

def main() -> int:
    p = argparse.ArgumentParser(description="Resume a migrated run with the isolated worker pool")
    p.add_argument("--model", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--with-judge", action="store_true", help="Enable grading; trace-only is the default")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--config", type=Path)
    args = p.parse_args()
    run_dir = ROOT / "runs" / args.run_id
    if not run_dir.is_dir(): raise SystemExit(f"Run not found: {run_dir}")
    all_tasks = [path.stem for path in sorted((ROOT / "pinchbench-skill" / "tasks").glob("task_*.md"))]
    done = completed_tasks(run_dir)
    remaining = [task for task in all_tasks if task not in done]
    print(f"run={args.run_id}: completed={len(done)}, remaining={len(remaining)}, total={len(all_tasks)}")
    if not remaining: return 0
    command = [sys.executable, str(ROOT / "scripts" / "run_bench_pool.py"), "--model", args.model,
               "--run-id", args.run_id, "--workers", str(args.workers), "--suite", ",".join(remaining)]
    if args.config: command += ["--config", str(args.config.resolve())]
    if not args.with_judge: command.append("--trace-only")
    if args.dry_run:
        print(" ".join(command)); return 0
    return subprocess.run(command, cwd=ROOT).returncode

if __name__ == "__main__": raise SystemExit(main())
