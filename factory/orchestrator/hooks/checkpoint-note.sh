#!/bin/bash
# The lead runs this after the hub asks for a checkpoint note: checkpoint-note.sh --file <path> (the lead wrote the note there).
# Also: checkpoint-note.sh "<note>" or the note on stdin. The file is removed after it is read.
# POST /agents/<name>/checkpoint-note. The hub keeps the first 200 words. Prints the hub answer.
. "$(dirname "$0")/checkpoint-lib.sh"
agent_ok || { echo "checkpoint-note: CHATBRIDGE_AGENT is not set" >&2; exit 1; }
if [ "${1:-}" = "--file" ]; then
  [ -f "${2:-}" ] || { echo "checkpoint-note: the note file is missing" >&2; exit 1; }
  note=$(cat "$2"); rm -f "$2"
elif [ $# -gt 0 ]; then note="$*"; else note=$(cat); fi
[ -n "$note" ] || { echo "checkpoint-note: the note is empty" >&2; exit 1; }
hub_post "/agents/${AGENT// /%20}/checkpoint-note" "{\"by\":\"$(json_escape "$AGENT")\",\"text\":\"$(json_escape "$note")\"}" ||
  { echo "checkpoint-note: the hub did not answer" >&2; exit 1; }
echo
