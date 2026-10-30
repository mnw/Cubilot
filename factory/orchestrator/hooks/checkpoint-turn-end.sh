#!/bin/bash
# Stop hook of the Orchestrator role: tells the hub that this agent ended a turn (POST /agents/<name>/turn-end).
# The body holds the final message of the turn (last_assistant_message of the hook input): after a note request it is the note.
# The hub changes nothing unless a checkpoint of this agent waits for a turn end. Always exits 0 with no output.
. "$(dirname "$0")/checkpoint-lib.sh"
input=$(cat)
agent_ok || exit 0
msg=""
if command -v jq >/dev/null 2>&1; then msg=$(printf '%s' "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null || true); fi
hub_post "/agents/${AGENT// /%20}/turn-end" "{\"by\":\"$(json_escape "$AGENT")\",\"text\":\"$(json_escape "$msg")\"}" > /dev/null || true
exit 0
