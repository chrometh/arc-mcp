# Arc MCP Server

Custom MCP server that connects to Arc browser via Chrome DevTools Protocol, giving Claude Code full control of your browser — your tabs, your sessions, your cookies.

## Setup

### 1. Launch Arc with debug port
```bash
~/Projects/arc-mcp/launch-arc.sh
```
Or add to your shell profile for an alias:
```bash
alias arc="open -a Arc --args --remote-debugging-port=9222"
```

### 2. MCP server is auto-configured
Already wired into `~/.mcp.json`. Claude Code will connect on next session start.

## Tools

| Tool | Description |
|------|-------------|
| `arc_list_tabs` | List all open tabs |
| `arc_navigate` | Go to a URL |
| `arc_click` | Click by CSS selector |
| `arc_type` | Type into inputs |
| `arc_press_key` | Press keyboard keys |
| `arc_read_page` | Get page text or HTML |
| `arc_screenshot` | Capture page screenshot |
| `arc_eval` | Run JavaScript on page |
| `arc_new_tab` | Open new tab |
| `arc_close_tab` | Close a tab |
| `arc_switch_tab` | Bring tab to front |
| `arc_page_info` | Get URL, title, metadata |
| `arc_scroll` | Scroll up/down/top/bottom |
| `arc_go_back` | Browser back |
| `arc_go_forward` | Browser forward |
| `arc_wait_for` | Wait for element to appear |
