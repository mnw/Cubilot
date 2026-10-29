#!/bin/bash
# Stop hook of the Orchestrator role: tells the hub that this agent ended a turn (POST /agents/<name>/turn-end).
# The hub changes nothing unless a checkpoint of this agent waits for a turn end. Always exits 0 with no output.
. "$(dirname "$0")/checkpoint-lib.sh"
cat > /dev/null
agent_ok || exit 0
hub_post "/agents/${AGENT// /%20}/turn-end" "{\"by\":\"$(json_escape "$AGENT")\"}" > /dev/null || true
exit 0
