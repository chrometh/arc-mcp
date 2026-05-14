// lib/tools.js — tool implementations used by index.js.
//
// v3 changes:
//   - Agent-pin aware: auto-pin on navigate/newTab; ops target pin first.
//   - No bringToFront() by default — never steals user focus.
//   - Tab list enriched with space, location (favorite/pinned/today), loaded.
//   - Close refuses pinned/topApp without { force: true }.
//   - New tools: active_tab, pin, unpin, list_favorites, list_pinned, wake_tab, tab_status.
//   - Snapshot caps + AX tree node limit.
//   - Lighthouse import memoized.
//   - Screenshot cleanup on startup.
//   - Eager console/network attach (via attach.js _internal hook).

import {
  getBrowser, getActiveContext, listPages, getActivePage, getCDPSession, resolvePage,
  pinPage, unpinPage, getPinnedPage, _internal,
} from "./attach.js";
import { resolveLocator } from "./locators.js";
import { pageSnapshot, pageInfo } from "./snapshot.js";
import { listSpacesOsa, focusSpace, activeTabViaOsa, activeSpace } from "./osa.js";
import * as sidebar from "./sidebar.js";
import { writeFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DEFAULT_TIMEOUT = 10_000;
const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// One-time housekeeping: drop screenshots older than 24h.
(function cleanupOldScreenshots() {
  try {
    const dir = tmpdir();
    const cutoff = Date.now() - SCREENSHOT_TTL_MS;
    for (const f of readdirSync(dir)) {
      if (!/^arc-(screenshot|trace|lighthouse)-\d+\.(png|json)$/.test(f)) continue;
      const full = join(dir, f);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {}
    }
  } catch {}
})();

// ─── Per-page console + network buffers (eagerly attached on every page) ─────

const consoleBuffers = new WeakMap();
const networkBuffers = new WeakMap();
const networkDetailsBuffers = new WeakMap();

function attachBuffers(page) {
  if (consoleBuffers.has(page)) return;
  const cb = [];
  const nb = [];
  const nd = new Map();
  consoleBuffers.set(page, cb);
  networkBuffers.set(page, nb);
  networkDetailsBuffers.set(page, nd);

  page.on("console", msg => {
    cb.push({ type: msg.type(), text: msg.text(), timestamp: Date.now() });
    if (cb.length > 500) cb.shift();
  });
  page.on("pageerror", err => {
    cb.push({ type: "error", text: err.message, timestamp: Date.now() });
    if (cb.length > 500) cb.shift();
  });
  page.on("request", req => {
    const entry = { requestId: req._guid ?? String(Math.random()), method: req.method(), url: req.url(), status: null, timestamp: Date.now() };
    nb.push(entry);
    nd.set(entry.requestId, { request: { method: req.method(), url: req.url(), headers: req.headers(), postData: req.postData() }, response: null });
    if (nb.length > 500) {
      const dropped = nb.shift();
      if (dropped) nd.delete(dropped.requestId);
    }
  });
  page.on("response", async res => {
    const url = res.url();
    const entry = [...nb].reverse().find(e => e.url === url && e.status === null);
    if (entry) entry.status = res.status();
    const key = entry?.requestId;
    if (key && nd.has(key)) {
      const det = nd.get(key);
      try {
        det.response = { status: res.status(), headers: await res.allHeaders(), url: res.url() };
      } catch {}
    }
  });
}

// Register the hook so attach.js auto-attaches buffers as Arc opens new pages.
_internal.setOnPageOpen(attachBuffers);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const INTERNAL_URL_PREFIXES = ["chrome://", "chrome-extension://", "devtools://", "about:"];

function isInternalUrl(u) {
  return !u || INTERNAL_URL_PREFIXES.some(p => u.startsWith(p));
}

function tagSidebar(url) {
  try { return sidebar.tagUrl(url); }
  catch { return { space: null, location: null }; }
}

// Tag a URL with sidebar lookup; for loaded-but-unsaved tabs, fall back to
// the currently-focused Arc space and mark location='session'. Arc opens
// new tabs in the active space, so this is correct in the 99% case.
function tagWithFallback(url, isLoaded) {
  const tag = tagSidebar(url);
  if (tag.location) return tag;
  if (!isLoaded) return tag;
  try {
    const sp = activeSpace();
    if (sp?.title) return { space: sp.title, location: "session" };
  } catch {}
  return tag;
}

// ─── Protection layer — never mutate Sol's favorites/pinned tabs ─────────────
//
// Sol's rule: favorites (sidebar topApp icons) and pinned tabs are HIS — agent
// must not touch them. Any mutating op (navigate/click/type/etc.) checks the
// resolved page; if it's a favorite/pinned AND not the explicit agent-pin,
// the op refuses with an actionable error.
//
// Escape hatches: { force: true } on any mutating tool, or `arc_pin` with
// force to explicitly authorize working on a favorite.

function pageIsProtected(url) {
  const tag = tagSidebar(url);
  return tag.location === "topApp" || tag.location === "pinned";
}

class ProtectedTabError extends Error {
  constructor(url, location) {
    super(
      `Refusing to operate on a ${location === "topApp" ? "favorite" : "pinned"} tab — these are reserved for Master Sol's use.\n` +
      `URL: ${url}\n` +
      `Options:\n` +
      `  1. arc_new_tab — open a fresh tab; agent auto-pins it as its working surface\n` +
      `  2. arc_pin { urlContains: "..." } — pin a different non-favorite tab\n` +
      `  3. Pass { force: true } if you really mean to operate on the favorite`
    );
    this.refused = true;
    this.protectedUrl = url;
    this.protectedLocation = location;
  }
}

/**
 * Like getActivePage but guards against operating on Sol's favorites/pinned.
 * If the page is the explicit agent-pin, allow (Sol authorized it).
 * Otherwise if it's a favorite/pinned, throw unless force=true.
 */
async function getMutableActivePage({ force = false } = {}) {
  const page = await getActivePage();
  const pin = getPinnedPage();
  if (pin === page) return page; // explicit pin overrides protection
  if (force) return page;
  const url = page.url();
  if (pageIsProtected(url)) {
    const tag = tagSidebar(url);
    throw new ProtectedTabError(url, tag.location);
  }
  return page;
}

// ─── Navigation ──────────────────────────────────────────────────────────────

export async function navigate({ url, waitUntil = "load", timeout = 30_000, autoPin = true, force = false }) {
  const page = await getMutableActivePage({ force });
  await page.goto(url, { waitUntil, timeout });
  if (autoPin) pinPage(page);
  const info = await pageInfo(page);
  return { ok: true, pinned: autoPin, ...info };
}

export async function goBack({ force = false } = {}) {
  const page = await getMutableActivePage({ force });
  try {
    await page.goBack({ waitUntil: "load", timeout: 5000 });
    return { ok: true, ...(await pageInfo(page)) };
  } catch (err) {
    return { ok: false, reason: "No back history or navigation did not fire", ...(await pageInfo(page)) };
  }
}

export async function goForward({ force = false } = {}) {
  const page = await getMutableActivePage({ force });
  try {
    await page.goForward({ waitUntil: "load", timeout: 5000 });
    return { ok: true, ...(await pageInfo(page)) };
  } catch (err) {
    return { ok: false, reason: "No forward history or navigation did not fire", ...(await pageInfo(page)) };
  }
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

export async function listTabs({ includeInternal = false, space } = {}) {
  const pages = await listPages();
  const osaActive = activeTabViaOsa();
  const pinned = getPinnedPage();
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (!includeInternal && isInternalUrl(p.url)) continue;
    const tag = tagWithFallback(p.url, true);
    if (space && tag.space !== space) continue;
    out.push({
      index: i,
      url: p.url,
      title: p.title,
      space: tag.space,
      location: tag.location,        // "topApp" | "pinned" | "unpinned" | "session" | null
      loaded: true,                  // by definition — Playwright sees it
      isUserActive: osaActive ? p.url === osaActive.url : false,
      isAgentPinned: pinned ? p.page === pinned : false,
    });
  }
  return { tabs: out, count: out.length };
}

export async function switchTab({ urlContains, titleContains, index, foreground = true } = {}) {
  const page = await resolvePage({ urlContains, titleContains, index });
  if (foreground) await page.bringToFront();
  else pinPage(page); // foreground=false → switch the agent-pin without yanking user focus
  return { ...(await pageInfo(page)), pinned: !foreground };
}

export async function newTab({ url, foreground = false, autoPin = true } = {}) {
  const ctx = await getActiveContext();

  // Capture user's previous foreground page so we can restore focus if the
  // caller asked for background — Arc auto-focuses CDP-spawned tabs by default.
  let priorPage = null;
  if (!foreground) {
    try {
      const osa = activeTabViaOsa({ bypassCache: true });
      if (osa?.url) {
        const all = await listPages();
        const m = all.find(p => p.url === osa.url);
        if (m) priorPage = m.page;
      }
    } catch {}
  }

  const page = await ctx.newPage();
  // Restore prior focus BEFORE goto. Playwright's ctx.newPage() calls
  // Target.createTarget without {background:true} (Playwright doesn't expose
  // that param), so Arc focuses the new tab. If we wait for goto() to finish
  // before restoring, the user sees the new tab for the full load duration.
  // Doing bringToFront() first reduces the flash to ~1 CDP roundtrip.
  // (Playwright's Page.goto does NOT call Page.bringToFront, so this is safe —
  // see crPage.js, only bringToFront() sends that command.)
  if (!foreground && priorPage) {
    try { await priorPage.bringToFront(); } catch {}
  }
  if (url) await page.goto(url, { waitUntil: "load" });
  if (foreground) await page.bringToFront();
  if (autoPin) pinPage(page);
  const info = await pageInfo(page);
  return { ok: true, pinned: autoPin, foreground, ...info };
}

export async function closeTab({ urlContains, titleContains, index, force = false } = {}) {
  // Require explicit target — never fall through to active.
  const page = await resolvePage({ urlContains, titleContains, index, requireTarget: true });
  const url = page.url();
  const tag = tagSidebar(url);
  if (!force && (tag.location === "topApp" || tag.location === "pinned")) {
    return {
      ok: false,
      refused: true,
      reason: `Tab is ${tag.location === "topApp" ? "a favorite" : "pinned"} in space "${tag.space}". Pass { force: true } to close anyway.`,
      url,
      ...tag,
    };
  }
  await page.close();
  return { ok: true, closed: url, ...tag };
}

// ─── Agent-pin tools ─────────────────────────────────────────────────────────

export async function pin({ urlContains, titleContains, index, force = false } = {}) {
  let page;
  if (urlContains || titleContains || typeof index === "number") {
    page = await resolvePage({ urlContains, titleContains, index });
  } else {
    page = await getActivePage();
  }
  const url = page.url();
  if (!force && pageIsProtected(url)) {
    const tag = tagSidebar(url);
    return {
      ok: false,
      refused: true,
      reason: `Refusing to pin a ${tag.location === "topApp" ? "favorite" : "pinned"} tab — Master Sol's rule. Pass { force: true } to override.`,
      url,
      ...tag,
    };
  }
  pinPage(page);
  return { ok: true, pinned: { url, title: await page.title().catch(() => "") } };
}

export async function unpin() {
  const had = unpinPage();
  return { ok: true, hadPin: had };
}

export async function activeTab() {
  // User foreground — via osa
  const userOsa = activeTabViaOsa();
  const userSpace = activeSpace();
  const user = userOsa ? {
    url: userOsa.url,
    title: userOsa.title,
    location: userOsa.location,
    space: userSpace?.title || null,
  } : null;

  // Agent pin
  const pinned = getPinnedPage();
  const agent = pinned ? {
    url: pinned.url(),
    title: await pinned.title().catch(() => ""),
    pinned: true,
    ...tagWithFallback(pinned.url(), true),
  } : null;

  return { user, agent };
}

// ─── Sidebar-aware tools (favorites + pinned across spaces) ──────────────────

export async function listFavorites({ space } = {}) {
  const all = sidebar.allFavorites();
  const filtered = space ? all.filter(t => t.space === space) : all;
  // Cross-reference loaded state
  const pages = await listPages();
  const loadedUrls = new Set(pages.map(p => p.url));
  return {
    favorites: filtered.map(t => ({ ...t, loaded: loadedUrls.has(t.url) })),
    count: filtered.length,
  };
}

export async function listPinned({ space } = {}) {
  const all = sidebar.allPinned();
  const filtered = space ? all.filter(t => t.space === space) : all;
  const pages = await listPages();
  const loadedUrls = new Set(pages.map(p => p.url));
  return {
    pinned: filtered.map(t => ({ ...t, loaded: loadedUrls.has(t.url) })),
    count: filtered.length,
  };
}

/**
 * Wake an unloaded favorite/pinned tab — open it via CDP without focusing.
 * Returns the now-loaded page, optionally pins as the agent's working tab.
 */
export async function wakeTab({ url, autoPin = false, force = false } = {}) {
  if (!url) throw new Error("wakeTab requires { url }");
  // Sol's rule: favorites/pinned are protected. Refuse to wake them without force.
  if (!force && pageIsProtected(url)) {
    const tag = tagSidebar(url);
    return {
      ok: false,
      refused: true,
      reason: `Refusing to wake a ${tag.location === "topApp" ? "favorite" : "pinned"} tab — Master Sol's rule. Open a new tab to the same URL via arc_new_tab instead, or pass { force: true }.`,
      url,
      ...tag,
    };
  }
  const pages = await listPages();
  const existing = pages.find(p => p.url === url);
  if (existing) {
    if (autoPin) pinPage(existing.page);
    return { ok: true, alreadyLoaded: true, url, pinned: autoPin };
  }
  // Capture user's foreground first — Arc auto-focuses CDP-spawned tabs.
  let priorPage = null;
  try {
    const osa = activeTabViaOsa({ bypassCache: true });
    if (osa?.url) {
      const m = pages.find(p => p.url === osa.url);
      if (m) priorPage = m.page;
    }
  } catch {}

  const ctx = await getActiveContext();
  const page = await ctx.newPage();
  // Same as newTab — restore prior focus BEFORE goto so the load happens in
  // background instead of the user staring at a half-loaded waking tab.
  if (priorPage) {
    try { await priorPage.bringToFront(); } catch {}
  }
  await page.goto(url, { waitUntil: "load" });
  if (autoPin) pinPage(page);
  return { ok: true, alreadyLoaded: false, url, pinned: autoPin };
}

// ─── Interactions (with Playwright auto-wait baked in) ───────────────────────

export async function click(spec = {}, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, coords, force = false, forceProtected = false } = opts;
  const page = await getMutableActivePage({ force: forceProtected });

  if (coords) {
    const { x, y, button = "left", clickCount = 1 } = coords;
    await page.mouse.click(x, y, { button, clickCount });
    return { ok: true, strategy: `mouse.click(${x}, ${y})` };
  }

  const { locator, strategy } = resolveLocator(page, spec);
  const count = await locator.count();
  if (count === 0) throw new Error(`No elements match: ${strategy}`);
  if (count > 1 && typeof spec.index !== "number" && typeof spec.nth !== "number") {
    throw new Error(`${count} elements match: ${strategy}. Disambiguate with { index: 0 } or use more specific locator.`);
  }
  await locator.click({ timeout, force });
  return { ok: true, strategy };
}

export async function type(spec, opts = {}) {
  const { text, clearFirst = true, pressEnter = false, timeout = DEFAULT_TIMEOUT, delay = 0, force = false } = opts;
  if (typeof text !== "string") throw new Error("type() requires opts.text (string)");
  const page = await getMutableActivePage({ force });
  const { locator, strategy } = resolveLocator(page, spec);
  if (clearFirst) await locator.fill("", { timeout });
  if (delay > 0) await locator.pressSequentially(text, { delay, timeout });
  else await locator.fill(text, { timeout });
  if (pressEnter) await locator.press("Enter");
  return { ok: true, strategy };
}

export async function hover(spec, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, force = false } = opts;
  const page = await getMutableActivePage({ force });
  const { locator, strategy } = resolveLocator(page, spec);
  await locator.hover({ timeout });
  return { ok: true, strategy };
}

export async function select(spec, opts = {}) {
  const { value, label, values, timeout = DEFAULT_TIMEOUT, force = false } = opts;
  const page = await getMutableActivePage({ force });
  const { locator, strategy } = resolveLocator(page, spec);
  let arg;
  if (values) arg = values.map(v => ({ value: v }));
  else if (label) arg = { label };
  else if (value) arg = { value };
  else throw new Error("select() requires opts.value or opts.label or opts.values");
  const selected = await locator.selectOption(arg, { timeout });
  return { ok: true, strategy, selected };
}

export async function check(spec, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, force = false } = opts;
  const page = await getMutableActivePage({ force });
  const { locator, strategy } = resolveLocator(page, spec);
  await locator.check({ timeout });
  return { ok: true, strategy };
}

export async function uncheck(spec, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, force = false } = opts;
  const page = await getMutableActivePage({ force });
  const { locator, strategy } = resolveLocator(page, spec);
  await locator.uncheck({ timeout });
  return { ok: true, strategy };
}

export async function pressKey({ key, locator: spec, force = false } = {}) {
  if (!key) throw new Error("pressKey requires { key } (e.g. 'Enter', 'Escape', 'Control+C')");
  const page = await getMutableActivePage({ force });
  if (spec) {
    const { locator } = resolveLocator(page, spec);
    await locator.press(key);
  } else {
    await page.keyboard.press(key);
  }
  return { ok: true };
}

export async function fillForm({ fields, force = false } = {}) {
  if (!Array.isArray(fields)) throw new Error("fillForm requires { fields: [...] }");
  // Pre-check protection once so we don't half-fill before refusing
  await getMutableActivePage({ force });
  const results = [];
  for (const f of fields) {
    try {
      if ("value" in f || "values" in f) {
        await select(f, { value: f.value, values: f.values, label: f.label, force });
        results.push({ ok: true, field: f });
      } else {
        await type(f, { text: f.text ?? "", force });
        results.push({ ok: true, field: f });
      }
    } catch (err) {
      results.push({ ok: false, field: f, error: err.message });
    }
  }
  return { results };
}

// ─── Scroll ──────────────────────────────────────────────────────────────────

export async function scroll({ to = "bottom", locator: spec, by, smooth = true, force = false } = {}) {
  const page = await getMutableActivePage({ force });

  if (spec) {
    const { locator, strategy } = resolveLocator(page, spec);
    await locator.scrollIntoViewIfNeeded();
    return { ok: true, strategy };
  }

  if (by) {
    const { x = 0, y = 0 } = by;
    await page.evaluate(({ x, y, smooth }) => {
      window.scrollBy({ left: x, top: y, behavior: smooth ? "smooth" : "instant" });
    }, { x, y, smooth });
    return { ok: true, strategy: `scrollBy(${x}, ${y})` };
  }

  const target = { top: 0, bottom: 99999999 }[to];
  if (target === undefined) throw new Error(`scroll.to must be 'top' or 'bottom'; got ${to}`);
  await page.evaluate(({ y, smooth }) => {
    window.scrollTo({ top: y, behavior: smooth ? "smooth" : "instant" });
  }, { y: target, smooth });
  return { ok: true, strategy: `scrollTo(${to})` };
}

// ─── Waits ───────────────────────────────────────────────────────────────────

export async function waitFor({ type = "load", target, timeout = 30_000 } = {}) {
  const page = await getActivePage();
  if (type === "load" || type === "domcontentloaded" || type === "networkidle") {
    await page.waitForLoadState(type === "load" ? "load" : type, { timeout });
    return { ok: true, waited: type };
  }
  if (type === "url") {
    if (!target) throw new Error("waitFor type=url requires { target: 'fragment or regex' }");
    const cur = page.url();
    const alreadyMatches = typeof target === "string"
      ? cur.includes(target)
      : (target instanceof RegExp ? target.test(cur) : false);
    if (alreadyMatches) return { ok: true, waited: "url (already matched)", url: cur };
    await page.waitForURL(target, { timeout });
    return { ok: true, waited: "url", url: page.url() };
  }
  if (type === "element") {
    if (!target) throw new Error("waitFor type=element requires { target: locator spec }");
    const { locator } = resolveLocator(page, target);
    await locator.waitFor({ timeout, state: "visible" });
    return { ok: true, waited: "element" };
  }
  if (type === "timeout") {
    const ms = Number(target) || 1000;
    await page.waitForTimeout(ms);
    return { ok: true, waited: `timeout(${ms}ms)` };
  }
  throw new Error(`Unknown waitFor type: ${type}`);
}

// ─── Snapshot + Read ─────────────────────────────────────────────────────────

export async function snapshot(opts = {}) {
  const page = await getActivePage();
  const markdown = await pageSnapshot(page, opts);
  return { markdown, ...(await pageInfo(page)) };
}

export async function readPage({ mode = "markdown" } = {}) {
  const page = await getActivePage();
  if (mode === "text") {
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return { mode, text };
  }
  if (mode === "html") {
    const html = await page.content();
    return { mode, html };
  }
  const md = await pageSnapshot(page);
  return { mode: "markdown", markdown: md };
}

export async function page_info() {
  const page = await getActivePage();
  return await pageInfo(page);
}

// ─── Screenshot ──────────────────────────────────────────────────────────────

export async function screenshot({ fullPage = false, locator: spec, savePath } = {}) {
  const page = await getActivePage();
  let png;
  if (spec) {
    const { locator } = resolveLocator(page, spec);
    png = await locator.screenshot();
  } else {
    png = await page.screenshot({ fullPage });
  }
  const outPath = savePath || join(tmpdir(), `arc-screenshot-${Date.now()}.png`);
  writeFileSync(outPath, png);
  return { ok: true, path: outPath, bytes: png.length };
}

// ─── Eval ────────────────────────────────────────────────────────────────────

export async function evalJs({ expression, args, force = false } = {}) {
  if (!expression) throw new Error("eval requires { expression } (JS source)");
  const page = await getMutableActivePage({ force });
  const result = await page.evaluate(({ src, args }) => {
    return eval(src); // eslint-disable-line no-eval
  }, { src: expression, args });
  return { result };
}

// ─── Console + Network (buffers attached eagerly via attach.js hook) ─────────

export async function getConsoleLogs({ since = 0, level } = {}) {
  const page = await getActivePage();
  attachBuffers(page); // safety net for any page that slipped through
  let logs = consoleBuffers.get(page) || [];
  if (since) logs = logs.filter(l => l.timestamp >= since);
  if (level) logs = logs.filter(l => l.type === level);
  return { logs };
}

export async function getNetworkActivity({ since = 0, urlFilter } = {}) {
  const page = await getActivePage();
  attachBuffers(page);
  let reqs = networkBuffers.get(page) || [];
  if (since) reqs = reqs.filter(r => r.timestamp >= since);
  if (urlFilter) reqs = reqs.filter(r => r.url.includes(urlFilter));
  return { requests: reqs };
}

export async function getNetworkDetail({ requestId } = {}) {
  if (!requestId) throw new Error("getNetworkDetail requires { requestId }");
  const page = await getActivePage();
  attachBuffers(page);
  const map = networkDetailsBuffers.get(page) || new Map();
  return map.get(requestId) || { error: "Unknown requestId" };
}

// ─── Emulation ───────────────────────────────────────────────────────────────

const DEVICE_PRESETS = {
  "iphone-14": { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  "iphone-se": { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "ipad": { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: false, hasTouch: true },
  "desktop": { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  "desktop-4k": { width: 2560, height: 1440, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
};

export async function emulate({ device, width, height, deviceScaleFactor, isMobile, hasTouch, userAgent } = {}) {
  const page = await getActivePage();
  let vp = null;
  if (device && DEVICE_PRESETS[device]) vp = DEVICE_PRESETS[device];
  else if (width && height) vp = { width, height, deviceScaleFactor: deviceScaleFactor ?? 1, isMobile: isMobile ?? false, hasTouch: hasTouch ?? false };
  else throw new Error(`emulate requires device name (${Object.keys(DEVICE_PRESETS).join("/")}) or {width,height}`);

  await page.setViewportSize({ width: vp.width, height: vp.height });
  const session = await getCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, mobile: !!vp.isMobile,
  });
  if (userAgent) await session.send("Emulation.setUserAgentOverride", { userAgent });
  return { ok: true, viewport: vp };
}

// ─── Spaces (sidebar.json + osascript) ───────────────────────────────────────

export async function listSpaces() {
  // Prefer the rich sidebar source (includes counts)
  try { return { spaces: sidebar.listSpaces() }; }
  catch { return listSpacesOsa(); }
}

export async function switchSpace({ name } = {}) {
  if (!name) throw new Error("switchSpace requires { name }");
  return focusSpace(name);
}

// ─── Performance trace (CDP Tracing domain) ──────────────────────────────────

let _activeTrace = null;

export async function traceStart({ categories } = {}) {
  if (_activeTrace) throw new Error("Trace already active. Call trace_stop first.");
  const page = await getActivePage();
  const session = await getCDPSession(page);
  const defaultCats = ["devtools.timeline", "v8.execute", "blink.user_timing", "loading", "latencyInfo"];
  await session.send("Tracing.start", {
    categories: (categories ?? defaultCats).join(","),
    transferMode: "ReturnAsStream",
  });
  _activeTrace = { session, startedAt: Date.now() };
  return { ok: true, startedAt: _activeTrace.startedAt };
}

export async function traceStop({ savePath } = {}) {
  if (!_activeTrace) throw new Error("No active trace. Call trace_start first.");
  const { session } = _activeTrace;
  const events = [];
  const done = new Promise((resolve, reject) => {
    session.on("Tracing.dataCollected", e => events.push(...(e.value || [])));
    session.on("Tracing.tracingComplete", () => resolve());
    setTimeout(() => reject(new Error("trace_stop timeout")), 30_000);
  });
  await session.send("Tracing.end");
  await done;
  const outPath = savePath || join(tmpdir(), `arc-trace-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ traceEvents: events }));
  const duration = Date.now() - _activeTrace.startedAt;
  _activeTrace = null;
  return { ok: true, path: outPath, events: events.length, durationMs: duration };
}

// ─── Lighthouse (memoized import) ────────────────────────────────────────────

let _lighthouseModule = null;
async function getLighthouse() {
  if (!_lighthouseModule) _lighthouseModule = (await import("lighthouse")).default;
  return _lighthouseModule;
}

export async function lighthouse({ url, formFactor = "desktop", onlyCategories, includeFullReport = false, savePath } = {}) {
  const runLighthouse = await getLighthouse();
  const urlToAudit = url || (await getActivePage()).url();
  const chromePort = Number(new URL(process.env.ARC_CDP_URL || "http://localhost:9222").port);

  const options = {
    port: chromePort,
    output: "json",
    logLevel: "error",
    onlyCategories: onlyCategories || ["performance", "accessibility", "best-practices", "seo"],
    formFactor,
    screenEmulation: formFactor === "mobile"
      ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75 }
      : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 },
  };
  const runnerResult = await runLighthouse(urlToAudit, options);
  const lhr = runnerResult?.lhr;
  if (!lhr) throw new Error("Lighthouse returned no report");

  const summary = {
    url: lhr.finalUrl,
    fetchTime: lhr.fetchTime,
    categories: {},
  };
  for (const [key, cat] of Object.entries(lhr.categories || {})) {
    summary.categories[key] = { score: cat.score, title: cat.title };
  }

  // Full LHR reports are 500KB–3MB+ (measured 557KB for the upstream sample
  // without fullPageScreenshot). Returning it inline blows the MCP response.
  // Save to disk by default; only embed if explicitly requested.
  const outPath = savePath || join(tmpdir(), `arc-lighthouse-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(lhr));
  const result = { summary, reportPath: outPath, reportBytes: statSync(outPath).size };
  if (includeFullReport) result.lhr = lhr;
  return result;
}

// ─── Scrape (background — never bringToFront) ────────────────────────────────

export async function scrapeUrls({ urls, maxPerUrl = 4000 } = {}) {
  if (!Array.isArray(urls)) throw new Error("scrapeUrls requires { urls: [...] }");
  const ctx = await getActiveContext();
  const results = [];
  for (const url of urls) {
    const p = await ctx.newPage();
    try {
      await p.goto(url, { waitUntil: "load", timeout: 30_000 });
      const text = await p.evaluate(() => document.body?.innerText ?? "");
      let title = ""; try { title = await p.title(); } catch {}
      results.push({ url, title, text: text.slice(0, maxPerUrl) });
    } catch (err) {
      results.push({ url, error: err.message });
    } finally {
      await p.close();
    }
  }
  return { results };
}
