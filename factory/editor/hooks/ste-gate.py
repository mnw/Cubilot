#!/usr/bin/env python3
"""PreToolUse hook for the factory Editor.

Blocks `send_handoff` to the reviewer while the handed-off doc has ASD-STE100
hard violations. Claude Code passes the tool call as JSON on stdin. Exit 0 lets
the call through. Exit 2 blocks it, and Claude Code gives stderr to the agent.

Environment:
  CLAUDE_PLUGIN_ROOT  staged editor plugin folder (set by Claude Code)
  FACTORY_REVIEWER    reviewer agent name (default: reviewer)
"""
import json
import os
import subprocess
import sys
from pathlib import Path


def block(msg: str) -> None:
    print(f"[ste-gate] Handoff to the reviewer blocked.\n{msg}", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)  # Not our input. Do not block on a hook fault.

    tool_input = event.get("tool_input") or {}
    reviewer = os.environ.get("FACTORY_REVIEWER", "reviewer")
    if str(tool_input.get("to", "")).strip() != reviewer:
        sys.exit(0)

    context = tool_input.get("context") or {}
    if isinstance(context, str):
        try:
            context = json.loads(context)
        except json.JSONDecodeError:
            context = {}
    path = context.get("path") if isinstance(context, dict) else None
    if not path:
        block("Set context.path to the doc you edited.")

    doc = Path(path)
    if not doc.is_absolute():
        doc = Path(event.get("cwd") or os.getcwd()) / doc
    if not doc.is_file():
        block(f"File not found: {doc}")

    root = Path(os.environ.get("CLAUDE_PLUGIN_ROOT") or Path(__file__).resolve().parent.parent)
    linter = root / "skills" / "asd-ste100" / "scripts" / "ste-lint.py"
    if not linter.is_file():
        block(f"Linter not found: {linter}. Stage the asd-ste100 skill with the editor role.")

    result = subprocess.run(
        [sys.executable, str(linter), str(doc)],
        capture_output=True, text=True, timeout=55,
    )
    if result.returncode == 0:
        sys.exit(0)
    if result.returncode == 1:
        block(
            f"ASD-STE100 hard violations in {doc}. Fix them, then send the handoff again.\n"
            "If a rule break is on purpose, keep it and list it in change_summary.\n\n"
            + result.stdout.strip()
        )
    block(f"The linter failed (exit {result.returncode}).\n{result.stderr.strip()}")


if __name__ == "__main__":
    main()
