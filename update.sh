#!/bin/bash
# Roll running agents onto the current code. Safe to re-run at any time.
#
# Every harness (Claude Code, Codex, OpenCode, DSH) launches the MCP server
# from this checkout by absolute path, so NEW agent sessions always get the
# current code for free. What this script fixes is the processes already
# running: the hub that owns port 47120, which can be days old.
#
# Long-lived MCP processes are NOT killed. They belong to editors and agent
# apps whose work would be interrupted, and since 1.2.0 the hub no longer
# trusts a stale relay's browser choice, so an outdated one is refused rather
# than silently misrouted. They pick up new code when their app restarts.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT="${CHROME_AGENT_PORT:-47120}"

hub_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

echo "▸ Checking dependencies…"
(cd server && npm install --no-fund --no-audit --silent)

echo "▸ Checking the running hub on port $PORT…"
PID="$(hub_pid || true)"

if [ -z "$PID" ]; then
  echo "  no hub running — the next agent tool call starts one on current code."
  exit 0
fi

# Compare the hub's start time against the newest source file. A hub older
# than the code is serving stale logic to every session on this machine.
HUB_EPOCH="$(date -j -f "%a %b %d %T %Y" "$(ps -o lstart= -p "$PID")" +%s 2>/dev/null || echo 0)"
# Only files whose contents change the hub's BEHAVIOUR count. node_modules and
# the lockfile are excluded because npm restamps them during the dependency
# check above — counting those would make the code permanently "newer" than
# the hub and restart it on every single run.
CODE_EPOCH="$(find server extension -type f \
  \( -name '*.mjs' -o -name '*.js' -o -name 'manifest.json' \) \
  -not -path '*/node_modules/*' \
  -exec stat -f %m {} + 2>/dev/null | sort -rn | head -1)"

if [ "$HUB_EPOCH" -gt "$CODE_EPOCH" ]; then
  echo "  hub (pid $PID) already newer than the code — nothing to do."
  exit 0
fi

echo "  hub (pid $PID) predates the code — restarting it."

# The handover is a race: when the hub dies, every relay waits 250-750ms and
# then tries to claim the port. Losing that race would hand the hub role to
# ANOTHER long-lived process still running old code, which is exactly what we
# are trying to get rid of. So start the replacement immediately and confirm
# it actually won, rather than assuming.
kill -TERM "$PID" 2>/dev/null || true
sleep 0.15

# stdin must stay open: index.mjs treats stdin close as "my MCP client exited"
# and shuts down, which would silently hand the port back to an old relay.
nohup node "$ROOT/server/index.mjs" < /dev/zero > /tmp/chrome-agent-hub.log 2>&1 &
NEW=$!
sleep 2

WINNER="$(hub_pid || true)"
if [ "$WINNER" = "$NEW" ]; then
  echo "✔ hub restarted on current code (pid $NEW)."
else
  echo "⚠ another process (pid ${WINNER:-none}) claimed port $PORT first."
  echo "  It is an older relay that won the election. Re-run this script to retry."
  exit 1
fi

echo
echo "Agent sessions already running keep their old MCP process until their app"
echo "restarts. That is safe: the hub refuses a stale relay's browser guess"
echo "instead of routing it to the wrong Chrome profile."
