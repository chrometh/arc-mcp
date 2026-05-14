// lib/attach.js — connection to Arc via CDP. ATTACH only, never launch/kill.
//
// Singleton browser. Auto-reconnects if the CDP socket drops.
// Never spawns Arc, never calls launch-arc.sh, never quits Arc.
//
// v3 additions:
//   - Agent-pin: an in-memory "currently being driven" page so user tab
//     switches don't hijack the agent's working tab.
//   - resolvePage falls back to pinned page when no explicit target given.
//   - Eager buffer attach (console + network) on first browser connect.

import { chromium } from "playwright-core";

const CDP_URL = process.env.ARC_CDP_URL || "http://localhost:9222";
const CONNECT_RETRIES = 3;
const RETRY_DELAY_MS = 500;

let _browser = null;
let _cdpSessions = new WeakMap(); // page → CDPSession
let _pinnedPage = null;           // agent's working tab (null = follow user)
let _pageWatchers = new WeakSet(); // pages we've already attached buffer listeners to

// Re-export for tools.js to attach console/network listeners on every new page.
export const _internal = {
  setOnPageOpen(cb) { _onPageOpen = cb; },
};
let _onPageOpen = null;

/**
 * Get (or create) a singleton Playwright Browser attached to Arc via CDP.
 * Never launches Arc. If Arc isn't reachable, throws an actionable error.
 */
export async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;

  let lastErr;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      _browser = await chromium.connectOverCDP(CDP_URL);
      _browser.on("disconnected", () => {
        _browser = null;
        _pinnedPage = null; // invalidate pin on disconnect
      });
      // Eagerly attach buffers to all current and future pages.
      for (const ctx of _browser.contexts()) {
        for (const p of ctx.pages()) attachToPage(p);
        ctx.on("page", attachToPage);
      }
      return _browser;
    } catch (err) {
      lastErr = err;
      if (attempt < CONNECT_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  const reachable = await fetch(`${CDP_URL}/json/version`).then(() => true).catch(() => false);
  if (!reachable) {
    throw new Error(
      `Arc isn't reachable on ${CDP_URL}. Arc must be running with --remote-debugging-port=9222.\n` +
      `Quick fix: run ~/Projects/arc-mcp/launch-arc.sh — idempotent, gracefully relaunches Arc with the flag.\n` +
      `Permanent fix: enable the LaunchAgent at ~/Library/LaunchAgents/com.dobby.arc-debug.plist (loads at login).`
    );
  }
  throw new Error(`Connected to ${CDP_URL} but Playwright attach failed after ${CONNECT_RETRIES} tries: ${lastErr?.message ?? lastErr}`);
}

function attachToPage(page) {
  if (_pageWatchers.has(page)) return;
  _pageWatchers.add(page);
  if (typeof _onPageOpen === "function") {
    try { _onPageOpen(page); } catch {}
  }
}

/**
 * Active context. Arc typically has one Playwright context.
 */
export async function getActiveContext() {
  const browser = await getBrowser();
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error("Arc has no contexts. Ensure at least one Arc window is open.");
  return contexts[0];
}

/**
 * List all open pages. Each entry: { page, url, title }.
 */
export async function listPages() {
  const browser = await getBrowser();
  const out = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      let title = "";
      try { title = await p.title(); } catch {}
      out.push({ page: p, url: p.url(), title });
    }
  }
  return out;
}

// ─── Agent-pin (the headline v3 fix) ─────────────────────────────────────────

/**
 * Pin a page as the agent's working tab. All subsequent ops that don't pass
 * an explicit target will run against this page, not against Arc's foreground.
 */
export function pinPage(page) {
  if (!page) throw new Error("pinPage requires a Playwright Page");
  _pinnedPage = page;
  // Drop the pin if the page closes or its renderer crashes/is discarded.
  // - "close" → Target.detachedFromTarget (normal close) — handled by Playwright crBrowser._onDetachedFromTarget
  // - "crash" → Inspector.targetCrashed (renderer died, e.g. OOM or browser-initiated discard)
  // Note: Arc's idle tab "suspension" doesn't always fire either event — the
  // CDP-resilience layer in index.js handles per-op timeout+wake for that case.
  const drop = () => { if (_pinnedPage === page) _pinnedPage = null; };
  page.once("close", drop);
  page.once("crash", drop);
  return _pinnedPage;
}

export function unpinPage() {
  const had = !!_pinnedPage;
  _pinnedPage = null;
  return had;
}

export function getPinnedPage() {
  if (_pinnedPage && !_pinnedPage.isClosed()) return _pinnedPage;
  if (_pinnedPage && _pinnedPage.isClosed()) _pinnedPage = null;
  return null;
}

// ─── Active-page resolution ──────────────────────────────────────────────────

/**
 * Resolve the page the agent should act on.
 * Priority:
 *   1. agent-pinned page (if set + still open)
 *   2. Arc's foreground tab (via osascript) matched against Playwright pages
 *   3. first non-blank page
 */
export async function getActivePage() {
  const pinned = getPinnedPage();
  if (pinned) return pinned;

  const pages = await listPages();
  if (pages.length === 0) throw new Error("No pages open in Arc.");

  const { activeTabViaOsa } = await import("./osa.js");
  const osa = activeTabViaOsa();
  if (osa?.url) {
    // Exact match first
    let match = pages.find(p => p.url === osa.url);
    if (!match) {
      // URL drift — match by host+pathname
      try {
        const target = new URL(osa.url);
        match = pages.find(p => {
          try {
            const u = new URL(p.url);
            return u.host === target.host && u.pathname === target.pathname;
          } catch { return false; }
        });
      } catch {}
    }
    if (match) return match.page;
  }

  const nonBlank = pages.find(p => p.url && !p.url.startsWith("about:") && p.url !== "chrome://newtab/");
  return (nonBlank ?? pages[0]).page;
}

/**
 * Get (or cache) a raw CDP session for a page.
 */
export async function getCDPSession(page) {
  if (_cdpSessions.has(page)) return _cdpSessions.get(page);
  const ctx = page.context();
  const session = await ctx.newCDPSession(page);
  _cdpSessions.set(page, session);
  return session;
}

/**
 * Resolve a page by URL substring, title substring, or tab index.
 * Used by arc_switch_tab, arc_close_tab, etc.
 *
 * v3: requireTarget=true means "no fallthrough to active" — caller must pass
 * one of urlContains/titleContains/index. Use this for destructive ops.
 */
export async function resolvePage({ urlContains, titleContains, index, requireTarget = false } = {}) {
  const pages = await listPages();
  if (typeof index === "number") {
    if (index < 0 || index >= pages.length) throw new Error(`Tab index ${index} out of range (0-${pages.length - 1}).`);
    return pages[index].page;
  }
  if (urlContains) {
    const match = pages.find(p => p.url.includes(urlContains));
    if (!match) throw new Error(`No open tab contains URL fragment "${urlContains}".`);
    return match.page;
  }
  if (titleContains) {
    const match = pages.find(p => p.title.toLowerCase().includes(titleContains.toLowerCase()));
    if (!match) throw new Error(`No open tab contains title fragment "${titleContains}".`);
    return match.page;
  }
  if (requireTarget) {
    throw new Error("This operation requires an explicit target: { urlContains } or { titleContains } or { index }.");
  }
  return getActivePage();
}
