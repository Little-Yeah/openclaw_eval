#!/usr/bin/env python3
"""Project-level entry point for the PinchBench clean benchmark runner.

The benchmark implementation lives in the vendored ``pinchbench-skill``
repository, but project scripts and all run artifacts belong to this repository.
"""

from pathlib import Path
import runpy
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TARGET = PROJECT_ROOT / "pinchbench-skill" / "scripts" / "run_bench_clean.py"

if not TARGET.is_file():
    raise SystemExit(f"PinchBench runner not found: {TARGET}")

sys.argv[0] = str(TARGET)
if "--runs-root" not in sys.argv:
    sys.argv.extend(["--runs-root", str(PROJECT_ROOT / "runs")])
runpy.run_path(str(TARGET), run_name="__main__")
