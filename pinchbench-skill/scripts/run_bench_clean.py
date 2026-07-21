#!/usr/bin/env python3
"""
run_bench_clean.py — PinchBench 清洁运行包装器

默认执行完整 PinchBench，并为每次运行创建独立归档：

  runs/<run-id>/
  ├── results/       # summary JSON 与每题 transcript
  ├── api_logs/      # 按 category/task_id 的原始模型 API 日志
  └── run.json       # 参数、开始/结束时间和退出码

执行流程:
  1. 创建本次运行目录
  2. 启动本地 API 日志代理 (logger-proxy.mjs)
  3. 运行 benchmark.py
  4. 无论成功/失败，都停止代理并写入运行元数据

benchmark.py 为专用 bench agent 配置 ``skills: []``，不会修改全局
OpenClaw 配置。
"""
import os
import sys
import time
import signal
import json
import argparse
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# ── 路径配置 ──────────────────────────────────────────────────────────────────
PROJECT_ROOT  = Path(__file__).resolve().parents[2]
NODE_BIN      = "/Users/garrick/.nvm/versions/node/v24.18.0/bin/node"
PROXY_MJS     = PROJECT_ROOT / "logger-proxy.mjs"
PROXY_PORT    = 18080
RUNS_ROOT     = PROJECT_ROOT / "runs"


def start_proxy(env: dict[str, str]):
    """启动本地日志代理，返回进程对象。"""
    if not PROXY_MJS.exists():
        print(f"[CleanRunner] 警告: 代理文件不存在: {PROXY_MJS}")
        return None

    proc = subprocess.Popen(
        [NODE_BIN, str(PROXY_MJS)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, env=env,
    )
    # 等待代理启动
    time.sleep(2)
    if proc.poll() is not None:
        out, _ = proc.communicate()
        print(f"[CleanRunner] 警告: 代理进程提前退出: {out[:500]}")
        return None
    print(f"[CleanRunner] 日志代理已启动 (PID {proc.pid}) → http://127.0.0.1:{PROXY_PORT}")
    return proc


def stop_proxy(proc):
    """停止本地日志代理进程。"""
    if proc is None:
        return
    try:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)
        print(f"[CleanRunner] 日志代理已停止 (PID {proc.pid})")
    except Exception as e:
        print(f"[CleanRunner] 停止代理时出错: {e}")
        proc.kill()


def _slug(value: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in value.lower()).strip("-")


def _parse_args() -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(
        description="Run PinchBench and archive a complete, clean evaluation run."
    )
    parser.add_argument("--model", required=True, help="Model passed to benchmark.py")
    parser.add_argument(
        "--runs-root", type=Path, default=RUNS_ROOT,
        help=f"Archive root (default: {RUNS_ROOT})",
    )
    parser.add_argument(
        "--run-id", default=None,
        help="Archive directory name; default is a local timestamp (YYYYMMDD-HHMMSS)",
    )
    parser.add_argument(
        "--allow-upload", action="store_true",
        help="Allow benchmark.py to upload results; local-only is the default",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Create the archive and print the command without running it",
    )
    return parser.parse_known_args()


def _write_metadata(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    args, benchmark_args = _parse_args()
    if "--output-dir" in benchmark_args:
        raise SystemExit(
            "--output-dir is managed by this runner; use --runs-root or --run-id instead"
        )
    started_at = datetime.now(timezone.utc)
    run_id = args.run_id or started_at.astimezone().strftime("%Y%m%d-%H%M%S")
    if Path(run_id).name != run_id:
        raise SystemExit("--run-id must be a directory name, not a path")

    archive_dir = args.runs_root / run_id
    if archive_dir.exists():
        raise SystemExit(f"Archive already exists: {archive_dir}; pass a different --run-id")
    results_dir = archive_dir / "results"
    api_logs_dir = archive_dir / "api_logs"
    results_dir.mkdir(parents=True)
    api_logs_dir.mkdir()

    benchmark_script = Path(__file__).parent / "benchmark.py"
    env = dict(os.environ)
    env["PATH"] = f"/Users/garrick/.nvm/versions/node/v24.18.0/bin:{env.get('PATH', '')}"
    env.pop("OPENCLAW_CONFIG_PATH", None)
    env["PINCHBENCH_API_LOG_DIR"] = str(api_logs_dir.resolve())
    command = ["/usr/local/bin/uv", "run", str(benchmark_script), "--model", args.model,
               "--output-dir", str(results_dir), *benchmark_args]
    if not args.allow_upload and "--no-upload" not in command:
        command.append("--no-upload")

    metadata_path = archive_dir / "run.json"
    metadata = {
        "run_id": run_id,
        "started_at_utc": started_at.isoformat(),
        "model": args.model,
        "archive_dir": str(archive_dir.resolve()),
        "command": command,
        "status": "running",
    }
    _write_metadata(metadata_path, metadata)
    print(f"[CleanRunner] Archive: {archive_dir}")
    print(f"[CleanRunner] Results: {results_dir}")
    print(f"[CleanRunner] API logs: {api_logs_dir}")
    print(f"[CleanRunner] Command: {' '.join(command)}")

    if args.dry_run:
        metadata.update(status="dry-run", finished_at_utc=datetime.now(timezone.utc).isoformat())
        _write_metadata(metadata_path, metadata)
        return 0

    proxy_proc = start_proxy(env)
    exit_code = 1

    try:
        # 3. 执行基准测试
        print("[CleanRunner] 启动 benchmark...\n")
        exit_code = subprocess.run(command, env=env, check=False).returncode

    finally:
        # 4. 停止代理并记录最终状态
        stop_proxy(proxy_proc)
        metadata.update(
            status="success" if exit_code == 0 else "failed",
            exit_code=exit_code,
            finished_at_utc=datetime.now(timezone.utc).isoformat(),
        )
        _write_metadata(metadata_path, metadata)

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
