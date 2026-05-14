#!/bin/bash
# launch-arc.sh — idempotent Arc launcher with CDP debug port.
#
# Checks if Arc is ALREADY running with --remote-debugging-port=9222.
# If yes: prints attach instructions, exits 0, leaves Arc alone.
# If no:  gracefully quits any existing Arc, relaunches with debug port.

PORT=${ARC_CDP_PORT:-9222}

# Check if CDP endpoint is reachable AND Arc was launched with --remote-allow-origins
# (required for Playwright CDP attach). If either is missing, relaunch.
if curl -s --max-time 1 "http://localhost:${PORT}/json/version" > /dev/null 2>&1; then
  if pgrep -fl "Arc.app.*--remote-allow-origins" > /dev/null 2>&1; then
    echo "✓ Arc is already running with debug port ${PORT} + allow-origins. Nothing to do."
    echo "   MCP will attach via CDP."
    exit 0
  fi
  echo "⚠ Arc is running on debug port ${PORT} but missing --remote-allow-origins. Relaunching."
fi

# CDP not reachable. Arc may or may not be running without the flag.
if pgrep -x "Arc" > /dev/null; then
  echo "⚠ Arc is running but NOT on debug port ${PORT}. Relaunching with debug flag…"
  osascript -e 'tell application "Arc" to quit' 2>/dev/null
  for i in 1 2 3 4 5; do
    if ! pgrep -x "Arc" > /dev/null; then break; fi
    sleep 1
  done
  if pgrep -x "Arc" > /dev/null; then
    echo "⚠ Arc didn't quit gracefully. Force-killing."
    pkill -9 -x "Arc"
    sleep 1
  fi
fi

echo "→ Launching Arc with --remote-debugging-port=${PORT} --remote-allow-origins=*"
# --remote-allow-origins=* is required for Playwright CDP attach; without it, WS handshake
# succeeds but Chrome silently drops messages from non-devtools origins (times out).
open -a "Arc" --args --remote-debugging-port=${PORT} --remote-allow-origins=*

# Wait up to 10s for CDP to come online
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s --max-time 1 "http://localhost:${PORT}/json/version" > /dev/null 2>&1; then
    echo "✓ Arc is running with debug port ${PORT}."
    exit 0
  fi
  sleep 1
done

echo "✗ Arc launched but CDP port ${PORT} not reachable after 10s. Check Arc manually."
exit 1
