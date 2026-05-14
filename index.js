#!/usr/bin/env node
// index.js — Arc MCP v3 server.
//
// Attach-only Arc CDP via Playwright. Accessibility-tree-first targeting.
// Auto-wait + retry on all actions. Never launches or kills Arc.
//
// v3 highlights:
//   - Agent-pin: arc_navigate / arc_new_tab pin a working tab; subsequent ops
//     stay on it even when the user switches Arc's foreground.
//   - Sidebar-aware: per-space favorites, pinned, today; loaded vs unloaded.
//   - No focus theft: bringToFront() is opt-in (foreground: true), default off.
//   - Safer close: refuses pinned/favorite tabs without { force: true }.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tools from "./lib/tools.js";

const server = new McpServer({ name: "arc", version: "3.0.0" });

function wrap(fn) {
  return async (args) => {
    try {
      const result = await fn(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message, stack: err.stack?.split("\n").slice(0, 3).join("\n") }, null, 2) }],
        isError: true,
      };
    }
  };
}

const LocatorSpec = z.object({
  role: z.string().optional().describe("ARIA role (button, link, textbox, combobox, etc.)"),
  name: z.string().optional().describe("Accessible name — the visible label/text of the element"),
  text: z.string().optional().describe("Match by visible text content"),
  label: z.string().optional().describe("Match by associated <label> (for form inputs)"),
  placeholder: z.string().optional().describe("Match by input placeholder"),
  testid: z.string().optional().describe("Match by data-testid attribute"),
  css: z.string().optional().describe("Raw CSS selector (escape hatch)"),
  xpath: z.string().optional().describe("Raw XPath (escape hatch)"),
  index: z.number().int().nonnegative().optional().describe("0-based index when locator matches multiple elements"),
  nth: z.number().int().nonnegative().optional(),
}).describe("Locator — use role + name first, CSS as escape hatch. Strict-by-default: multiple matches fail unless index is given.");

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

server.tool(
  "arc_navigate",
  "Navigate the active/pinned tab to a URL. Auto-pins the resulting page as the agent's working tab. REFUSES if the active tab is one of Master Sol's favorites/pinned tabs — call arc_new_tab instead, or arc_pin a non-favorite tab first.",
  {
    url: z.string().url(),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().default("load"),
    timeout: z.number().int().positive().optional().default(30_000),
    autoPin: z.boolean().optional().default(true).describe("Pin the resulting page as the agent's working tab (default: true)."),
    force: z.boolean().optional().default(false).describe("Override the favorites/pinned-tab protection. Use only when explicitly authorized."),
  },
  wrap(tools.navigate)
);
server.tool("arc_go_back", "Navigate back in current tab history. Refuses favorites/pinned without { force: true }.", { force: z.boolean().optional().default(false) }, wrap(tools.goBack));
server.tool("arc_go_forward", "Navigate forward in current tab history. Refuses favorites/pinned without { force: true }.", { force: z.boolean().optional().default(false) }, wrap(tools.goForward));

// ─── TABS ────────────────────────────────────────────────────────────────────

server.tool(
  "arc_list_tabs",
  "List open tabs enriched with Arc taxonomy: space, location ('topApp'=favorite|'pinned'|'unpinned'=today), loaded, isUserActive (Arc foreground), isAgentPinned (the agent's working tab). Filters chrome:// internal pages by default.",
  {
    includeInternal: z.boolean().optional().default(false),
    space: z.string().optional().describe("Filter to one space by title (e.g. 'Sol', 'Dobby')."),
  },
  wrap(tools.listTabs)
);
server.tool(
  "arc_switch_tab",
  "Bring a specific tab to the front (foreground=true by default — this DOES change the user's view). Pass foreground=false to switch the agent-pin without yanking focus.",
  {
    urlContains: z.string().optional(),
    titleContains: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    foreground: z.boolean().optional().default(true),
  },
  wrap(tools.switchTab)
);
server.tool(
  "arc_new_tab",
  "Open a new tab. Default: opens in background (no focus theft) and auto-pins as agent's working tab. Pass foreground=true to bring it to front.",
  {
    url: z.string().url().optional(),
    foreground: z.boolean().optional().default(false),
    autoPin: z.boolean().optional().default(true),
  },
  wrap(tools.newTab)
);
server.tool(
  "arc_close_tab",
  "Close a specific tab. REQUIRES explicit target (urlContains | titleContains | index). REFUSES to close favorites/pinned tabs unless { force: true }.",
  {
    urlContains: z.string().optional(),
    titleContains: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    force: z.boolean().optional().default(false),
  },
  wrap(tools.closeTab)
);

// ─── AGENT-PIN (the headline v3 fix) ─────────────────────────────────────────

server.tool(
  "arc_pin",
  "Pin a tab as the agent's working tab. Refuses to pin a favorite/pinned tab without { force: true } — these are Master Sol's, the agent should pin a non-favorite tab or open arc_new_tab.",
  {
    urlContains: z.string().optional(),
    titleContains: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    force: z.boolean().optional().default(false),
  },
  wrap(tools.pin)
);
server.tool(
  "arc_unpin",
  "Drop the agent-pin so future ops follow Arc's foreground tab again.",
  {},
  wrap(tools.unpin)
);
server.tool(
  "arc_active_tab",
  "Report both the user's foreground tab and the agent's pinned working tab. Use to verify alignment before acting.",
  {},
  wrap(tools.activeTab)
);

// ─── SIDEBAR (favorites + pinned, sourced from StorableSidebar.json) ─────────

server.tool(
  "arc_list_favorites",
  "List Arc favorites (sidebar topApp icons) across all spaces or one specific space. Each entry has { title, url, space, loaded }.",
  { space: z.string().optional() },
  wrap(tools.listFavorites)
);
server.tool(
  "arc_list_pinned",
  "List Arc pinned tabs (per-space pins, distinct from favorites) across all spaces or one specific space.",
  { space: z.string().optional() },
  wrap(tools.listPinned)
);
server.tool(
  "arc_wake_tab",
  "Load an unloaded tab via CDP without bringing to foreground. REFUSES favorites/pinned tabs without { force: true } — these are Master Sol's. To use a favorite's URL for agent work, call arc_new_tab with that URL instead (opens a fresh session tab).",
  {
    url: z.string().url(),
    autoPin: z.boolean().optional().default(false).describe("Pin the woken tab as agent's working tab (default false for safety)."),
    force: z.boolean().optional().default(false).describe("Override the favorites/pinned protection."),
  },
  wrap(tools.wakeTab)
);

// ─── PAGE INFO + READ ────────────────────────────────────────────────────────

server.tool("arc_page_info", "Quick info about the current target tab: URL, title, button/link counts.", {}, wrap(tools.page_info));

server.tool(
  "arc_snapshot",
  "Compact semantic snapshot of the current target page: interactive elements grouped by role (buttons/links/inputs), headings, main text preview. READ THIS FIRST before clicking — lets you target by role+name without guessing selectors.",
  {
    includeHidden: z.boolean().optional().default(false),
    textPreview: z.boolean().optional().default(true),
  },
  wrap(tools.snapshot)
);

server.tool(
  "arc_read_page",
  "Read the page content. mode: 'markdown' (default, semantic snapshot), 'text' (plain innerText), or 'html' (full HTML).",
  { mode: z.enum(["markdown", "text", "html"]).optional().default("markdown") },
  wrap(tools.readPage)
);

// ─── INTERACTIONS ────────────────────────────────────────────────────────────

server.tool(
  "arc_click",
  "Click an element. Refuses if active tab is one of Master Sol's favorites/pinned (pass { force: true } to override). Locate by role+name (preferred), text, label, or CSS. Use arc_snapshot first.",
  {
    locator: LocatorSpec.optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    css: z.string().optional(),
    coords: z.object({ x: z.number(), y: z.number(), button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().positive().optional() }).optional(),
    force: z.boolean().optional().default(false).describe("Playwright force-click (bypass element checks)"),
    forceProtected: z.boolean().optional().default(false).describe("Override the favorites/pinned-tab protection."),
    timeout: z.number().int().positive().optional().default(10_000),
  },
  wrap(async (args) => {
    const spec = args.locator ?? { role: args.role, name: args.name, text: args.text, css: args.css };
    return await tools.click(spec, { coords: args.coords, force: args.force, forceProtected: args.forceProtected, timeout: args.timeout });
  })
);

server.tool(
  "arc_type",
  "Type text into a field. Refuses if active tab is one of Master Sol's favorites/pinned (pass { force: true } to override).",
  {
    locator: LocatorSpec.optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    css: z.string().optional(),
    text: z.string(),
    clearFirst: z.boolean().optional().default(true),
    pressEnter: z.boolean().optional().default(false),
    delay: z.number().int().nonnegative().optional().default(0),
    timeout: z.number().int().positive().optional().default(10_000),
    force: z.boolean().optional().default(false).describe("Override the favorites/pinned-tab protection."),
  },
  wrap(async (args) => {
    const spec = args.locator ?? { role: args.role, name: args.name, label: args.label, placeholder: args.placeholder, css: args.css };
    return await tools.type(spec, { text: args.text, clearFirst: args.clearFirst, pressEnter: args.pressEnter, delay: args.delay, timeout: args.timeout, force: args.force });
  })
);

server.tool(
  "arc_hover",
  "Hover over an element. Refuses favorites/pinned tabs without { force: true }.",
  {
    locator: LocatorSpec.optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    css: z.string().optional(),
    timeout: z.number().int().positive().optional().default(10_000),
    force: z.boolean().optional().default(false),
  },
  wrap(async (args) => {
    const spec = args.locator ?? { role: args.role, name: args.name, text: args.text, css: args.css };
    return await tools.hover(spec, { timeout: args.timeout, force: args.force });
  })
);

server.tool(
  "arc_select",
  "Select option from a <select> dropdown. Refuses favorites/pinned without { force: true }.",
  {
    locator: LocatorSpec.optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    css: z.string().optional(),
    value: z.string().optional(),
    optionLabel: z.string().optional(),
    values: z.array(z.string()).optional(),
    timeout: z.number().int().positive().optional().default(10_000),
    force: z.boolean().optional().default(false),
  },
  wrap(async (args) => {
    const spec = args.locator ?? { role: args.role, name: args.name, label: args.label, css: args.css };
    return await tools.select(spec, { value: args.value, label: args.optionLabel, values: args.values, timeout: args.timeout, force: args.force });
  })
);

server.tool(
  "arc_check",
  "Check a checkbox or radio. Refuses favorites/pinned without { force: true }.",
  {
    locator: LocatorSpec.optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    css: z.string().optional(),
    timeout: z.number().int().positive().optional().default(10_000),
    force: z.boolean().optional().default(false),
  },
  wrap(async (args) => {
    const spec = args.locator ?? { role: args.role, name: args.name, label: args.label, css: args.css };
    return await tools.check(spec, { timeout: args.timeout, force: args.force });
  })
);

server.tool(
  "arc_uncheck",
  "Uncheck a checkbox. Refuses favorites/pinned without { force: true }.",
  {
    locator: LocatorSpec.optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    css: z.string().optional(),
    timeout: z.number().int().positive().optional().default(10_000),
    force: z.boolean().optional().default(false),
  },
  wrap(async (args) => {
    const spec = args.locator ?? { role: args.role, name: args.name, label: args.label, css: args.css };
    return await tools.uncheck(spec, { timeout: args.timeout, force: args.force });
  })
);

server.tool(
  "arc_press_key",
  "Press a keyboard key or combo. Refuses favorites/pinned without { force: true }.",
  {
    key: z.string(),
    locator: LocatorSpec.optional(),
    force: z.boolean().optional().default(false),
  },
  wrap(tools.pressKey)
);

server.tool(
  "arc_fill_form",
  "Fill multiple fields in sequence. Refuses favorites/pinned without { force: true }.",
  {
    fields: z.array(z.object({
      role: z.string().optional(),
      name: z.string().optional(),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      css: z.string().optional(),
      text: z.string().optional(),
      value: z.string().optional(),
      values: z.array(z.string()).optional(),
    })),
    force: z.boolean().optional().default(false),
  },
  wrap(tools.fillForm)
);

// ─── SCROLL + WAIT ───────────────────────────────────────────────────────────

server.tool(
  "arc_scroll",
  "Scroll the page. Refuses favorites/pinned without { force: true } (scrolling can trigger lazy-load on those tabs).",
  {
    to: z.enum(["top", "bottom"]).optional(),
    by: z.object({ x: z.number().optional(), y: z.number().optional() }).optional(),
    locator: LocatorSpec.optional(),
    smooth: z.boolean().optional().default(true),
    force: z.boolean().optional().default(false),
  },
  wrap(tools.scroll)
);

server.tool(
  "arc_wait_for",
  "Wait for a condition. type: 'load'/'domcontentloaded'/'networkidle', 'url' (with target fragment), 'element' (with locator target), 'timeout' (with ms target).",
  {
    type: z.enum(["load", "domcontentloaded", "networkidle", "url", "element", "timeout"]).default("load"),
    target: z.union([z.string(), z.number(), LocatorSpec]).optional(),
    timeout: z.number().int().positive().optional().default(30_000),
  },
  wrap(tools.waitFor)
);

// ─── VISUAL + EVAL ───────────────────────────────────────────────────────────

server.tool(
  "arc_screenshot",
  "Capture PNG screenshot of the current target page (or a specific element). Saves to /tmp by default; old screenshots auto-purged after 24h.",
  {
    fullPage: z.boolean().optional().default(false),
    locator: LocatorSpec.optional(),
    savePath: z.string().optional(),
  },
  wrap(tools.screenshot)
);

server.tool(
  "arc_eval",
  "Run JavaScript in the page context. Refuses favorites/pinned without { force: true }. Escape hatch — prefer structured tools when possible.",
  {
    expression: z.string(),
    args: z.any().optional(),
    force: z.boolean().optional().default(false),
  },
  wrap(tools.evalJs)
);

// ─── DEVTOOLS ────────────────────────────────────────────────────────────────

server.tool(
  "arc_console",
  "Get captured console logs from the current target page. Buffers attach eagerly on browser connect — you can inspect logs from before this call.",
  {
    since: z.number().int().nonnegative().optional(),
    level: z.enum(["log", "info", "warning", "error", "debug"]).optional(),
  },
  wrap(tools.getConsoleLogs)
);

server.tool(
  "arc_network",
  "Get captured network requests from the current target page.",
  {
    since: z.number().int().nonnegative().optional(),
    urlFilter: z.string().optional(),
  },
  wrap(tools.getNetworkActivity)
);

server.tool(
  "arc_network_detail",
  "Get full request/response detail for a specific network request.",
  { requestId: z.string() },
  wrap(tools.getNetworkDetail)
);

// ─── EMULATION + PERF ────────────────────────────────────────────────────────

server.tool(
  "arc_emulate",
  "Emulate a device. Preset: 'iphone-14', 'iphone-se', 'ipad', 'desktop', 'desktop-4k'. Or custom width/height.",
  {
    device: z.enum(["iphone-14", "iphone-se", "ipad", "desktop", "desktop-4k"]).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    deviceScaleFactor: z.number().positive().optional(),
    isMobile: z.boolean().optional(),
    hasTouch: z.boolean().optional(),
    userAgent: z.string().optional(),
  },
  wrap(tools.emulate)
);

server.tool(
  "arc_lighthouse",
  "Run Lighthouse audit on a URL (defaults to current target page). Returns category-score summary plus a path to the full JSON report on disk (reports are typically 500KB–3MB, too large to inline). Pass { includeFullReport: true } to embed the full lhr in the response anyway.",
  {
    url: z.string().url().optional(),
    formFactor: z.enum(["mobile", "desktop"]).optional().default("desktop"),
    onlyCategories: z.array(z.enum(["performance", "accessibility", "best-practices", "seo", "pwa"])).optional(),
    includeFullReport: z.boolean().optional().default(false).describe("Embed the full ~500KB+ lhr in the response. Default: false — report is saved to disk and only the path is returned."),
    savePath: z.string().optional().describe("Override the default /tmp save path for the full report."),
  },
  wrap(tools.lighthouse)
);

server.tool(
  "arc_trace_start",
  "Start a Chromium performance trace on the current target page.",
  { categories: z.array(z.string()).optional() },
  wrap(tools.traceStart)
);

server.tool(
  "arc_trace_stop",
  "Stop the active performance trace. Saves JSON trace file.",
  { savePath: z.string().optional() },
  wrap(tools.traceStop)
);

// ─── ARC-SPECIFIC ────────────────────────────────────────────────────────────

server.tool(
  "arc_list_spaces",
  "List Arc spaces in the front window with per-space tab counts (favorites/pinned/unpinned). Sourced from Arc's local sidebar state.",
  {},
  wrap(tools.listSpaces)
);
server.tool(
  "arc_switch_space",
  "Focus a specific Arc space by title. Uses Arc's `focus` AppleScript command.",
  { name: z.string() },
  wrap(tools.switchSpace)
);

// ─── SCRAPE ──────────────────────────────────────────────────────────────────

server.tool(
  "arc_scrape_urls",
  "Batch-open a list of URLs in temporary background tabs (no focus theft), extract text, close. For quick research.",
  {
    urls: z.array(z.string().url()),
    maxPerUrl: z.number().int().positive().optional().default(4000),
  },
  wrap(tools.scrapeUrls)
);

// ─── START ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
