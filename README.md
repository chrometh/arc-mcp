# Arc MCP Server — v3

Custom MCP server that attaches to Arc browser via Chrome DevTools Protocol using Playwright.
**Attach-only** (never launches or kills Arc). **Accessibility-tree-first** targeting.
**Sidebar-aware** (knows favorites, pinned, today, spaces). **Agent-pinned working tab**
(user can switch tabs freely without disturbing the agent's work).

## Setup

### 1. LaunchAgent — Arc always boots in debug mode at login

Already wired at `~/Library/LaunchAgents/com.arc.debug.plist`. Runs `launch-arc.sh` at login,
which is idempotent: if Arc is already running with port 9222, it does nothing; otherwise it
gracefully relaunches. Check:

```bash
launchctl list | grep arc.debug
tail /tmp/arc-debug-launch.log
```

### 2. Manual one-shot launch (rare fallback)

Only needed if you manually quit Arc mid-day and relaunch via Dock without the flag. The MCP
attach error message will tell you to run this:

```bash
~/Projects/arc-mcp/launch-arc.sh
```

### 3. MCP attaches automatically

Wired into `~/.claude.json` as `mcp.servers.arc`. Claude Code attaches to Arc's CDP endpoint.

## v3 architecture

```
index.js              MCP server — ~30 tools
lib/
  attach.js           Playwright CDP attach + agent-pin (working tab survives user tab switches)
  locators.js         Role+name+text+label+testid+css locator resolution
  snapshot.js         Compact semantic page snapshot (AX tree → markdown)
  sidebar.js          Reads ~/Library/Application Support/Arc/StorableSidebar.json — taxonomy source
  osa.js              AppleScript bridge (active-tab + active-space + space focus, with 500ms cache)
  tools.js            All tool implementations
launch-arc.sh         Idempotent Arc launcher with --remote-debugging-port=9222
```

### How agent-pin solves "user switches tab and trips Claude up"

Before v3: every tool call resolved the active tab via osascript ("what is Arc's foreground?")
and ran against that. If the user switched tabs in Arc, the next tool call hopped to the new
tab and broke whatever multi-step flow Claude was running.

v3 introduces an in-memory **agent-pin**. `arc_navigate` and `arc_new_tab` auto-pin the
resulting page. All subsequent ops target the pinned page regardless of Arc's foreground.
The user can switch tabs, browse other sites, even switch spaces — and Claude keeps working
on the pinned tab via CDP (which doesn't care about Arc UI focus).

To inspect alignment: `arc_active_tab` returns both `{user, agent}`.
To release the pin: `arc_unpin`.

### Arc taxonomy (favorites / pinned / today / spaces)

CDP has no concept of Arc's sidebar. AppleScript only partially exposes it (and `tabs of space`
returns only unpinned today tabs — favorites and pinned are window-flat with no space tag).
The full structure lives in `StorableSidebar.json`; `lib/sidebar.js` reads + caches it.

| Concept | Where it comes from | Tool |
|---|---|---|
| Favorites (sidebar topApp icons, per-space) | `sidebar.json` | `arc_list_favorites` |
| Pinned tabs (per-space, persistent) | `sidebar.json` | `arc_list_pinned` |
| Today tabs (ephemeral, auto-archive) | CDP page list ∩ sidebar | `arc_list_tabs` |
| Spaces + tab counts | `sidebar.json` | `arc_list_spaces` |
| Space focus (current) | osascript (cached 500ms) | `arc_active_tab` |
| Active foreground tab | osascript (cached 500ms) | `arc_active_tab` |
| Agent's working tab | in-memory pin | `arc_pin`/`arc_unpin`/`arc_active_tab` |
| Loaded vs unloaded | CDP page list ∩ sidebar | `loaded` flag in tab listings |

`arc_wake_tab` loads an unloaded favorite/pinned tab via CDP **without bringing it to
foreground** — handy for "I need to drive Slack but the user is in Asana."

## Key tool: `arc_snapshot`

Read this first before any click/type. Returns a compact markdown view of the active page:
- Headings outline
- Interactive elements grouped by role (buttons, links, inputs, checkboxes, etc.)
- Main content text preview

Then click/type by role + name without guessing selectors.

```
1. arc_snapshot                                                  → see what's on page
2. arc_click { role: "button", name: "Add to cart" }             → Playwright auto-waits + clicks
3. arc_type  { label: "Email", text: "sol@takehytz.com" }        → fills form input
```

## Tools

### Navigation + Tabs
- `arc_navigate` (auto-pins) · `arc_go_back` · `arc_go_forward`
- `arc_list_tabs` (enriched: space, location, loaded, isUserActive, isAgentPinned)
- `arc_switch_tab` (foreground=true by default)
- `arc_new_tab` (background by default — no focus theft, auto-pins)
- `arc_close_tab` (refuses pinned/favorites without `force: true`, requires explicit target)
- `arc_page_info`

### Agent-pin (v3)
- `arc_pin` — pin a tab as the agent's working tab
- `arc_unpin` — drop the pin
- `arc_active_tab` — see both user foreground + agent pin

### Sidebar (v3)
- `arc_list_favorites` (optionally filter by space)
- `arc_list_pinned` (optionally filter by space)
- `arc_wake_tab` — load an unloaded favorite/pinned via CDP without focus

### Reading the page
- `arc_snapshot` — semantic snapshot (START HERE)
- `arc_read_page` — markdown / text / html modes

### Interactions (Playwright auto-wait + retry built in)
- `arc_click` · `arc_type` · `arc_hover` · `arc_select` · `arc_check`/`arc_uncheck`
- `arc_press_key` · `arc_fill_form` · `arc_scroll` · `arc_wait_for`

### Visual + Eval
- `arc_screenshot` (auto-cleans /tmp screenshots older than 24h on startup)
- `arc_eval` — raw JS escape hatch

### DevTools (buffers attach eagerly on browser connect)
- `arc_console` · `arc_network` · `arc_network_detail`

### Emulation + Perf
- `arc_emulate` (presets: iphone-14 / iphone-se / ipad / desktop / desktop-4k / custom)
- `arc_lighthouse` · `arc_trace_start` / `arc_trace_stop`

### Arc-specific
- `arc_list_spaces` (with per-space favorite/pinned/unpinned counts)
- `arc_switch_space` (uses Arc's `focus` AppleScript command)

### Scrape
- `arc_scrape_urls` (background tabs, no focus theft)

## Locator spec (used by click, type, hover, select, check, wait_for)

```ts
{
  role:         "button" | "link" | "textbox" | ... ,  // ARIA role
  name:         string,                                 // accessible name
  text:         string,                                 // visible text
  label:        string,                                 // associated <label>
  placeholder:  string,                                 // input placeholder
  testid:       string,                                 // data-testid
  css:          string,                                 // raw CSS (escape hatch)
  xpath:        string,                                 // raw XPath (escape hatch)
  index:        number                                  // disambiguate multi-match
}
```

**Strict by default.** If a locator matches >1 element and no `index` is given, the call fails
loudly. Provide `index: 0` (or be more specific) to disambiguate.

## Design principles

1. **Never kill Arc.** `attach.js` only connects; disconnecting releases the CDP socket without
   touching Arc.
2. **Never steal user focus.** `bringToFront()` is opt-in. New tabs open in the background.
3. **Agent-pin first.** `getActivePage()` prefers the agent's pinned tab over Arc's foreground.
4. **Auto-wait on actions.** Playwright waits up to 10s (configurable) for elements to be
   visible + enabled + stable before acting.
5. **Accessibility-tree-first.** Snapshot exposes semantic structure; clicks by role+name
   survive class-name churn on React/Shopify.
6. **Strict mode.** Ambiguous locators fail loudly — no silent wrong-element clicks.
7. **Sidebar truth.** Per-space favorites/pinned come from Arc's own state file, not flaky
   AppleScript walks.

## Migration from v2

Behavior changes (mostly invisible — no tool renames):
- `arc_navigate` and `arc_new_tab` now auto-pin (override with `autoPin: false`).
- `arc_new_tab` opens in background by default (`foreground: false`). Pass `foreground: true`
  to restore old behavior.
- `arc_close_tab` requires an explicit target (no fallthrough to active) and refuses to close
  favorites/pinned tabs without `force: true`.
- `arc_list_tabs` filters chrome:// / about: pages by default. Pass `includeInternal: true`
  for raw view.
- `arc_switch_space` now uses Arc's `focus` command (was `select`, which was a tab command —
  worked by accident).
- `getActivePage()` prefers agent-pin → osascript foreground → first non-blank.

New tools: `arc_pin`, `arc_unpin`, `arc_active_tab`, `arc_list_favorites`, `arc_list_pinned`,
`arc_wake_tab`.

v2 is archived at `~/Projects/arc-mcp-v1-archive/` (technically v1 — v2 was an in-place rewrite
that wasn't archived separately).

## Troubleshooting

**"Arc isn't reachable on localhost:9222"** — run `~/Projects/arc-mcp/launch-arc.sh` (idempotent).
The error message includes this guidance.

**"N elements match: ..."** — locator was ambiguous. Either be more specific (add `name` to a
`role` query, use `testid`) or pass `index: 0` explicitly.

**"This operation requires an explicit target"** — `arc_close_tab` won't fall through to the
active tab anymore. Pass `urlContains` / `titleContains` / `index`.

**"Tab is a favorite / pinned in space ..."** — `arc_close_tab` refuses by default. Pass
`force: true` if you really mean it.

**Agent + user tab disagree** — call `arc_active_tab`. If `agent.url` and `user.url` differ,
that's normal and intentional (the pin is doing its job). To re-sync to user's foreground,
call `arc_unpin`.

**Slow first call** — Playwright loads its driver on first attach. Subsequent calls are fast.
