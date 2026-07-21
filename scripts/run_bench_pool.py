#!/usr/bin/env python3
"""Run PinchBench task shards with isolated OpenClaw agents/workspaces."""
from __future__ import annotations
import argparse, json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "pinchbench-skill" / "scripts" / "benchmark.py"

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True); p.add_argument("--run-id", required=True)
    p.add_argument("--workers", type=int, default=3); p.add_argument("--resume", action="store_true"); p.add_argument("--config", type=Path)
    p.add_argument("--trace-only", action="store_true"); p.add_argument("--suite", default="all")
    args = p.parse_args()
    if args.workers < 1: raise SystemExit("--workers must be >= 1")
    tasks = [x.stem for x in sorted((ROOT / "pinchbench-skill" / "tasks").glob("task_*.md"))]
    if args.suite != "all": tasks = [x.strip() for x in args.suite.split(",") if x.strip()]
    shards = [tasks[i::args.workers] for i in range(args.workers)]
    archive = ROOT / "runs" / args.run_id; collect = archive / "collect"; metadata = archive / "metadata"; collect.mkdir(parents=True, exist_ok=True); metadata.mkdir(parents=True, exist_ok=True)
    run_meta = {"run_id": args.run_id, "status": "running", "collect": {"model": args.model, "workers": args.workers, "suite": args.suite, "trace_only": args.trace_only}}
    (metadata / "run.json").write_text(json.dumps(run_meta, indent=2))
    env = dict(os.environ); env["PATH"] = f"/Users/garrick/.nvm/versions/node/v24.18.0/bin:{env.get('PATH','')}"; env["PINCHBENCH_API_LOG_DIR"] = str((collect / "traces").resolve())
    if args.config: env["PINCHBENCH_CONFIG"] = str(args.config.resolve())
    proxy = subprocess.Popen(["/Users/garrick/.nvm/versions/node/v24.18.0/bin/node", str(ROOT / "logger-proxy.mjs")], env=env)
    processes=[]
    try:
        for worker, shard in enumerate(shards):
            if not shard: continue
            out = collect / "results" / f"worker-{worker}"; out.mkdir(parents=True, exist_ok=True)
            cmd=["/usr/local/bin/uv","run",str(BENCH),"--model",args.model,"--suite",",".join(shard),"--output-dir",str(out),"--worker-id",str(worker),"--benchmark-run-id",f"{args.run_id}-w{worker}","--no-upload","--no-parallel-judge"]
            if args.trace_only: cmd.append("--trace-only")
            if args.resume: cmd.append("--resume")
            print(f"worker-{worker}: {len(shard)} tasks")
            processes.append(subprocess.Popen(cmd, env=env))
        codes=[proc.wait() for proc in processes]
        (collect / "pool.json").write_text(json.dumps({"run_id":args.run_id,"workers":args.workers,"exit_codes":codes},indent=2))
        run_meta["status"] = "success" if all(code == 0 for code in codes) else "failed"; run_meta["collect"]["exit_codes"] = codes
        (metadata / "run.json").write_text(json.dumps(run_meta, indent=2))
        return 0 if all(code == 0 for code in codes) else 1
    finally:
        proxy.terminate(); proxy.wait(timeout=10)
if __name__ == "__main__": raise SystemExit(main())
