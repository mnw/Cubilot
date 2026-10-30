# Shared by the checkpoint hooks of the Orchestrator role. Sourced, never run.
# The agent is $CHATBRIDGE_AGENT; the hub address and token are the files the app keeps in the app data folder.

DATA_DIR="${CUBILOT_DATA_DIR:-$HOME/Library/Application Support/Cubilot}"
AGENT="${CHATBRIDGE_AGENT:-}"

# A name is a plain file name: no path part, no leading dot.
agent_ok() {
  case "$AGENT" in
    ''|.*|*/*|*\\*) return 1 ;;
    *) return 0 ;;
  esac
}

# JSON string content of $1: backslash, quote and the usual control characters escaped, other controls dropped.
json_escape() {
  local s
  s=$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# POST the JSON body $2 to the hub path $1. Prints the answer. Silent on any failure: a hook must never stop the lead.
hub_post() {
  local url token
  url=$(cat "$DATA_DIR/hub.url" 2>/dev/null) || return 1
  token=$(cat "$DATA_DIR/hub.token" 2>/dev/null) || return 1
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -s --max-time 5 --config - -H 'Content-Type: application/json' -d "$2" "${url%/}$1" 2>/dev/null
}
