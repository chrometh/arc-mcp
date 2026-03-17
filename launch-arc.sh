#!/bin/bash
# Launch Arc with Chrome DevTools Protocol enabled
# This allows the Arc MCP server to connect and control the browser

# Kill existing Arc instances gracefully
osascript -e 'tell application "Arc" to quit' 2>/dev/null
sleep 2

# Launch Arc with remote debugging port
open -a "Arc" --args --remote-debugging-port=9222
