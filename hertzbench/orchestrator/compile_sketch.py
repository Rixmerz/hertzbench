#!/usr/bin/env python3
"""Compile an Arduino sketch directory for the classic ESP32 with Velxio's own
pipeline and print the firmware as JSON on stdout.

Usage: compile_sketch.py <sketch_dir> [--fqbn esp32:esp32:esp32]

stdout: {"firmware_b64": "<base64 of the flash image>"}
stderr: compiler diagnostics. Exit status 1 when the build fails.

It picks a compiler the way Velxio's compile route does
(backend/app/api/routes/compile.py): Velxio's ESP-IDF pipeline
(`espidf_compiler.compile`, the entry point test/backend/integration/
test_esp32_examples_qemu.py uses) when the toolchain is set up, else
arduino-cli with the esp32:esp32 core (`ArduinoCLIService.compile`, which forces
DIO flash and merges the 4 MB image). So a sketch built here is the sketch
Velxio would build on the same host. It needs the Velxio backend requirements
and one of the two toolchains.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
from collections.abc import Iterator
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


@contextlib.contextmanager
def stdout_to_stderr() -> Iterator[None]:
    """Send everything written to stdout, by Python or a child process, to stderr.

    Velxio's compilers print their progress, and the arduino-cli processes they
    start inherit file descriptor 1; stdout must carry only the JSON.
    """
    sys.stdout.flush()
    saved = os.dup(1)
    os.dup2(2, 1)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        os.dup2(saved, 1)
        os.close(saved)


async def compile_files(files: list[dict[str, str]], fqbn: str) -> str:
    sys.path.insert(0, str(_BACKEND_DIR))
    try:
        from app.services.arduino_cli import ArduinoCLIService
        from app.services.espidf_compiler import espidf_compiler
    except ImportError as exc:
        raise SystemExit(
            f"cannot import the Velxio compiler ({exc}); "
            f"install {_BACKEND_DIR / 'requirements.txt'} first"
        ) from exc

    with stdout_to_stderr():
        if espidf_compiler.available:
            result = await espidf_compiler.compile(files, fqbn)
        else:
            arduino_cli = ArduinoCLIService()
            core = await arduino_cli.ensure_core_for_board(fqbn)
            if core.get("needed") and not core.get("installed"):
                raise SystemExit(
                    f"ESP-IDF is not set up and arduino-cli could not install "
                    f"{core.get('core_id')}:\n{core.get('log', '')}"
                )
            result = await arduino_cli.compile(files, fqbn)
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
