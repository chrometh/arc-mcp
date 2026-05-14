// lib/sidebar.js — read Arc's sidebar state from disk.
//
// Arc's AppleScript dictionary doesn't expose: per-space favorites, which
// space a favorite belongs to, or pinned tabs (sometimes). The truth lives
// in `~/Library/Application Support/Arc/StorableSidebar.json`, which Arc
// continuously rewrites as the sidebar changes.
//
// We mtime-cache the parse so repeat calls are nearly free.

import { readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SIDEBAR_PATH = join(homedir(), "Library", "Application Support", "Arc", "StorableSidebar.json");

let _cache = { mtimeMs: 0, parsed: null };

function loadRaw() {
  const stat = statSync(SIDEBAR_PATH);
  if (_cache.parsed && stat.mtimeMs === _cache.mtimeMs) return _cache.parsed;
  const text = readFileSync(SIDEBAR_PATH, "utf-8");
  const parsed = JSON.parse(text);
  _cache = { mtimeMs: stat.mtimeMs, parsed };
  return parsed;
}

// The "real" container is index 1 — index 0 is the global container.
// Defensive: walk and find the one with `spaces` + `items`.
function pickRealContainer(raw) {
  const containers = raw?.sidebar?.containers || [];
  return containers.find(c => c && typeof c === "object" && Array.isArray(c.spaces) && Array.isArray(c.items));
}

// Spaces are stored as a flat alternating array: [id, obj, id, obj, ...].
// We only want the obj entries.
function parseSpaces(realContainer) {
  return realContainer.spaces.filter(s => s && typeof s === "object");
}

// topAppsContainerIDs is a flat alternating array: [profile_marker, container_id, ...].
// We pair them into [{ profile, containerId }] so we can match each space's
// profile to its favorites container.
function parseTopAppsPairs(realContainer) {
  const arr = realContainer.topAppsContainerIDs || [];
  const pairs = [];
  for (let i = 0; i < arr.length; i += 2) {
    pairs.push({ profile: arr[i], containerId: arr[i + 1] });
  }
  return pairs;
}

// Resolve which favorites container a space uses, by matching its profile.
// A space's profile shape: { custom: { _0: { directoryBasename, machineID } } }
//                       or { default: true }
// topApps profile shape: same structure.
function profilesEqual(a, b) {
  if (!a || !b) return false;
  if (a.default && b.default) return true;
  const ac = a.custom?._0;
  const bc = b.custom?._0;
  if (ac && bc) {
    return ac.machineID === bc.machineID && ac.directoryBasename === bc.directoryBasename;
  }
  return false;
}

function favoritesContainerIdForSpace(space, topAppsPairs) {
  const spaceProfile = space.profile;
  for (const pair of topAppsPairs) {
    if (profilesEqual(spaceProfile, pair.profile)) return pair.containerId;
  }
  return null;
}

// Each space has containerIDs: [marker, unpinnedContainerId, marker, pinnedContainerId]
function parseContainerIds(space) {
  const out = { unpinned: null, pinned: null };
  const arr = space.containerIDs || [];
  for (let i = 0; i < arr.length; i += 2) {
    const marker = arr[i];
    const id = arr[i + 1];
    if (marker === "unpinned") out.unpinned = id;
    else if (marker === "pinned") out.pinned = id;
  }
  return out;
}

// Read a tab item — extract title + url. Tab items have data.tab.savedURL/savedTitle.
// Folder items have data.list. We treat folders as transparent containers (recurse).
function readTabItem(item, itemsById) {
  const tabData = item?.data?.tab;
  if (tabData) {
    return {
      id: item.id,
      title: item.title || tabData.savedTitle || "",
      url: tabData.savedURL || "",
      kind: "tab",
    };
  }
  // Some items may be split-view "easels" or pinned-folder containers.
  // Skip silently — caller will get just the resolved tabs.
  return null;
}

// Walk a container's children recursively, flattening folders. Returns tabs only.
function walkChildren(rootId, itemsById, depth = 0) {
  if (depth > 6) return []; // sanity guard
  const root = itemsById[rootId];
  if (!root) return [];
  const out = [];
  for (const childId of root.childrenIds || []) {
    const child = itemsById[childId];
    if (!child) continue;
    const tab = readTabItem(child, itemsById);
    if (tab) out.push(tab);
    else if ((child.childrenIds || []).length > 0) {
      // Folder — recurse, mark folder name on items
      const nested = walkChildren(childId, itemsById, depth + 1);
      for (const t of nested) {
        t.folder = child.title || t.folder;
        out.push(t);
      }
    }
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read the sidebar and return a normalized snapshot.
 * Throws a clean error if the file is missing or unparsable.
 */
export function readSidebar() {
  let raw;
  try { raw = loadRaw(); }
  catch (err) {
    throw new Error(`Could not read Arc sidebar state at ${SIDEBAR_PATH}: ${err.message}`);
  }

  const real = pickRealContainer(raw);
  if (!real) throw new Error("Arc sidebar JSON has unexpected shape — no real container found.");

  const itemsById = {};
  for (const i of real.items) {
    if (i && typeof i === "object" && i.id) itemsById[i.id] = i;
  }

  const spaces = parseSpaces(real);
  const topAppsPairs = parseTopAppsPairs(real);

  const result = {
    spaces: [],
    favoritesByUrl: {},   // url → space title (so we can tag a Playwright page)
    pinnedByUrl: {},
    unpinnedByUrl: {},
  };

  for (const space of spaces) {
    const ids = parseContainerIds(space);
    const favContainerId = favoritesContainerIdForSpace(space, topAppsPairs);

    const favorites = favContainerId ? walkChildren(favContainerId, itemsById) : [];
    const pinned = ids.pinned ? walkChildren(ids.pinned, itemsById) : [];
    const unpinned = ids.unpinned ? walkChildren(ids.unpinned, itemsById) : [];

    const spaceInfo = {
      id: space.id,
      title: space.title,
      favorites,
      pinned,
      unpinned,
    };
    result.spaces.push(spaceInfo);

    for (const t of favorites) if (t.url) result.favoritesByUrl[t.url] = space.title;
    for (const t of pinned) if (t.url) result.pinnedByUrl[t.url] = space.title;
    for (const t of unpinned) if (t.url) result.unpinnedByUrl[t.url] = space.title;
  }

  return result;
}

/**
 * Tag a URL with its sidebar location.
 * Returns { space, location } where location ∈ "topApp" | "pinned" | "unpinned" | null.
 */
export function tagUrl(url) {
  if (!url) return { space: null, location: null };
  let snap;
  try { snap = readSidebar(); } catch { return { space: null, location: null }; }

  if (snap.favoritesByUrl[url]) return { space: snap.favoritesByUrl[url], location: "topApp" };
  if (snap.pinnedByUrl[url]) return { space: snap.pinnedByUrl[url], location: "pinned" };
  if (snap.unpinnedByUrl[url]) return { space: snap.unpinnedByUrl[url], location: "unpinned" };

  // Fallback: prefix match (URLs sometimes drift via redirects, hash changes)
  for (const [u, sp] of Object.entries(snap.favoritesByUrl)) {
    if (urlsRoughlyMatch(url, u)) return { space: sp, location: "topApp" };
  }
  for (const [u, sp] of Object.entries(snap.pinnedByUrl)) {
    if (urlsRoughlyMatch(url, u)) return { space: sp, location: "pinned" };
  }
  return { space: null, location: null };
}

function urlsRoughlyMatch(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname === ub.pathname;
  } catch { return false; }
}

/**
 * Convenience accessors.
 */
export function listSpaces() {
  return readSidebar().spaces.map(s => ({
    id: s.id,
    title: s.title,
    counts: { favorites: s.favorites.length, pinned: s.pinned.length, unpinned: s.unpinned.length },
  }));
}

export function favoritesForSpace(spaceTitle) {
  const s = readSidebar().spaces.find(s => s.title === spaceTitle);
  return s ? s.favorites : [];
}

export function pinnedForSpace(spaceTitle) {
  const s = readSidebar().spaces.find(s => s.title === spaceTitle);
  return s ? s.pinned : [];
}

export function unpinnedForSpace(spaceTitle) {
  const s = readSidebar().spaces.find(s => s.title === spaceTitle);
  return s ? s.unpinned : [];
}

export function allFavorites() {
  const out = [];
  for (const s of readSidebar().spaces) {
    for (const t of s.favorites) out.push({ ...t, space: s.title });
  }
  return out;
}

export function allPinned() {
  const out = [];
  for (const s of readSidebar().spaces) {
    for (const t of s.pinned) out.push({ ...t, space: s.title });
  }
  return out;
}
