#!/bin/bash
# Claude Code status line command of a factory session. Claude Code sends the status line JSON on stdin.
# Keep it at <app data>/context/$CHATBRIDGE_AGENT.json (mode 0600, tmpfile + rename); the hub reads it for the roster.
# Print one short line.
set -u
input=$(cat)
agent="${CHATBRIDGE_AGENT:-}"
dir="${CUBILOT_DATA_DIR:-$HOME/Library/Application Support/Cubilot}/context"
case "$agent" in
  ''|.*|*/*|*\\*) ;;
  *)
    if mkdir -p "$dir" 2>/dev/null; then
      tmp="$dir/.$agent.json.tmp-$$"
      if (umask 077; printf '%s' "$input" > "$tmp") 2>/dev/null; then
        chmod 600 "$tmp" 2>/dev/null
        mv -f "$tmp" "$dir/$agent.json" 2>/dev/null || rm -f "$tmp"
      else
        rm -f "$tmp"
      fi
    fi
    ;;
esac
printf '%s\n' "${agent:-cubilot}"
