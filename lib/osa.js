// lib/osa.js — AppleScript helpers for Arc UI features.
//
// Use AppleScript ONLY for things CDP/sidebar.json can't tell us:
//   - which tab Arc considers FOREGROUND right now
//   - which space is FOCUSED
//   - switching focus between spaces
//
// Everything else (favorites, pinned, today taxonomy, structure) comes from
// lib/sidebar.js (reads StorableSidebar.json — instant, mtime-cached).
//
// Bugs fixed vs v2:
//   1. Use 'focus <space>' (per Arc dictionary), not 'select' — select is a tab command.
//   2. Parse active-tab record with a sentinel delimiter (ASCII SOH 0x01), not
//      split on ", " — URLs and titles often contain commas.
//   3. Tab iteration uses id-then-resolve where needed — newer Arc breaks the
//      older `repeat with t in tabs` specifier-reuse pattern across statements.

import { execFileSync } from "child_process";

const OSA_TIMEOUT_MS = 5000;
const ACTIVE_CACHE_MS = 500; // burst-call cache for activeTab/activeSpace
const SEP = String.fromCharCode(1); // ASCII SOH — sentinel delimiter

let _activeTabCache = { at: 0, value: null };
let _activeSpaceCache = { at: 0, value: null };

function runOsa(script, timeoutMs = OSA_TIMEOUT_MS) {
  try {
    const out = execFileSync("osascript", ["-e", script], {
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out.replace(/\n$/, "") };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString?.().trim() || err.message };
  }
}

// ─── Active tab (with cache) ─────────────────────────────────────────────────

/**
 * Get Arc's foreground tab. Returns { title, url, location } or null on failure.
 * 500ms cache — most multi-call bursts hit this 5–10x.
 */
export function activeTabViaOsa({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && _activeTabCache.value && now - _activeTabCache.at < ACTIVE_CACHE_MS) {
    return _activeTabCache.value;
  }
  // id-then-resolve: in newer Arc, `active tab` returns a class-only specifier
  // that can't be queried for properties directly. We grab its id, then re-target
  // the tab via `tab id <id> of front window`.
  const script = [
    'tell application "Arc"',
    '  set d to (ASCII character 1)',
    '  set tabId to id of active tab of front window',
    '  tell tab id tabId of front window',
    '    return (title) & d & (URL) & d & (location)',
    '  end tell',
    'end tell',
  ].join("\n");
  const { ok, output } = runOsa(script);
  if (!ok) return null;
  const parts = output.split(SEP);
  if (parts.length < 2) return null;
  const value = { title: parts[0], url: parts[1], location: parts[2] || null };
  _activeTabCache = { at: now, value };
  return value;
}

/**
 * Get Arc's currently focused space. Returns { id, title } or null on failure.
 * 500ms cache.
 */
export function activeSpace({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && _activeSpaceCache.value && now - _activeSpaceCache.at < ACTIVE_CACHE_MS) {
    return _activeSpaceCache.value;
  }
  const script = [
    'tell application "Arc"',
    '  set d to (ASCII character 1)',
    '  set sId to id of active space of front window',
    '  set sTitle to ""',
    '  repeat with sp in spaces of front window',
    '    if id of sp is sId then',
    '      set sTitle to title of sp',
    '      exit repeat',
    '    end if',
    '  end repeat',
    '  return sId & d & sTitle',
    'end tell',
  ].join("\n");
  const { ok, output } = runOsa(script);
  if (!ok) return null;
  const parts = output.split(SEP);
  if (parts.length < 2) return null;
  const value = { id: parts[0], title: parts[1] };
  _activeSpaceCache = { at: now, value };
  return value;
}

// ─── Spaces — list + focus ──────────────────────────────────────────────────

/**
 * List spaces from AppleScript. (Sidebar JSON also has this — prefer that.
 * Kept for parity with the dynamic dictionary view.)
 */
export function listSpacesOsa() {
  const script = [
    'tell application "Arc"',
    '  set d to (ASCII character 1)',
    '  set output to ""',
    '  repeat with s in spaces of front window',
    '    set output to output & (id of s) & d & (title of s) & linefeed',
    '  end repeat',
    '  return output',
    'end tell',
  ].join("\n");
  const { ok, output, error } = runOsa(script);
  if (!ok) return { spaces: [], error };
  const spaces = output.split("\n").filter(Boolean).map(line => {
    const [id, title] = line.split(SEP);
    return { id, title };
  });
  return { spaces };
}

/**
 * Focus (switch to) a space by title. Uses Arc's `focus` command per dictionary.
 * v2 used `select` which is a tab command — happened to work but was wrong.
 */
export function focusSpace(spaceTitle) {
  const safe = spaceTitle.replace(/"/g, '\\"');
  const script = [
    'tell application "Arc"',
    '  set targetSpace to missing value',
    '  repeat with s in spaces of front window',
    `    if title of s is "${safe}" then`,
    '      set targetSpace to s',
    '      exit repeat',
    '    end if',
    '  end repeat',
    '  if targetSpace is missing value then',
    `    error "Space not found: ${safe}"`,
    '  end if',
    '  focus targetSpace',
    '  return "focused"',
    'end tell',
  ].join("\n");
  // Bust caches — focus changed
  _activeSpaceCache = { at: 0, value: null };
  _activeTabCache = { at: 0, value: null };
  return runOsa(script);
}

// Back-compat aliases (in case anything outside still imports the old names).
export const listSpaces = listSpacesOsa;
export const switchSpace = focusSpace;

/**
 * Reset all OSA caches. Call after any operation that may have shifted Arc focus.
 */
export function bustOsaCaches() {
  _activeTabCache = { at: 0, value: null };
  _activeSpaceCache = { at: 0, value: null };
}
