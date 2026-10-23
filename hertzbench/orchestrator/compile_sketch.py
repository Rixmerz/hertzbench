#!/usr/bin/env python3
"""Compile an Arduino sketch directory for the classic ESP32 with Velxio's own
ESP-IDF pipeline and print the firmware as JSON on stdout.

Usage: compile_sketch.py <sketch_dir> [--fqbn esp32:esp32:esp32]

stdout: {"firmware_b64": "<base64 of the flash image>"}
stderr: compiler diagnostics. Exit status 1 when the build fails.

This calls the same entry point the Velxio backend tests use
(`espidf_compiler.compile`, see test/backend/integration/
test_esp32_examples_qemu.py), so a sketch built here is the sketch Velxio would
build. It needs the Velxio backend requirements and the ESP-IDF toolchain.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
_SOURCE_SUFFIXES = {".ino", ".h", ".hpp", ".c", ".cpp"}


def read_sketch(sketch_dir: Path) -> list[dict[str, str]]:
    if not sketch_dir.is_dir():
        raise SystemExit(f"sketch directory not found: {sketch_dir}")
    files = [
        {"name": path.name, "content": path.read_text(encoding="utf-8")}
        for path in sorted(sketch_dir.iterdir())
        if path.is_file() and path.suffix in _SOURCE_SUFFIXES
    ]
    if not any(f["name"].endswith(".ino") for f in files):
        raise SystemExit(f"no .ino file in {sketch_dir}")
    return files


async def compile_files(files: list[dict[str, str]], fqbn: str) -> str:
    sys.path.insert(0, str(_BACKEND_DIR))
    from app.services.espidf_compiler import espidf_compiler

    result = await espidf_compiler.compile(files, fqbn)
    if not result.get("success"):
        stderr_tail = (result.get("stderr") or "")[-2000:]
        raise SystemExit(f"compile failed for {fqbn}: {result.get('error')}\n{stderr_tail}")
    binary = result.get("binary_content")
    if not binary:
        raise SystemExit(f"compile reported success but returned no binary: {result}")
    return str(binary)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("sketch_dir", type=Path)
    parser.add_argument("--fqbn", default="esp32:esp32:esp32")
    args = parser.parse_args()
    firmware_b64 = asyncio.run(compile_files(read_sketch(args.sketch_dir), args.fqbn))
    json.dump({"firmware_b64": firmware_b64}, sys.stdout)


if __name__ == "__main__":
    main()
