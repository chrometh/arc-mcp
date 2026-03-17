import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import { z } from "zod";
import fs from "fs";
import { execSync } from "child_process";

const CDP_PORT = 9222;
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;

// --- CDP Client ---

let browserWs = null;
let cmdId = 1;
const pending = new Map();

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function getBrowserWs() {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) return browserWs;
  const info = await fetchJson(`${CDP_HTTP}/json/version`).catch(() => {
    throw new Error("Can't connect to Arc. Launch it with: ~/Projects/arc-mcp/launch-arc.sh");
  });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    ws.on("open", () => {
      browserWs = ws;
      resolve(ws);
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    ws.on("error", reject);
    ws.on("close", () => { browserWs = null; });
    setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
  });
}

async function sendBrowser(method, params = {}) {
  const ws = await getBrowserWs();
  const id = cmdId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, 30000);
  });
}

// --- Page-level CDP (per-tab WebSocket) ---

const pageConnections = new Map();

// --- CDP Event System & Data Stores ---

const networkData = new Map();    // targetId -> Map<requestId, {...}>
const consoleData = new Map();    // targetId -> Array<{...}>
const enabledDomains = new Map(); // targetId -> Set<domain>
let activeTrace = null;           // { targetId, chunks: [], startTime, complete }

function handlePageEvent(targetId, method, params) {
  if (method === "Network.requestWillBeSent") {
    if (!networkData.has(targetId)) networkData.set(targetId, new Map());
    const store = networkData.get(targetId);
    store.set(params.requestId, {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData,
      resourceType: params.type,
      timestamp: params.timestamp,
      response: null,
      failed: false,
      failReason: null,
      finished: false,
    });
    if (store.size > 500) store.delete(store.keys().next().value);
  } else if (method === "Network.responseReceived") {
    const store = networkData.get(targetId);
    if (store?.has(params.requestId)) {
      const entry = store.get(params.requestId);
      entry.response = {
        status: params.response.status,
        statusText: params.response.statusText,
        headers: params.response.headers,
        mimeType: params.response.mimeType,
        contentLength: params.response.headers?.["content-length"] || null,
      };
    }
  } else if (method === "Network.loadingFinished") {
    const store = networkData.get(targetId);
    if (store?.has(params.requestId)) store.get(params.requestId).finished = true;
  } else if (method === "Network.loadingFailed") {
    const store = networkData.get(targetId);
    if (store?.has(params.requestId)) {
      const entry = store.get(params.requestId);
      entry.failed = true;
      entry.failReason = params.errorText;
      entry.finished = true;
    }
  } else if (method === "Runtime.consoleAPICalled") {
    if (!consoleData.has(targetId)) consoleData.set(targetId, []);
    const store = consoleData.get(targetId);
    store.push({
      type: params.type,
      text: params.args?.map((a) => a.value ?? a.description ?? a.type).join(" ") || "",
      timestamp: params.timestamp,
      stackTrace: params.stackTrace?.callFrames?.[0] || null,
    });
    if (store.length > 1000) store.shift();
  } else if (method === "Log.entryAdded") {
    if (!consoleData.has(targetId)) consoleData.set(targetId, []);
    const store = consoleData.get(targetId);
    store.push({
      type: params.entry.level,
      text: params.entry.text,
      url: params.entry.url,
      timestamp: params.entry.timestamp,
      stackTrace: null,
    });
    if (store.length > 1000) store.shift();
  } else if (method === "Tracing.dataCollected") {
    if (activeTrace) activeTrace.chunks.push(...(params?.value || []));
  } else if (method === "Tracing.tracingComplete") {
    if (activeTrace) activeTrace.complete = true;
  }
}

async function ensureDomain(targetId, domain) {
  if (!enabledDomains.has(targetId)) enabledDomains.set(targetId, new Set());
  const domains = enabledDomains.get(targetId);
  if (!domains.has(domain)) {
    await sendPage(targetId, `${domain}.enable`);
    domains.add(domain);
  }
}

async function getPageWs(targetId) {
  if (pageConnections.has(targetId)) {
    const existing = pageConnections.get(targetId);
    if (existing.readyState === WebSocket.OPEN) return existing;
    pageConnections.delete(targetId);
  }
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${CDP_PORT}/devtools/page/${targetId}`;
    const ws = new WebSocket(url);
    const pagePending = new Map();
    ws._pagePending = pagePending;
    ws._cmdId = 1;
    ws.on("open", () => {
      pageConnections.set(targetId, ws);
      resolve(ws);
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pagePending.has(msg.id)) {
        const { resolve, reject } = pagePending.get(msg.id);
        pagePending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        handlePageEvent(targetId, msg.method, msg.params);
      }
    });
    ws.on("error", reject);
    ws.on("close", () => {
      pageConnections.delete(targetId);
      enabledDomains.delete(targetId);
    });
    setTimeout(() => reject(new Error("Page connection timeout")), 5000);
  });
}

async function sendPage(targetId, method, params = {}) {
  const ws = await getPageWs(targetId);
  const id = ws._cmdId++;
  return new Promise((resolve, reject) => {
    ws._pagePending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (ws._pagePending.has(id)) {
        ws._pagePending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, 30000);
  });
}

async function sendPageWithTimeout(targetId, method, params = {}, timeout = 30000) {
  const ws = await getPageWs(targetId);
  const id = ws._cmdId++;
  return new Promise((resolve, reject) => {
    ws._pagePending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (ws._pagePending.has(id)) {
        ws._pagePending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, timeout);
  });
}

// --- Arc AppleScript Bridge ---

function getArcTabs() {
  try {
    const script = `tell application "Arc"
  set titles to title of every tab of front window
  set urls to URL of every tab of front window
  set locs to location of every tab of front window
  set ids to id of every tab of front window
  set output to ""
  repeat with i from 1 to count of titles
    set output to output & (item i of locs) & "|||" & (item i of titles) & "|||" & (item i of urls) & "|||" & (item i of ids) & linefeed
  end repeat
  return output
end tell`;
    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 10000,
      encoding: "utf-8",
    }).trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line) => {
      const [location, title, url, arcId] = line.split("|||");
      return { location, title, url, arcId };
    });
  } catch (e) {
    throw new Error(`Failed to query Arc via AppleScript: ${e.message}`);
  }
}

function getArcActiveTab() {
  try {
    const raw = execSync(
      `osascript -e 'tell application "Arc" to get {title, URL, location} of active tab of front window'`,
      { timeout: 5000, encoding: "utf-8" }
    ).trim();
    const parts = raw.split(", ");
    // location is last, URL is second-to-last, title is everything before
    const location = parts[parts.length - 1];
    const url = parts[parts.length - 2];
    const title = parts.slice(0, -2).join(", ");
    return { title, url, location };
  } catch {
    return null;
  }
}

function getArcSpaces() {
  try {
    const script = `tell application "Arc"
  tell front window
    set spaceCount to count of spaces
    set activeSpaceName to title of active space
    set output to ""
    repeat with i from 1 to spaceCount
      set spaceName to title of space i
      set isActive to (spaceName is activeSpaceName)
      set tabCount to count of tabs of space i
      set output to output & i & "|||" & spaceName & "|||" & isActive & "|||" & tabCount & linefeed
    end repeat
    return output
  end tell
end tell`;
    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 10000,
      encoding: "utf-8",
    }).trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line) => {
      const [index, name, active, tabCount] = line.split("|||");
      return { index: parseInt(index), name, active: active === "true", tabCount: parseInt(tabCount) };
    });
  } catch (e) {
    throw new Error(`Failed to query Arc spaces: ${e.message}`);
  }
}

function resolveSpaceIndex(space, spaces) {
  if (space === undefined || space === null) return null;
  // If number (or numeric string from MCP serialization), use directly (1-based)
  const asNum = typeof space === "number" ? space : (typeof space === "string" && /^\d+$/.test(space) ? parseInt(space, 10) : null);
  if (asNum !== null) {
    if (asNum < 1 || asNum > spaces.length) {
      throw new Error(`Space ${asNum} out of range. ${spaces.length} spaces: ${spaces.map((s) => `[${s.index}] ${s.name}`).join(", ")}`);
    }
    return asNum;
  }
  // If string, match by name (case-insensitive)
  const match = spaces.find((s) => s.name.toLowerCase() === space.toLowerCase());
  if (!match) {
    throw new Error(`Space "${space}" not found. Available: ${spaces.map((s) => `[${s.index}] ${s.name}`).join(", ")}`);
  }
  return match.index;
}

function getArcTabsBySpace(spaceNum) {
  try {
    const script = `tell application "Arc"
  tell front window
    tell space ${spaceNum}
      set titles to title of every tab
      set urls to URL of every tab
      set locs to location of every tab
      set output to ""
      repeat with i from 1 to count of titles
        set output to output & (item i of locs) & "|||" & (item i of titles) & "|||" & (item i of urls) & linefeed
      end repeat
      return output
    end tell
  end tell
end tell`;
    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 10000,
      encoding: "utf-8",
    }).trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line) => {
      const [location, title, url] = line.split("|||");
      return { location, title, url };
    });
  } catch (e) {
    throw new Error(`Failed to query tabs for space ${spaceNum}: ${e.message}`);
  }
}

// --- Helpers ---

async function getCdpPages() {
  const result = await sendBrowser("Target.getTargets");
  return result.targetInfos.filter((t) => t.type === "page");
}

function matchArcTabToCdp(arcTab, cdpPages) {
  // Match by URL — normalize trailing slashes and compare
  const normalizeUrl = (u) => u?.replace(/\/$/, "").toLowerCase();
  const arcUrl = normalizeUrl(arcTab.url);

  // Exact match first
  let match = cdpPages.find((p) => normalizeUrl(p.url) === arcUrl);
  if (match) return match.targetId;

  // Partial match — same origin + path (ignore query params for some cases)
  try {
    const arcParsed = new URL(arcTab.url);
    match = cdpPages.find((p) => {
      try {
        const cdpParsed = new URL(p.url);
        return cdpParsed.origin === arcParsed.origin && cdpParsed.pathname === arcParsed.pathname;
      } catch { return false; }
    });
    if (match) return match.targetId;
  } catch {}

  // Title match as last resort
  match = cdpPages.find((p) => p.title === arcTab.title);
  if (match) return match.targetId;

  return null;
}

function filterTabsBySection(arcTabs, section) {
  const sectionMap = {
    tab: "unpinned",
    favorite: "topApp",
    pinned: "pinned",
  };
  const arcLocation = sectionMap[section] || "unpinned";
  return arcTabs.filter((t) => t.location === arcLocation);
}

async function resolveTargetId(tab, section = "tab", space) {
  let arcTabList;
  // Always scope to a specific space — default to active space to avoid cross-space bleed
  const spaces = getArcSpaces();
  if (space !== undefined && space !== null) {
    const spaceNum = resolveSpaceIndex(space, spaces);
    arcTabList = getArcTabsBySpace(spaceNum);
  } else {
    const activeSpace = spaces.find((s) => s.active);
    arcTabList = activeSpace ? getArcTabsBySpace(activeSpace.index) : getArcTabs();
  }
  const filtered = filterTabsBySection(arcTabList, section);

  if (filtered.length === 0) {
    const spaceLabel = space ? ` in space "${space}"` : "";
    throw new Error(`No ${section} tabs found${spaceLabel} in Arc.`);
  }

  const idx = tab !== undefined ? tab : filtered.length - 1;
  if (idx < 0 || idx >= filtered.length) {
    throw new Error(
      `${section} tab ${idx} out of range. ${filtered.length} ${section} tabs open: ${filtered.map((t, i) => `[${i}] ${t.title}`).join(", ")}`
    );
  }

  const arcTab = filtered[idx];
  const cdpPages = await getCdpPages();
  const targetId = matchArcTabToCdp(arcTab, cdpPages);

  if (!targetId) {
    throw new Error(
      `Could not find CDP target for "${arcTab.title}" (${arcTab.url}). The tab may not have a page loaded.`
    );
  }

  // Don't auto-activate — let Sol keep working on whatever tab they're on.
  // Only activate when explicitly requested (e.g. arc_navigate with activate=true).

  return targetId;
}

async function closePageWs(targetId) {
  if (pageConnections.has(targetId)) {
    const ws = pageConnections.get(targetId);
    pageConnections.delete(targetId);
    enabledDomains.delete(targetId);
    try { ws.close(); } catch {}
  }
}

async function evalOnPage(targetId, expression, retried = false) {
  try {
    await sendPageWithTimeout(targetId, "Runtime.enable", {}, 5000);
  } catch (e) {
    if (!retried && e.message.includes("Timeout")) {
      await closePageWs(targetId);
      return evalOnPage(targetId, expression, true);
    }
    if (e.message.includes("Timeout")) {
      throw new Error("Page unresponsive — renderer may be crashed or frozen. Try reloading the tab in Arc.");
    }
    throw e;
  }
  const result = await sendPage(targetId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "JS evaluation error");
  }
  return result.result?.value;
}

// Section param schema used across tools
const sectionSchema = z
  .enum(["tab", "favorite", "pinned"])
  .optional()
  .default("tab")
  .describe('Section: "tab" (default, unpinned), "favorite" (top icons), "pinned"');

const spaceSchema = z
  .union([z.number(), z.string()])
  .optional()
  .describe("Space index (1-based) or name (e.g. \"Work\"). Omit to use all spaces.");

// --- MCP Server ---

const server = new McpServer({
  name: "arc-browser",
  version: "3.0.0",
});

// List tabs
server.tool(
  "arc_list_tabs",
  "List all open tabs organized by Arc section (favorites, pinned, tabs)",
  {
    section: z
      .enum(["all", "tab", "favorite", "pinned"])
      .optional()
      .default("all")
      .describe('Filter by section. "all" shows everything organized.'),
    space: spaceSchema,
  },
  async ({ section, space }) => {
    let arcTabs;
    const spaces = getArcSpaces();
    if (space !== undefined && space !== null) {
      const spaceNum = resolveSpaceIndex(space, spaces);
      arcTabs = getArcTabsBySpace(spaceNum);
    } else {
      const activeSpace = spaces.find((s) => s.active);
      arcTabs = activeSpace ? getArcTabsBySpace(activeSpace.index) : getArcTabs();
    }

    const favorites = arcTabs.filter((t) => t.location === "topApp");
    const pinned = arcTabs.filter((t) => t.location === "pinned");
    const tabs = arcTabs.filter((t) => t.location === "unpinned");

    const lines = [];

    const formatSection = (name, items, prefix) => {
      if (items.length === 0) return;
      lines.push(`── ${name} ──`);
      items.forEach((t, i) => {
        lines.push(`  [${prefix}${i}] ${t.title}`);
        lines.push(`       ${t.url}`);
      });
      lines.push("");
    };

    if (section === "all" || section === "favorite") {
      formatSection("Favorites", favorites, "F");
    }
    if (section === "all" || section === "pinned") {
      formatSection("Pinned", pinned, "P");
    }
    if (section === "all" || section === "tab") {
      formatSection("Tabs", tabs, "");
    }

    // Add active tab info
    const active = getArcActiveTab();
    if (active) {
      lines.push(`Active: ${active.title} [${active.location}]`);
    }

    return { content: [{ type: "text", text: lines.join("\n") || "No tabs found." }] };
  }
);

// List spaces
server.tool(
  "arc_list_spaces",
  "List all Arc spaces in the current window",
  {},
  async () => {
    const spaces = getArcSpaces();
    const lines = spaces.map((s) =>
      `[${s.index}] ${s.name}${s.active ? " (active)" : ""} — ${s.tabCount} tabs`
    );
    return { content: [{ type: "text", text: lines.join("\n") || "No spaces found." }] };
  }
);

// Switch space
server.tool(
  "arc_switch_space",
  "Switch to a different Arc space by name or index",
  {
    space: z.union([z.number(), z.string()]).describe("Space index (1-based) or name (e.g. \"Work\")"),
  },
  async ({ space }) => {
    const spaces = getArcSpaces();
    let spaceName;
    if (typeof space === "number") {
      const found = spaces.find((s) => s.index === space);
      if (!found) throw new Error(`Space ${space} not found. Available: ${spaces.map((s) => `[${s.index}] ${s.name}`).join(", ")}`);
      spaceName = found.name;
    } else {
      const found = spaces.find((s) => s.name.toLowerCase() === space.toLowerCase());
      if (!found) throw new Error(`Space "${space}" not found. Available: ${spaces.map((s) => `[${s.index}] ${s.name}`).join(", ")}`);
      spaceName = found.name;
    }
    try {
      const script = `tell application "Arc" to activate
delay 0.3
tell application "System Events"
  tell process "Arc"
    click menu item "${spaceName.replace(/"/g, '\\"')}" of menu "Spaces" of menu bar 1
  end tell
end tell`;
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 10000,
        encoding: "utf-8",
      });
      return { content: [{ type: "text", text: `Switched to space: ${spaceName}` }] };
    } catch (e) {
      throw new Error(`Failed to switch to space "${spaceName}": ${e.message}`);
    }
  }
);

// Navigate
server.tool(
  "arc_navigate",
  "Navigate a tab to a URL",
  {
    url: z.string().describe("URL to navigate to"),
    tab: z.number().optional().describe("Tab index (0-based) within section"),
    section: sectionSchema,
    space: spaceSchema,
    activate: z.boolean().optional().default(false).describe("Bring this tab to front after navigating"),
  },
  async ({ url, tab, section, space, activate }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await sendPage(targetId, "Page.enable");
    await sendPage(targetId, "Page.navigate", { url });
    closePageWs(targetId);
    if (activate) {
      try { await sendBrowser("Target.activateTarget", { targetId }); } catch {}
    }
    await new Promise((r) => setTimeout(r, 2000));
    return { content: [{ type: "text", text: `Navigated to ${url}` }] };
  }
);

// Click
server.tool(
  "arc_click",
  "Click an element on the page by CSS selector",
  {
    selector: z.string().describe("CSS selector"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ selector, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const clicked = await evalOnPage(
      targetId,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not_found';
        el.click();
        return 'clicked';
      })()`
    );
    if (clicked === "not_found") throw new Error(`Element not found: ${selector}`);
    return { content: [{ type: "text", text: `Clicked: ${selector}` }] };
  }
);

// Type
server.tool(
  "arc_type",
  "Type text into an input field",
  {
    selector: z.string().describe("CSS selector of the input"),
    text: z.string().describe("Text to type"),
    clear: z.boolean().optional().default(false).describe("Clear field first"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ selector, text, clear, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await evalOnPage(
      targetId,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector}');
        el.focus();
        ${clear ? "el.value = '';" : ""}
        el.value += ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
    );
    return { content: [{ type: "text", text: `Typed into ${selector}` }] };
  }
);

// Press key
server.tool(
  "arc_press_key",
  "Press a keyboard key on a page",
  {
    key: z.string().describe("Key to press (Enter, Tab, Escape, etc.)"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ key, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await sendPage(targetId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" ? 27 : 0,
    });
    await sendPage(targetId, "Input.dispatchKeyEvent", { type: "keyUp", key });
    return { content: [{ type: "text", text: `Pressed: ${key}` }] };
  }
);

// Read page content
server.tool(
  "arc_read_page",
  "Get text content or HTML of the page",
  {
    format: z.enum(["text", "html"]).optional().default("text").describe("text or html"),
    selector: z.string().optional().describe("CSS selector for specific element"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ format, selector, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const expr = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.${format === "html" ? "innerHTML" : "innerText"} || 'Element not found'`
      : `document.body.${format === "html" ? "innerHTML" : "innerText"}`;
    let content = await evalOnPage(targetId, expr);
    if (typeof content === "string" && content.length > 50000) {
      content = content.substring(0, 50000) + "\n\n[Truncated]";
    }
    return { content: [{ type: "text", text: content || "Empty" }] };
  }
);

// Screenshot — saves full-res file AND returns compressed image inline
server.tool(
  "arc_screenshot",
  "Take a screenshot of the current page. Returns the image so you can visually analyze the page layout, find buttons, identify form fields, etc.",
  {
    path: z.string().optional().default("/tmp/arc-screenshot.png").describe("Save path"),
    full_page: z.boolean().optional().default(false).describe("Capture full scrollable page"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ path, full_page, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await sendPage(targetId, "Page.enable");
    const params = { format: "png" };
    if (full_page) {
      const metrics = await evalOnPage(targetId, "JSON.stringify({w: document.body.scrollWidth, h: document.body.scrollHeight})");
      const { w, h } = JSON.parse(metrics);
      params.clip = { x: 0, y: 0, width: w, height: h, scale: 1 };
    }
    const result = await sendPage(targetId, "Page.captureScreenshot", params);
    // Save full-res PNG to disk
    fs.writeFileSync(path, Buffer.from(result.data, "base64"));
    // Create compressed version for inline display (max 1280px wide, JPEG q60)
    const tmpJpeg = `/tmp/arc-screenshot-preview-${Date.now()}.jpeg`;
    let inlineData = result.data;
    let mimeType = "image/png";
    try {
      execSync(`sips -Z 1280 -s format jpeg -s formatOptions 60 "${path}" --out "${tmpJpeg}" 2>/dev/null`, { timeout: 5000 });
      inlineData = fs.readFileSync(tmpJpeg).toString("base64");
      mimeType = "image/jpeg";
      fs.unlinkSync(tmpJpeg);
    } catch {
      // If sips fails, fall back to raw PNG (unlikely on macOS)
    }
    return {
      content: [
        { type: "text", text: `Screenshot saved to ${path}` },
        { type: "image", data: inlineData, mimeType },
      ],
    };
  }
);

// Click at coordinates (for screenshot-based navigation)
server.tool(
  "arc_click_at",
  "Click at specific x,y coordinates on the page. Use after taking a screenshot to click on visually identified elements.",
  {
    x: z.number().describe("X coordinate (pixels from left)"),
    y: z.number().describe("Y coordinate (pixels from top)"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ x, y, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    // Use CDP Input.dispatchMouseEvent for precise coordinate clicking
    await sendPage(targetId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await sendPage(targetId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sendPage(targetId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return { content: [{ type: "text", text: `Clicked at (${x}, ${y})` }] };
  }
);

// Execute JavaScript
server.tool(
  "arc_eval",
  "Execute JavaScript in the page and return result",
  {
    script: z.string().describe("JavaScript to execute"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ script, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const result = await evalOnPage(targetId, script);
    return { content: [{ type: "text", text: result !== undefined ? JSON.stringify(result, null, 2) : "undefined" }] };
  }
);

// New tab
server.tool(
  "arc_new_tab",
  "Open a new tab, optionally with a URL and in a specific space",
  {
    url: z.string().optional().default("about:blank").describe("URL to open"),
    space: spaceSchema,
  },
  async ({ url, space }) => {
    // Always use AppleScript to create tabs (CDP Target.createTarget doesn't respect Arc's URL routing)
    const spaces = getArcSpaces();
    let spaceNum = null;
    let spaceName = "active space";
    if (space !== undefined && space !== null) {
      spaceNum = resolveSpaceIndex(space, spaces);
      spaceName = spaces.find((s) => s.index === spaceNum)?.name || `Space ${spaceNum}`;
    } else {
      const activeSpace = spaces.find((s) => s.active);
      if (activeSpace) {
        spaceNum = activeSpace.index;
        spaceName = activeSpace.name;
      }
    }
    try {
      const escapedUrl = url.replace(/"/g, '\\"');
      const spaceBlock = spaceNum
        ? `tell space ${spaceNum}\n      make new tab with properties {URL:"${escapedUrl}"}\n    end tell`
        : `make new tab with properties {URL:"${escapedUrl}"}`;
      const script = `tell application "Arc"
  tell front window
    ${spaceBlock}
  end tell
end tell`;
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 10000,
        encoding: "utf-8",
      });
      // Wait for tab to load (don't activate — let Sol keep their current tab)
      await new Promise((r) => setTimeout(r, 1500));
      const label = spaceNum ? ` in ${spaceName}` : "";
      return { content: [{ type: "text", text: `Opened new tab${label}: ${url}` }] };
    } catch (e) {
      throw new Error(`Failed to create tab: ${e.message}`);
    }
  }
);

// Close tab
server.tool(
  "arc_close_tab",
  "Close a tab by index",
  {
    tab: z.number().describe("Tab index to close"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await sendBrowser("Target.closeTarget", { targetId });
    return { content: [{ type: "text", text: `Closed tab ${tab}` }] };
  }
);

// Switch tab (activate)
server.tool(
  "arc_switch_tab",
  "Bring a tab to the front",
  {
    tab: z.number().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await sendBrowser("Target.activateTarget", { targetId });
    return { content: [{ type: "text", text: `Switched to tab ${tab}` }] };
  }
);

// Page info
server.tool(
  "arc_page_info",
  "Get current page URL, title, and metadata",
  {
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const info = await evalOnPage(
      targetId,
      `JSON.stringify({
        url: location.href,
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || '',
        h1: document.querySelector('h1')?.innerText || ''
      })`
    );
    const parsed = JSON.parse(info);
    return {
      content: [
        {
          type: "text",
          text: `Title: ${parsed.title}\nURL: ${parsed.url}\nH1: ${parsed.h1}\nDescription: ${parsed.description}`,
        },
      ],
    };
  }
);

// Scroll
server.tool(
  "arc_scroll",
  "Scroll the page",
  {
    direction: z.enum(["up", "down", "top", "bottom"]).describe("Scroll direction"),
    amount: z.number().optional().default(500).describe("Pixels (for up/down)"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ direction, amount, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const scrollMap = {
      up: `window.scrollBy(0, -${amount})`,
      down: `window.scrollBy(0, ${amount})`,
      top: `window.scrollTo(0, 0)`,
      bottom: `window.scrollTo(0, document.body.scrollHeight)`,
    };
    await evalOnPage(targetId, scrollMap[direction]);
    return { content: [{ type: "text", text: `Scrolled ${direction}` }] };
  }
);

// Go back
server.tool(
  "arc_go_back",
  "Navigate back in history",
  {
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await evalOnPage(targetId, "history.back()");
    await new Promise((r) => setTimeout(r, 1000));
    const url = await evalOnPage(targetId, "location.href");
    return { content: [{ type: "text", text: `Went back to: ${url}` }] };
  }
);

// Go forward
server.tool(
  "arc_go_forward",
  "Navigate forward in history",
  {
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await evalOnPage(targetId, "history.forward()");
    await new Promise((r) => setTimeout(r, 1000));
    const url = await evalOnPage(targetId, "location.href");
    return { content: [{ type: "text", text: `Went forward to: ${url}` }] };
  }
);

// Wait for element
server.tool(
  "arc_wait_for",
  "Wait for an element to appear on the page",
  {
    selector: z.string().describe("CSS selector to wait for"),
    timeout: z.number().optional().default(10000).describe("Max wait ms"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ selector, timeout, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await evalOnPage(
        targetId,
        `!!document.querySelector(${JSON.stringify(selector)})`
      );
      if (found) return { content: [{ type: "text", text: `Found: ${selector}` }] };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Timeout waiting for: ${selector}`);
  }
);

// Scrape multiple URLs in one shot
server.tool(
  "arc_scrape_urls",
  "Visit multiple URLs and extract content from each — much faster than navigating one at a time",
  {
    urls: z.array(z.string()).describe("List of URLs to scrape"),
    extract: z
      .string()
      .optional()
      .default("text")
      .describe('What to extract: "text" (default), "html", or a JS expression that returns a value'),
    space: spaceSchema,
    delay: z.number().optional().default(1500).describe("Ms to wait between pages for loading (default 1500)"),
  },
  async ({ urls, extract, space, delay }) => {
    const spaces = getArcSpaces();
    let spaceNum = null;
    if (space !== undefined && space !== null) {
      spaceNum = resolveSpaceIndex(space, spaces);
    } else {
      const activeSpace = spaces.find((s) => s.active);
      if (activeSpace) spaceNum = activeSpace.index;
    }

    // Snapshot CDP targets before opening new tab
    const beforeTargets = new Set((await getCdpPages()).map((p) => p.targetId));

    // Open a new tab to work in
    const openScript = `tell application "Arc"
  tell front window
    ${spaceNum ? `tell space ${spaceNum}\n      make new tab with properties {URL:"about:blank"}\n    end tell` : `make new tab with properties {URL:"about:blank"}`}
  end tell
end tell`;
    execSync(`osascript -e '${openScript.replace(/'/g, "'\\''")}'`, { timeout: 10000, encoding: "utf-8" });
    await new Promise((r) => setTimeout(r, 1500));

    // Find the NEW tab by diffing CDP targets
    const afterTargets = await getCdpPages();
    const newTarget = afterTargets.find((p) => !beforeTargets.has(p.targetId));
    let targetId = newTarget?.targetId;

    if (!targetId) {
      // Fallback — try to find about:blank
      const blankPage = afterTargets.find((p) => p.url === "about:blank");
      if (blankPage) targetId = blankPage.targetId;
      else throw new Error("Could not find new tab for scraping");
    }

    const results = [];

    for (const url of urls) {
      try {
        // Navigate
        await sendPage(targetId, "Page.enable");
        await sendPage(targetId, "Page.navigate", { url });
        await new Promise((r) => setTimeout(r, delay));

        // Activate so Sol can watch
        try { await sendBrowser("Target.activateTarget", { targetId }); } catch {}

        // Extract content
        let expr;
        if (extract === "text") {
          expr = "document.body.innerText";
        } else if (extract === "html") {
          expr = "document.body.innerHTML";
        } else {
          expr = extract;
        }

        let content = await evalOnPage(targetId, expr);
        if (typeof content === "string" && content.length > 15000) {
          content = content.substring(0, 15000) + "\n[Truncated]";
        }

        const title = await evalOnPage(targetId, "document.title");
        results.push({ url, title, content, error: null });
      } catch (e) {
        results.push({ url, title: null, content: null, error: e.message });
      }
    }

    // Close working tab
    try { await sendBrowser("Target.closeTarget", { targetId }); } catch {}

    const output = results
      .map((r, i) => {
        if (r.error) return `## [${i + 1}] ${r.url}\n**Error:** ${r.error}`;
        return `## [${i + 1}] ${r.title}\n**URL:** ${r.url}\n\n${r.content}`;
      })
      .join("\n\n---\n\n");

    return { content: [{ type: "text", text: output }] };
  }
);

// Google search + auto-scrape top results
server.tool(
  "arc_search_and_scrape",
  "Google a query, then automatically visit and scrape the top N results. Returns structured content from each.",
  {
    query: z.string().describe("Google search query"),
    top: z.number().optional().default(3).describe("How many top results to scrape (default 3)"),
    extract: z
      .string()
      .optional()
      .default("text")
      .describe('What to extract from each page: "text" (default), "html", or a JS expression'),
    space: spaceSchema,
  },
  async ({ query, top, extract, space }) => {
    const spaces = getArcSpaces();
    let spaceNum = null;
    if (space !== undefined && space !== null) {
      spaceNum = resolveSpaceIndex(space, spaces);
    } else {
      const activeSpace = spaces.find((s) => s.active);
      if (activeSpace) spaceNum = activeSpace.index;
    }

    // Snapshot CDP targets before opening new tab
    const beforeTargets = new Set((await getCdpPages()).map((p) => p.targetId));

    // Open a tab and search Google
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const openScript = `tell application "Arc"
  tell front window
    ${spaceNum ? `tell space ${spaceNum}\n      make new tab with properties {URL:"${searchUrl}"}\n    end tell` : `make new tab with properties {URL:"${searchUrl}"}`}
  end tell
end tell`;
    execSync(`osascript -e '${openScript.replace(/'/g, "'\\''")}'`, { timeout: 10000, encoding: "utf-8" });
    await new Promise((r) => setTimeout(r, 2000));

    // Find the NEW tab by diffing CDP targets
    const afterTargets = await getCdpPages();
    const newTarget = afterTargets.find((p) => !beforeTargets.has(p.targetId));
    let targetId = newTarget?.targetId;

    if (!targetId) {
      const googlePage = afterTargets.find((p) => p.url?.includes("google.com/search"));
      if (googlePage) targetId = googlePage.targetId;
      else throw new Error("Could not find Google search tab");
    }

    // Activate so Sol can see
    try { await sendBrowser("Target.activateTarget", { targetId }); } catch {}

    // Extract search result links via JS
    const linksJson = await evalOnPage(
      targetId,
      `JSON.stringify(
        [...document.querySelectorAll('div.g a[href], div[data-header-feature] a[href]')]
          .map(a => ({ title: a.innerText.trim(), href: a.href }))
          .filter(l => l.href.startsWith('http') && !l.href.includes('google.com') && l.title.length > 3)
          .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i)
          .slice(0, ${top + 5})
      )`
    );

    let links;
    try {
      links = JSON.parse(linksJson).slice(0, top);
    } catch {
      // Fallback: try broader selector
      const fallbackJson = await evalOnPage(
        targetId,
        `JSON.stringify(
          [...document.querySelectorAll('a[href]')]
            .map(a => ({ title: a.innerText.trim(), href: a.href }))
            .filter(l => l.href.startsWith('http') && !l.href.includes('google.com') && !l.href.includes('youtube.com') && l.title.length > 5)
            .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i)
            .slice(0, ${top})
        )`
      );
      links = JSON.parse(fallbackJson);
    }

    if (!links || links.length === 0) {
      await sendBrowser("Target.closeTarget", { targetId });
      throw new Error("No search results found — Google may have shown a CAPTCHA or different layout");
    }

    // Now visit each result and scrape
    const results = [];
    for (const link of links) {
      try {
        await sendPage(targetId, "Page.navigate", { url: link.href });
        await new Promise((r) => setTimeout(r, 2000));

        try { await sendBrowser("Target.activateTarget", { targetId }); } catch {}

        let expr;
        if (extract === "text") {
          expr = "document.body.innerText";
        } else if (extract === "html") {
          expr = "document.body.innerHTML";
        } else {
          expr = extract;
        }

        let content = await evalOnPage(targetId, expr);
        if (typeof content === "string" && content.length > 15000) {
          content = content.substring(0, 15000) + "\n[Truncated]";
        }

        const pageTitle = await evalOnPage(targetId, "document.title");
        results.push({ searchTitle: link.title, url: link.href, pageTitle, content, error: null });
      } catch (e) {
        results.push({ searchTitle: link.title, url: link.href, pageTitle: null, content: null, error: e.message });
      }
    }

    // Close working tab
    try { await sendBrowser("Target.closeTarget", { targetId }); } catch {}

    const output = results
      .map((r, i) => {
        if (r.error) return `## [${i + 1}] ${r.searchTitle}\n**URL:** ${r.url}\n**Error:** ${r.error}`;
        return `## [${i + 1}] ${r.pageTitle}\n**URL:** ${r.url}\n\n${r.content}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `**Query:** ${query}\n**Results scraped:** ${results.filter((r) => !r.error).length}/${links.length}\n\n${output}`,
        },
      ],
    };
  }
);

// --- DevTools: Network ---

server.tool(
  "arc_network",
  "List captured network requests for a tab. Auto-starts monitoring on first call. Use to debug API calls, check assets, find errors.",
  {
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
    type: z.string().optional().describe('Filter by resource type: XHR, Fetch, Document, Stylesheet, Script, Image, Font, etc.'),
    clear: z.boolean().optional().default(false).describe("Clear captured data instead of listing"),
  },
  async ({ tab, section, space, type, clear }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await ensureDomain(targetId, "Network");

    if (clear) {
      networkData.delete(targetId);
      return { content: [{ type: "text", text: "Network data cleared." }] };
    }

    const store = networkData.get(targetId);
    if (!store || store.size === 0) {
      return { content: [{ type: "text", text: "No network requests captured yet. Navigate or interact with the page, then call again." }] };
    }

    let requests = [...store.values()];
    if (type) {
      requests = requests.filter((r) => r.resourceType?.toLowerCase() === type.toLowerCase());
    }

    const lines = requests.map((r, i) => {
      const status = r.response ? r.response.status : r.failed ? "FAIL" : "...";
      const size = r.response?.contentLength ? ` ${r.response.contentLength}B` : "";
      return `[${i}] ${r.method} ${status} ${r.resourceType || ""} ${r.url}${size}`;
    });

    return { content: [{ type: "text", text: `${requests.length} requests:\n${lines.join("\n")}` }] };
  }
);

server.tool(
  "arc_network_detail",
  "Get full details of a network request — headers, body, response. Use index from arc_network output.",
  {
    index: z.number().describe("Request index from arc_network output"),
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ index, tab, section, space }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const store = networkData.get(targetId);
    if (!store || store.size === 0) throw new Error("No network data. Call arc_network first.");

    const entries = [...store.values()];
    if (index < 0 || index >= entries.length) throw new Error(`Index ${index} out of range (${entries.length} requests).`);
    const entry = entries[index];

    // Try to get response body
    let responseBody = null;
    if (entry.finished && !entry.failed) {
      try {
        const bodyResult = await sendPage(targetId, "Network.getResponseBody", { requestId: entry.requestId });
        responseBody = bodyResult.body;
        if (bodyResult.base64Encoded) responseBody = `[Base64 encoded, ${responseBody.length} chars]`;
        if (responseBody && responseBody.length > 10000) responseBody = responseBody.substring(0, 10000) + "\n[Truncated]";
      } catch {}
    }

    const parts = [
      `**${entry.method} ${entry.url}**`,
      `Resource Type: ${entry.resourceType}`,
      `\n**Request Headers:**`,
      ...Object.entries(entry.headers || {}).map(([k, v]) => `  ${k}: ${v}`),
    ];
    if (entry.postData) parts.push(`\n**Request Body:**\n${entry.postData}`);
    if (entry.response) {
      parts.push(`\n**Response:** ${entry.response.status} ${entry.response.statusText}`);
      parts.push(`MIME: ${entry.response.mimeType}`);
      parts.push(`**Response Headers:**`);
      parts.push(...Object.entries(entry.response.headers || {}).map(([k, v]) => `  ${k}: ${v}`));
    }
    if (entry.failed) parts.push(`\n**FAILED:** ${entry.failReason}`);
    if (responseBody) parts.push(`\n**Response Body:**\n${responseBody}`);

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// --- DevTools: Console ---

server.tool(
  "arc_console",
  "List captured console messages (logs, errors, warnings) for a tab. Auto-starts capturing on first call.",
  {
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
    level: z.string().optional().describe('Filter by level: log, error, warning, info, debug'),
    clear: z.boolean().optional().default(false).describe("Clear captured messages"),
  },
  async ({ tab, section, space, level, clear }) => {
    const targetId = await resolveTargetId(tab, section, space);
    await ensureDomain(targetId, "Runtime");
    await ensureDomain(targetId, "Log");

    if (clear) {
      consoleData.delete(targetId);
      return { content: [{ type: "text", text: "Console data cleared." }] };
    }

    const store = consoleData.get(targetId);
    if (!store || store.length === 0) {
      return { content: [{ type: "text", text: "No console messages captured yet. Interact with the page, then call again." }] };
    }

    let messages = [...store];
    if (level) {
      messages = messages.filter((m) => m.type === level);
    }

    const lines = messages.map((m) => {
      const loc = m.stackTrace ? ` (${m.stackTrace.url}:${m.stackTrace.lineNumber})` : m.url ? ` (${m.url})` : "";
      return `[${m.type.toUpperCase()}] ${m.text}${loc}`;
    });

    return { content: [{ type: "text", text: `${messages.length} messages:\n${lines.join("\n")}` }] };
  }
);

// --- DevTools: Emulation ---

server.tool(
  "arc_emulate",
  "Emulate a device — set viewport, mobile mode, dark theme, network/CPU throttling. Call with reset=true to clear.",
  {
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
    viewport: z.string().optional().describe('Viewport as "WIDTHxHEIGHT" (e.g. "375x812" for iPhone, "1440x900" for desktop)'),
    mobile: z.boolean().optional().describe("Enable mobile emulation (touch events, mobile UA)"),
    darkMode: z.boolean().optional().describe("Enable dark color scheme"),
    networkThrottle: z
      .enum(["offline", "slow3g", "fast3g", "4g", "none"])
      .optional()
      .describe("Network throttling preset"),
    cpuThrottle: z.number().optional().describe("CPU slowdown multiplier (e.g. 4 = 4x slower)"),
    userAgent: z.string().optional().describe("Custom user agent string"),
    reset: z.boolean().optional().default(false).describe("Reset all emulation to defaults"),
  },
  async ({ tab, section, space, viewport, mobile, darkMode, networkThrottle, cpuThrottle, userAgent, reset }) => {
    const targetId = await resolveTargetId(tab, section, space);
    const changes = [];

    if (reset) {
      try { await sendPage(targetId, "Emulation.clearDeviceMetricsOverride"); } catch {}
      try { await sendPage(targetId, "Emulation.setUserAgentOverride", { userAgent: "" }); } catch {}
      try {
        await ensureDomain(targetId, "Network");
        await sendPage(targetId, "Network.emulateNetworkConditions", {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        });
      } catch {}
      try { await sendPage(targetId, "Emulation.setCPUThrottlingRate", { rate: 1 }); } catch {}
      try { await sendPage(targetId, "Emulation.setEmulatedMedia", { features: [] }); } catch {}
      return { content: [{ type: "text", text: "Emulation reset to defaults." }] };
    }

    if (viewport) {
      const [w, h] = viewport.split("x").map(Number);
      if (!w || !h) throw new Error('Viewport format: "WIDTHxHEIGHT" (e.g. "375x812")');
      await sendPage(targetId, "Emulation.setDeviceMetricsOverride", {
        width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile,
      });
      changes.push(`viewport: ${w}x${h}`);
    } else if (mobile !== undefined) {
      const metrics = await evalOnPage(targetId, "JSON.stringify({w: window.innerWidth, h: window.innerHeight})");
      const { w, h } = JSON.parse(metrics);
      await sendPage(targetId, "Emulation.setDeviceMetricsOverride", {
        width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile,
      });
      changes.push(`mobile: ${mobile}`);
    }

    if (userAgent) {
      await sendPage(targetId, "Emulation.setUserAgentOverride", { userAgent });
      changes.push("custom UA");
    } else if (mobile) {
      await sendPage(targetId, "Emulation.setUserAgentOverride", {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      });
      changes.push("mobile UA");
    }

    if (darkMode !== undefined) {
      await sendPage(targetId, "Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: darkMode ? "dark" : "light" }],
      });
      changes.push(`dark mode: ${darkMode}`);
    }

    const networkPresets = {
      offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
      slow3g: { offline: false, latency: 2000, downloadThroughput: (50 * 1024) / 8, uploadThroughput: (50 * 1024) / 8 },
      fast3g: { offline: false, latency: 562, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
      "4g": { offline: false, latency: 20, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 },
      none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    };
    if (networkThrottle) {
      await ensureDomain(targetId, "Network");
      await sendPage(targetId, "Network.emulateNetworkConditions", networkPresets[networkThrottle]);
      changes.push(`network: ${networkThrottle}`);
    }

    if (cpuThrottle) {
      await sendPage(targetId, "Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
      changes.push(`CPU: ${cpuThrottle}x`);
    }

    if (changes.length === 0) {
      return { content: [{ type: "text", text: "No changes specified. Use viewport, mobile, darkMode, networkThrottle, cpuThrottle, or reset." }] };
    }

    return { content: [{ type: "text", text: `Emulation: ${changes.join(", ")}` }] };
  }
);

// --- DevTools: Lighthouse ---

server.tool(
  "arc_lighthouse",
  "Run a Lighthouse audit (accessibility, SEO, best practices, performance) on a URL or current tab",
  {
    url: z.string().optional().describe("URL to audit (defaults to current tab)"),
    categories: z
      .array(z.enum(["accessibility", "seo", "best-practices", "performance"]))
      .optional()
      .default(["accessibility", "seo", "best-practices"])
      .describe("Audit categories"),
    device: z.enum(["desktop", "mobile"]).optional().default("desktop"),
    save: z.string().optional().describe("Path to save HTML report"),
    tab: z.number().optional().describe("Tab index (to get URL from)"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ url, categories, device, save, tab, section, space }) => {
    let lighthouse;
    try {
      lighthouse = (await import("lighthouse")).default;
    } catch {
      throw new Error("Lighthouse not installed. Run: cd ~/Projects/arc-mcp && npm install lighthouse");
    }

    if (!url) {
      const targetId = await resolveTargetId(tab, section, space);
      url = await evalOnPage(targetId, "location.href");
    }

    const flags = {
      port: CDP_PORT,
      onlyCategories: categories,
      output: save ? ["json", "html"] : ["json"],
      formFactor: device,
    };

    if (device === "desktop") {
      flags.screenEmulation = { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false };
      flags.throttling = { cpuSlowdownMultiplier: 1, throughputKbps: 0, requestLatencyMs: 0 };
    }

    const result = await lighthouse(url, flags);

    if (save && result.report) {
      const htmlReport = Array.isArray(result.report) ? result.report[1] : result.report;
      fs.writeFileSync(save, htmlReport);
    }

    const lhr = result.lhr;
    const scores = Object.entries(lhr.categories)
      .map(([, cat]) => `**${cat.title}:** ${Math.round(cat.score * 100)}/100`)
      .join("\n");

    const issues = Object.values(lhr.audits)
      .filter((a) => a.score !== null && a.score < 1 && a.details?.items?.length > 0)
      .sort((a, b) => (a.score || 0) - (b.score || 0))
      .slice(0, 10)
      .map((a) => `- [${a.score === 0 ? "FAIL" : "WARN"}] ${a.title}: ${a.displayValue || ""}`)
      .join("\n");

    const output = `## Lighthouse: ${url}\n\n${scores}\n\n### Top Issues:\n${issues || "None!"}${save ? `\n\nReport: ${save}` : ""}`;
    return { content: [{ type: "text", text: output }] };
  }
);

// --- DevTools: Performance Traces ---

server.tool(
  "arc_trace_start",
  "Start recording a performance trace. Interact with the page, then call arc_trace_stop.",
  {
    tab: z.number().optional().describe("Tab index"),
    section: sectionSchema,
    space: spaceSchema,
  },
  async ({ tab, section, space }) => {
    if (activeTrace) throw new Error("Trace already running. Call arc_trace_stop first.");

    const targetId = await resolveTargetId(tab, section, space);
    activeTrace = { targetId, chunks: [], startTime: Date.now(), complete: false };

    await sendPage(targetId, "Tracing.start", {
      categories: "devtools.timeline,v8.execute,blink.console,blink.user_timing,loading,latencyInfo,devtools.screenshot",
      transferMode: "ReportEvents",
    });

    return { content: [{ type: "text", text: "Trace started. Interact with the page, then call arc_trace_stop." }] };
  }
);

server.tool(
  "arc_trace_stop",
  "Stop the performance trace and save to file. Open in Chrome DevTools Performance tab.",
  {
    save: z.string().optional().default("/tmp/arc-trace.json").describe("Path to save trace JSON"),
  },
  async ({ save }) => {
    if (!activeTrace) throw new Error("No active trace. Call arc_trace_start first.");

    const { targetId, startTime } = activeTrace;
    await sendPage(targetId, "Tracing.end");

    // Wait for trace data to arrive
    const waitStart = Date.now();
    while (!activeTrace.complete && Date.now() - waitStart < 10000) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const traceData = { traceEvents: activeTrace.chunks };
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    fs.writeFileSync(save, JSON.stringify(traceData));
    const sizeMb = (fs.statSync(save).size / 1024 / 1024).toFixed(1);

    activeTrace = null;

    return { content: [{ type: "text", text: `Trace saved: ${save} (${sizeMb}MB, ${duration}s)\nOpen in Chrome → DevTools → Performance → Load profile.` }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
