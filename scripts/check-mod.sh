#!/usr/bin/env bash
# Validate and type-check the Claude Code mod. Usage: check-mod.sh [path/to/claude-code/index.d.ts]
set -euo pipefail

cd "$(dirname "$0")/.."

MOD=hub/channel/claude-mod
DTS="${1:-$HOME/Library/Application Support/Cubilot/chatbridge-mod/.claude-plugin/types/claude-code/index.d.ts}"

if [ ! -f "$DTS" ]; then
  echo "FAIL: Claude Code declarations not found: $DTS"
  echo "Launch a Claude Code session with the staged mod loaded (claude --plugin-dir <staged chatbridge-mod>);"
  echo "Claude Code writes .claude-plugin/types/claude-code/index.d.ts into it. Or pass the path as the first argument."
  exit 1
fi

# claude is a zsh alias for the installer's copy, invisible to non-interactive bash.
CLAUDE=$(command -v claude 2>/dev/null || true)
[ -x "$CLAUDE" ] || CLAUDE="$HOME/.claude/local/claude"
[ -x "$CLAUDE" ] || { echo "FAIL: claude not found on PATH or at $HOME/.claude/local/claude"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== bundle -> $TMP"
mkdir -p "$TMP/.claude-plugin" "$TMP/hooks"
cp "$MOD/.claude-plugin/plugin.json" "$TMP/.claude-plugin/"
cp "$MOD/hooks/hooks.json" "$TMP/hooks/"
mkdir -p "$TMP/types" && cp "$MOD/types/index.d.ts" "$TMP/types/"
bun build "./$MOD/register.ts" --format=esm --target=browser --outfile "$TMP/hooks/register.js"

echo "== claude plugin validate"
OUT=$("$CLAUDE" plugin validate "$TMP" 2>&1) && RC=0 || RC=$?
echo "$OUT"
if [ "$RC" -ne 0 ]; then
  echo "FAIL: plugin validate (exit $RC)"
  exit 1
fi
# Claude Code 2.1.308 adds plugin-directory checks (catalog submission) that need a README and a LICENSE.
# The mod is staged, never submitted: those two problems are known and allowed. Any other ✘ line, or any
# other problem listed under the directory header, fails.
if grep '✘' <<<"$OUT" | grep -qv 'plugin directory refuses a submission'; then
  echo "FAIL: plugin validate reported an error"
  exit 1
fi
OTHER=$(awk '/✘ Found .* plugin directory refuses a submission/ {on=1; next} /^(⚠|About)/ {on=0} on && /^  ❯ / && !/\((README_MISSING|LICENSE_MISSING)\)/' <<<"$OUT")
if [ -n "$OTHER" ]; then
  echo "FAIL: plugin directory check reported a problem other than README_MISSING / LICENSE_MISSING:"
  echo "$OTHER"
  exit 1
fi

echo "== tsc (register.ts vs $DTS)"
cat > "$TMP/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true, "resolveJsonModule": true
  },
  "include": ["$DTS", "$PWD/$MOD/types/index.d.ts", "$PWD/$MOD/register.ts"]
}
JSON
bun x tsc -p "$TMP/tsconfig.json"
echo "tsc clean"

echo "== claude plugin test"
cp -R "$MOD/tests" "$TMP/tests"
"$CLAUDE" plugin test "$TMP"

echo "OK"
