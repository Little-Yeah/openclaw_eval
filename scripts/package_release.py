#!/usr/bin/env python3
"""Build a redistributable zip without local credentials or experiment outputs."""
from __future__ import annotations

import argparse
import fnmatch
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXCLUDES = (
    ".git/**", "**/.git/**", "**/__pycache__/**", "**/.DS_Store",
    ".venv/**", ".pytest_cache/**", "*.pyc", "api_logs/**",
    "config/eval.json", "config/*.local.json", "dist/**",
)


def selected(path: Path, run_id: str, extra: tuple[str, ...]) -> bool:
    relative = path.relative_to(ROOT).as_posix()
    if relative.startswith("config/") and ".example." not in path.name:
        return False
    if relative == "runs" or relative.startswith("runs/"):
        allowed = (f"runs/{run_id}/collect/", f"runs/{run_id}/dataset/", f"runs/{run_id}/metadata/")
        if not any(relative.startswith(prefix) for prefix in allowed):
            return False
    return not any(fnmatch.fnmatch(relative, pattern) for pattern in (*DEFAULT_EXCLUDES, *extra))


def main() -> int:
    parser = argparse.ArgumentParser(description="Package source plus one immutable trace dataset")
    parser.add_argument("--run-id", default="full-v1", help="Core dataset run to include (default: full-v1)")
    parser.add_argument("--output", type=Path, help="Zip output path")
    parser.add_argument("--exclude", action="append", default=[], help="Additional repo-relative glob to exclude")
    parser.add_argument("--dry-run", action="store_true", help="Print included file count/size without creating a zip")
    args = parser.parse_args()
    run_root = ROOT / "runs" / args.run_id
    for required in (run_root / "collect", run_root / "dataset" / "requests.jsonl"):
        if not required.exists():
            raise SystemExit(f"Core dataset is incomplete: missing {required}")
    output = args.output or ROOT / "dist" / f"openclaw-eval-{args.run_id}.zip"
    output = output.resolve()
    files = [path for path in ROOT.rglob("*") if path.is_file() and selected(path, args.run_id, tuple(args.exclude)) and path.resolve() != output]
    total = sum(path.stat().st_size for path in files)
    print(f"Including {len(files)} files ({total / 1024 / 1024:.1f} MiB) from run {args.run_id}")
    print("Excluded: non-example config, local logs, experiments, other runs, .git, caches, and dist")
    if args.dry_run:
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    prefix = f"openclaw-eval-{args.run_id}"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in files:
            archive.write(path, f"{prefix}/{path.relative_to(ROOT).as_posix()}")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
