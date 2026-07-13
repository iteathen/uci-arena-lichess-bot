#!/usr/bin/env python3
"""Smoke-test the UCI Arena engine command from the lichess-bot template."""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[2]
PLACEHOLDER = "<UCI_ARENA_REPO>"


def _replace_repo_placeholder(value: Any, repo_root: Path) -> Any:
    if isinstance(value, str):
        return value.replace(PLACEHOLDER, repo_root.as_posix())
    if isinstance(value, dict):
        return {key: _replace_repo_placeholder(item, repo_root) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_repo_placeholder(item, repo_root) for item in value]
    return value


def _resolve_path(value: str, base: Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = base / path
    return path


def _send(process: subprocess.Popen[str], line: str) -> None:
    assert process.stdin is not None
    process.stdin.write(line + "\n")
    process.stdin.flush()


def _read_until(process: subprocess.Popen[str], target: str, timeout_s: float) -> list[str]:
    assert process.stdout is not None
    deadline = time.monotonic() + timeout_s
    lines: list[str] = []
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if line == "":
            if process.poll() is not None:
                raise RuntimeError(f"engine exited before {target!r}; output={lines!r}")
            time.sleep(0.01)
            continue
        text = line.rstrip("\r\n")
        lines.append(text)
        if text == target or text.startswith(target + " "):
            return lines
    raise TimeoutError(f"timed out waiting for {target!r}; output={lines!r}")


def _uci_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _load_config(path: Path, repo_root: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return _replace_repo_placeholder(data, repo_root)


def smoke(config_path: Path, repo_root: Path, depth: int, timeout_s: float) -> dict[str, Any]:
    config = _load_config(config_path, repo_root)
    engine = config.get("engine")
    if not isinstance(engine, dict):
        raise ValueError("config is missing engine mapping")

    engine_dir = _resolve_path(str(engine.get("dir", "")), config_path.parent)
    engine_name = str(engine.get("name", ""))
    working_dir_value = str(engine.get("working_dir") or engine_dir)
    working_dir = _resolve_path(working_dir_value, config_path.parent)
    executable = engine_dir / engine_name
    if not executable.exists():
        raise FileNotFoundError(executable)
    if not working_dir.exists():
        raise FileNotFoundError(working_dir)

    process = subprocess.Popen(
        [str(executable)],
        cwd=str(working_dir),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    transcript: list[str] = []
    try:
        _send(process, "uci")
        uci_lines = _read_until(process, "uciok", timeout_s)
        transcript.extend(uci_lines)

        advertised_options = {
            line.split(" type ", 1)[0].removeprefix("option name ")
            for line in uci_lines
            if line.startswith("option name ") and " type " in line
        }
        uci_options = engine.get("uci_options") or {}
        if not isinstance(uci_options, dict):
            raise ValueError("engine.uci_options must be a mapping")
        unknown = sorted(set(uci_options) - advertised_options)
        if unknown:
            raise ValueError(f"template lists unadvertised UCI options: {unknown}")
        for name, value in uci_options.items():
            _send(process, f"setoption name {name} value {_uci_value(value)}")

        _send(process, "isready")
        transcript.extend(_read_until(process, "readyok", timeout_s))
        _send(process, "ucinewgame")
        _send(process, "position startpos")
        _send(process, f"go depth {depth}")
        bestmove_lines = _read_until(process, "bestmove", timeout_s)
        transcript.extend(bestmove_lines)
        bestmove = bestmove_lines[-1].split()[1] if len(bestmove_lines[-1].split()) >= 2 else ""
        if not bestmove or bestmove == "0000":
            raise RuntimeError(f"engine did not return a usable bestmove: {bestmove_lines[-1]!r}")
        return {
            "schema": "uci_arena_lichess_bridge_smoke_v1",
            "config": str(config_path),
            "engine": str(executable),
            "working_dir": str(working_dir),
            "depth": depth,
            "bestmove": bestmove,
            "advertised_option_count": len(advertised_options),
            "applied_uci_options": sorted(uci_options),
        }
    finally:
        if process.poll() is None:
            try:
                _send(process, "quit")
                process.wait(timeout=2.0)
            except Exception:
                process.kill()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=ROOT / "deploy" / "lichess" / "config.uci_arena.template.yml",
    )
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--depth", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args()

    result = smoke(args.config.resolve(), args.repo_root.resolve(), args.depth, args.timeout)
    for key, value in result.items():
        print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
