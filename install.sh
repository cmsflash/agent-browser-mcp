#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

echo "▸ Installing server dependencies…"
(cd server && npm install --no-fund --no-audit)

echo "▸ Registering MCP server (user scope: available to Cowork/Claude Code everywhere)…"
claude mcp remove --scope user chrome-agent >/dev/null 2>&1 || true
claude mcp add --scope user chrome-agent -- node "$ROOT/server/index.mjs"

echo "▸ Installing the chrome-agent skill…"
mkdir -p "$HOME/.claude/skills"
rm -rf "$HOME/.claude/skills/chrome-agent"
ln -s "$ROOT/skills/chrome-agent" "$HOME/.claude/skills/chrome-agent"

cat <<EOF

✔ Done. One manual step remains (Chrome forbids scripting it):

  1. Open chrome://extensions
  2. Enable "Developer mode" (top right)
  3. "Load unpacked" → $ROOT/extension

The extension badge turns green ● while an agent session is connected.
Optional: launch Chrome with --silent-debugger-extension-api to hide the
debugging info bar.
EOF
