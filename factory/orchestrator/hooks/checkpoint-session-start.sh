#!/bin/bash
# SessionStart hook of the Orchestrator role, matcher "clear". Returns the checkpoint summary file of this agent as
# additionalContext and removes the file. The hub sees the file gone and ends the checkpoint. No file: no output.
. "$(dirname "$0")/checkpoint-lib.sh"
cat > /dev/null
agent_ok || exit 0
file="$DATA_DIR/checkpoints/$AGENT.md"
[ -f "$file" ] || exit 0
text=$(cat "$file" 2>/dev/null) || exit 0
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
  "$(json_escape "Checkpoint restart. Your context was cleared. The note you wrote and the state summary follow.
$text")"
rm -f "$file"
exit 0
