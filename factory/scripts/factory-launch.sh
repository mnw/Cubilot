#!/usr/bin/env bash
# factory-launch.sh <role> <agent-name> [--model <m>] [--provider <p>] [--room <label>] [--dry-run] [-- <extra args>]
# Tasks 1.1 and 1.2: read the role frontmatter and launch the role.
# Claude roles: stage a temp copy of the role plugin (the source has no manifest, and Claude Code writes files into a
# loaded plugin dir, so the repo must not be loaded directly), load it and factory/shared with --plugin-dir, and pass
# the role body (frontmatter stripped) with --append-system-prompt-file.
# Pi roles (1.4): --append-system-prompt with the role body, --skill role then shared, --exclude-tools.
# Settings (1.3): enabledPlugins false for every installed marketplace plugin, skillOverrides off for every user and
# project skill. Kept on: factory-<role>, factory-shared, chatbridge (all loaded with --plugin-dir, so not listed in
# installed_plugins.json) and account-synced plugins (no setting turns them off, check 0.2). Needs jq.
set -euo pipefail

FACTORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DATA="${CUBILOT_APP_DATA:-$HOME/Library/Application Support/Cubilot}"
# The pi extension: the installed app's bundle, else the repo build (build-sidecars.sh), else CUBILOT_PI_EXTENSION.
PI_EXT="${CUBILOT_PI_EXTENSION:-}"
if [ -z "$PI_EXT" ]; then
  for c in "/Applications/Cubilot.app/Contents/Resources/resources/pi-extension.js" "$FACTORY_DIR/../src-tauri/resources/pi-extension.js"; do
    [ -f "$c" ] && { PI_EXT="$c"; break; }
  done
fi

usage() { echo "usage: $0 <role> <agent-name> [--model <m>] [--provider <p>] [--room <label>] [--dry-run] [-- <extra args>]" >&2; exit 2; }

role="" agent="" model_override="" provider_override="" room="${CHATBRIDGE_ROOM:-}" dry_run=0 extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; extra=("$@"); break ;;
    --model) [ $# -ge 2 ] || usage; model_override="$2"; shift 2 ;;
    --provider) [ $# -ge 2 ] || usage; provider_override="$2"; shift 2 ;;
    --room) [ $# -ge 2 ] || usage; room="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -*) usage ;;
    *) if [ -z "$role" ]; then role="$1"; elif [ -z "$agent" ]; then agent="$1"; else usage; fi; shift ;;
  esac
done
[ -n "$role" ] && [ -n "$agent" ] || usage

role_file="$FACTORY_DIR/$role/$role.md"
[ -f "$role_file" ] || { echo "unknown role '$role': no $role_file" >&2; exit 1; }

# Value of a top-level key in the first frontmatter block (between the first two '---' lines); empty if absent.
fm() {
  awk -v key="$1" '
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    NR > 1 && index($0, key ":") == 1 { sub("^" key ":[ \t]*", ""); print; exit }
  ' "$role_file"
}
# "Task, Agent" -> "Task,Agent"
csv() { printf '%s' "$1" | tr -d ' '; }
# Same lists as src-tauri/src/pty.rs (ROLE_ALLOWED_TOOLS, ACK_PERMISSION): a role agent may use the handoff,
# interrupt and ticket tools without a prompt and must not answer permission requests.
ROLE_ALLOWED_TOOLS="post post_file send_handoff accept_handoff decline_handoff cancel_handoff send_interrupt ack_interrupt create_ticket claim_ticket transition_ticket assign_ticket attach_ticket_file list_tickets"
allowed_csv() { local t out=""; for t in $ROLE_ALLOWED_TOOLS; do out="$out${out:+,}mcp__chatbridge__$t"; done; printf '%s' "$out"; }
# "$1" plus $2, unless $1 already has it (comma separated list).
with_blocked() { case ",$1," in *",$2,"*) printf '%s' "$1" ;; *) printf '%s' "${1:+$1,}$2" ;; esac; }

if [ -n "$(fm council)" ]; then
  echo "role '$role' is a council (council.yaml), not a single agent; it has no launch command" >&2
  exit 1
fi

harness="$(fm harness)"; harness="${harness:-claude}"
model="${model_override:-$(fm model)}"
provider="${provider_override:-$(fm provider)}"
thinking="$(fm thinking)"
disallowed="$(csv "$(fm disallowedTools)")"
excluded="$(csv "$(fm excludeTools)")"

case "$harness" in
  claude)
    stage="${STAGE_DIR:-<stage>}"
    cmd=(claude --plugin-dir "$stage/$role" --plugin-dir "$stage/shared" --append-system-prompt-file "$stage/$role/role.md")
    [ -n "$model" ] && cmd+=(--model "$model")
    cmd+=(--disallowed-tools "$(with_blocked "$disallowed" mcp__chatbridge__ack_permission)")
    cmd+=(--settings "$stage/settings.json")
    cmd+=(--allowed-tools "$(allowed_csv)")
    if [ -n "$room" ]; then
      # Join the room like an app agent: the staged chatbridge mod and the app's MCP config when it exists.
      cmd+=(--plugin-dir "$APP_DATA/chatbridge-mod")
      [ -f "$APP_DATA/mcp-configs/global.json" ] && cmd+=(--mcp-config "$APP_DATA/mcp-configs/global.json")
    fi
    ;;
  pi)
    # Pi resolves skill name collisions first-one-wins: the role and shared folders come before any other --skill.
    # They are read in place from the repo (Pi writes nothing into a skill folder); only the role body is a temp file.
    stage="${STAGE_DIR:-<stage>}"
    # --no-skills: without it Pi also finds ~/.claude/skills and that copy of a skill wins (seen live for asd-ste100);
    # explicit --skill paths still load.
    cmd=(pi --no-skills --append-system-prompt "$stage/role.md")
    [ -d "$FACTORY_DIR/$role/skills" ] && cmd+=(--skill "$FACTORY_DIR/$role/skills")
    cmd+=(--skill "$FACTORY_DIR/shared/skills")
    [ -n "$provider" ] && cmd+=(--provider "$provider")
    [ -n "$model" ] && cmd+=(--model "$model")
    [ -n "$thinking" ] && cmd+=(--thinking "$thinking")
    cmd+=(--exclude-tools "$(with_blocked "$excluded" ack_permission)")
    if [ -n "$room" ]; then
      # Join the room: the app's pi extension (it holds the chatbridge tools); --no-approve as the app passes.
      cmd+=(--no-approve -e "$PI_EXT")
    fi
    ;;
  *) echo "role '$role': unknown harness '$harness'" >&2; exit 1 ;;
esac

if [ "$dry_run" -eq 1 ]; then
  # Quote a word only when it has characters outside the safe set (so "Task,Agent" stays readable).
  local_safe='^[A-Za-z0-9_./:=,+@<>-]+$'  # in a variable: bash 3.2 rejects < > inside a literal [[ =~ ]] pattern
  q() { local sq="'\\''"; if [[ "$1" =~ $local_safe ]]; then printf '%s' "$1"; else printf "'%s'" "${1//\'/$sq}"; fi; }
  printf 'CHATBRIDGE_AGENT=%s' "$(q "$agent")"
  [ -n "$room" ] && printf ' CHATBRIDGE_ROOM=%s' "$(q "$room")"
  for w in "${cmd[@]}" ${extra[@]+"${extra[@]}"}; do printf ' %s' "$(q "$w")"; done
  printf '\n'
  exit 0
fi

# Task 1.3: <stage>/settings.json for a Claude role. Read-only on ~/.claude.
write_settings() {
  command -v jq >/dev/null || { echo "jq is required to write the role settings" >&2; exit 1; }
  local installed="$HOME/.claude/plugins/installed_plugins.json" plugins="" skills="" d n
  [ -f "$installed" ] && plugins="$(jq -r '.plugins // {} | keys[]' "$installed")"
  for d in "$HOME/.claude/skills"/*/ "$PWD/.claude/skills"/*/; do
    [ -f "${d}SKILL.md" ] || continue
    n="$(awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit } /^name:/ { sub("^name:[ \t]*", ""); gsub(/["\x27]/, ""); print; exit }' "${d}SKILL.md")"
    skills="$skills${n:-$(basename "$d")}"$'\n'
  done
  # User and project slash commands are listed like skills (opsx/apply.md -> opsx:apply); same override key form.
  local base f rel
  for base in "$HOME/.claude/commands" "$PWD/.claude/commands"; do
    [ -d "$base" ] || continue
    while IFS= read -r f; do
      rel="${f#"$base"/}"; rel="${rel%.md}"
      skills="$skills${rel//\//:}"$'\n'
    done < <(find "$base" -name '*.md' -type f)
  done
  jq -n --arg plugins "$plugins" --arg skills "$skills" '
    def names: split("\n") | map(select(length > 0)) | unique;
    { enabledPlugins: ($plugins | names | map({key: ., value: false}) | from_entries),
      skillOverrides: ($skills  | names | map({key: ., value: "off"})  | from_entries) }' > "$STAGE_DIR/settings.json"
}

STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/factory-launch.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT
# Role body: everything after the closing '---' of the frontmatter.
role_body() { awk 'NR == 1 && $0 == "---" { fm = 1; next } fm && $0 == "---" { fm = 0; next } !fm' "$role_file"; }
if [ "$harness" = pi ]; then
  role_body > "$STAGE_DIR/role.md"
  cmd=("${cmd[@]//<stage>/$STAGE_DIR}")
  CHATBRIDGE_AGENT="$agent" CHATBRIDGE_ROOM="$room" "${cmd[@]}" ${extra[@]+"${extra[@]}"}
  exit $?
fi

# Claude: stage a temp copy: <stage>/<role> (manifest, skills, hooks, role.md) and <stage>/shared.
mkdir -p "$STAGE_DIR/$role/.claude-plugin"
printf '{"name": "factory-%s"}\n' "$role" > "$STAGE_DIR/$role/.claude-plugin/plugin.json"
[ -d "$FACTORY_DIR/$role/skills" ] && cp -R "$FACTORY_DIR/$role/skills" "$STAGE_DIR/$role/skills"
if [ -f "$FACTORY_DIR/$role/hooks/hooks.json" ]; then
  mkdir -p "$STAGE_DIR/$role/hooks"; cp "$FACTORY_DIR/$role/hooks/hooks.json" "$STAGE_DIR/$role/hooks/hooks.json"
fi
role_body > "$STAGE_DIR/$role/role.md"
cp -R "$FACTORY_DIR/shared" "$STAGE_DIR/shared"
write_settings

# Rebuild the command with the real stage path.
cmd=("${cmd[@]//<stage>/$STAGE_DIR}")
CHATBRIDGE_AGENT="$agent" CHATBRIDGE_ROOM="$room" "${cmd[@]}" ${extra[@]+"${extra[@]}"}
