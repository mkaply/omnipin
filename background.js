"use strict";

/*
 * Omnipin — pins URLs, not tabs.
 * ------------------------------
 * Firefox pins a *tab* (a window-bound session object that drifts, carries
 * state, and dies with its window). An Omnipin pin is the *URL* you pinned —
 * a durable identity that's remembered, reopens at that URL, and can't be lost.
 *
 * Architecture (see DESIGN.md):
 *   Foundation (always on)
 *     - canonical set in storage.local — the remembered pins; never lost.
 *     - per pinned tab: a `pinId` sessions tag linking it to its set entry
 *       (its "home" URL), surviving Firefox's session restore.
 *     - Restore: materialize the set into a window on demand.
 *   Layer 1 — per-tab behaviors (work on any pinned tab; toggles)
 *     - addressBarProtection: typed nav away from home -> new tab.
 *     - openAtHome: on restart, reset pins to their home URL.
 *     - protectFromClose: closing a pin re-spawns it; only Unpin removes.
 *   Layer 2 — global (toggle)
 *     - global: auto-materialize the set into every window + keep in sync.
 *     - loadInBackground: resident copies vs. lazy (discarded, load on click).
 *
 * Defaults reproduce the original opinionated behavior, so nothing changes for
 * existing installs unless a toggle is flipped.
 */

const SESSION_KEY = "pinId";

// Settings (storage.local keys) and their defaults.
const SETTINGS_DEFAULTS = {
  global: true,
  loadInBackground: true,
  openAtHome: true,
  protectFromClose: true,
  addressBarProtection: false, // needs <all_urls>, requested on enable
};
let settings = { ...SETTINGS_DEFAULTS };

// ---- Durable + in-memory state --------------------------------------------

// Canonical set, mirrored to storage.local. Ordered by `index`.
//   { pinId, url, title, favIconUrl, cookieStoreId, index }
let canonical = [];

// windowId -> Map(pinId -> tabId): which live tab represents which pin, per window.
const windowMap = new Map();
// tabId -> { windowId, pinId }: reverse lookup (onRemoved only gives a tabId).
const tabIndex = new Map();
// tabIds we are programmatically removing, so our own onRemoved is ignored.
const suppress = new Set();
// >0 while we are injecting/reordering: any pinned-state churn is ours, not the user's.
let reconciling = 0;
// True briefly after a browser restart: reconcile resets each pin to its home
// URL instead of trusting the session-restored (wandered) URL.
let resetToHome = false;

function loadSettings() {
  return browser.storage.local.get(Object.keys(SETTINGS_DEFAULTS)).then((data) => {
    for (const k of Object.keys(SETTINGS_DEFAULTS)) {
      settings[k] = (k in data) ? data[k] : SETTINGS_DEFAULTS[k];
    }
  });
}

// Load settings + the canonical set once before handling any event.
const ready = (async () => {
  await loadSettings();
  const data = await browser.storage.local.get("pinnedTabs");
  const stored = Array.isArray(data.pinnedTabs) ? data.pinnedTabs : [];
  // Drop stale entries we can no longer materialize (e.g. about: pages saved
  // before we started rejecting privileged URLs) so they stop erroring.
  canonical = stored.filter((e) => isManageableUrl(e.url));
  if (canonical.length !== stored.length) {
    reindex();
    await persist();
  }
})();

// ---- Small helpers ---------------------------------------------------------

function storeId(v) {
  return v || "firefox-default";
}

// Firefox lets you pin privileged pages (about:*, view-source:, chrome:) but
// blocks extensions from (re)creating them ("Illegal URL"), so we can't mirror
// them. Only manage real web pages; leave the rest as ordinary pinned tabs.
function isManageableUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

// Same page for our purposes: ignore the hash so a refresh or an in-page
// #anchor navigates in place instead of being bounced to a new tab.
function sameUrl(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch (e) {
    return a === b;
  }
}

function sameTarget(entry, tab) {
  return entry.url === tab.url && storeId(entry.cookieStoreId) === storeId(tab.cookieStoreId);
}

function register(windowId, pinId, tabId) {
  let m = windowMap.get(windowId);
  if (!m) {
    m = new Map();
    windowMap.set(windowId, m);
  }
  m.set(pinId, tabId);
  tabIndex.set(tabId, { windowId, pinId });
}

function unregister(tabId) {
  const info = tabIndex.get(tabId);
  if (!info) return;
  const m = windowMap.get(info.windowId);
  if (m && m.get(info.pinId) === tabId) m.delete(info.pinId);
  tabIndex.delete(tabId);
}

function reindex() {
  canonical.forEach((e, i) => { e.index = i; });
}

function persist() {
  return browser.storage.local.set({ pinnedTabs: canonical });
}

// Per-window serialized queue so concurrent reconciles never interleave.
const queues = new Map();
function withWindowLock(windowId, fn) {
  const prev = queues.get(windowId) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => console.error("[pin] lock", e));
  queues.set(windowId, next);
  next.finally(() => { if (queues.get(windowId) === next) queues.delete(windowId); });
  return next;
}

async function isManageableWindow(windowId) {
  try {
    const win = await browser.windows.get(windowId);
    return !win.incognito && win.type === "normal";
  } catch (e) {
    return false;
  }
}

// ---- Tab materialization ---------------------------------------------------

// Create one pinned copy of `entry` in `windowId`. Guarded by `reconciling`
// so the resulting pinned=true churn isn't mistaken for a user pinning a tab.
// `load` overrides the loadInBackground setting (respawn forces a load — see
// below). When undefined, honor the setting.
async function createPinned(windowId, entry, load) {
  const keepLoaded = (load === undefined) ? settings.loadInBackground : load;
  reconciling++;
  try {
    const props = { url: entry.url, pinned: true, windowId, active: false };
    if (storeId(entry.cookieStoreId) !== "firefox-default") props.cookieStoreId = entry.cookieStoreId;

    let tab;
    try {
      tab = await browser.tabs.create(props);
    } catch (e) {
      // e.g. privileged URLs can't be created. Don't abort the whole reconcile.
      console.error("[pin] tabs.create failed for", entry.url, e);
      return null;
    }
    register(windowId, entry.pinId, tab.id);
    await browser.sessions.setTabValue(tab.id, SESSION_KEY, entry.pinId);
    // Lazy mode (for many-window users): unload immediately, load on click.
    // Resident mode: leave it loading in the background, ready on click.
    if (!keepLoaded) {
      try { await browser.tabs.discard(tab.id); } catch (e) { /* ignore */ }
    }
    return tab;
  } finally {
    reconciling--;
  }
}

async function removeManaged(tabId) {
  suppress.add(tabId);
  try {
    await browser.tabs.remove(tabId);
  } catch (e) {
    suppress.delete(tabId);
  } finally {
    unregister(tabId);
  }
}

// Put this window's pinned copies into canonical order at indices 0..n-1.
async function reorder(windowId) {
  const m = windowMap.get(windowId);
  if (!m) return;
  reconciling++;
  try {
    let i = 0;
    for (const entry of canonical) {
      const tabId = m.get(entry.pinId);
      if (tabId == null) continue;
      try { await browser.tabs.move(tabId, { index: i }); } catch (e) { /* tab gone */ }
      i++;
    }
  } finally {
    reconciling--;
  }
}

// Reconcile one window.
//   - Always: track existing pinned tabs (adopt untagged web pins into the set,
//     register them) and, on restart, reset them to home (open-at-home).
//   - If `materialize`: also create copies for missing set entries and order
//     them. This is what Global does automatically and Restore does on demand.
async function reconcileWindow(windowId, materialize) {
  if (!(await isManageableWindow(windowId))) return;

  let win;
  try {
    win = await browser.windows.get(windowId, { populate: true });
  } catch (e) {
    return;
  }

  const present = new Map(); // pinId -> tabId
  for (const tab of win.tabs.filter((t) => t.pinned)) {
    let pinId = await browser.sessions.getTabValue(tab.id, SESSION_KEY);

    if (!pinId) {
      // Can't replicate privileged pages; leave them be.
      if (!isManageableUrl(tab.url)) continue;
      // Native pinned tab with no tag: reuse a set entry with the same target
      // (same site pinned elsewhere) or adopt it as a new pin.
      let entry = canonical.find((e) => sameTarget(e, tab));
      if (!entry) {
        entry = {
          pinId: crypto.randomUUID(),
          url: tab.url,
          title: tab.title,
          favIconUrl: tab.favIconUrl,
          cookieStoreId: tab.cookieStoreId,
          index: canonical.length,
        };
        canonical.push(entry);
        await persist();
      }
      pinId = entry.pinId;
      await browser.sessions.setTabValue(tab.id, SESSION_KEY, pinId);
    }

    if (present.has(pinId)) {
      // Duplicate copy of the same pin in this window -> drop the extra.
      await removeManaged(tab.id);
      continue;
    }
    present.set(pinId, tab.id);
    register(windowId, pinId, tab.id);

    // On restart, force the restored pin back to its home URL. Session restore
    // brings tabs back wherever they wandered; pins are URLs, not sessions.
    if (resetToHome && settings.openAtHome) {
      const entry = canonical.find((e) => e.pinId === pinId);
      if (entry && !sameUrl(tab.url, entry.url)) {
        try { await browser.tabs.update(tab.id, { url: entry.url }); } catch (e) { /* ignore */ }
      }
    }
  }

  if (!materialize) return;

  // Create copies for any set entries missing from this window, then order.
  for (const entry of canonical) {
    if (!present.has(entry.pinId)) {
      const tab = await createPinned(windowId, entry);
      if (tab) present.set(entry.pinId, tab.id);
    }
  }
  await reorder(windowId);
}

async function reconcileAll(exceptWindowId, materialize) {
  let wins;
  try {
    wins = await browser.windows.getAll();
  } catch (e) {
    console.error("[pin] windows.getAll failed", e);
    return;
  }
  for (const win of wins) {
    if (win.id === exceptWindowId) continue;
    if (win.incognito || win.type !== "normal") continue;
    await withWindowLock(win.id, () => reconcileWindow(win.id, materialize));
  }
}

// Restore the full set into one window on demand (the manual recovery action,
// and the universal "bring my pins back" path when Global is off).
async function restorePins(windowId) {
  await ready;
  if (windowId == null) {
    try { windowId = (await browser.windows.getLastFocused()).id; } catch (e) { return; }
  }
  await withWindowLock(windowId, () => reconcileWindow(windowId, true));
}

// ---- User-driven changes ---------------------------------------------------

async function adoptUserPinned(tab) {
  // Always add to the set + track the tab (persistence is the baseline).
  let entry = canonical.find((e) => sameTarget(e, tab));
  if (entry) {
    register(tab.windowId, entry.pinId, tab.id);
    await browser.sessions.setTabValue(tab.id, SESSION_KEY, entry.pinId);
  } else {
    entry = {
      pinId: crypto.randomUUID(),
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      cookieStoreId: tab.cookieStoreId,
      index: canonical.length,
    };
    canonical.push(entry);
    register(tab.windowId, entry.pinId, tab.id);
    await browser.sessions.setTabValue(tab.id, SESSION_KEY, entry.pinId);
    await persist();
  }
  // Only Global replicates into other windows; otherwise it just joins the set.
  if (settings.global) await reconcileAll(tab.windowId, true);
}

// Unpinning is the deliberate removal gesture. Drop the entry from the set and
// remove its copies from every other window. The tab the user unpinned stays
// open as an ordinary tab. Closing, by contrast, re-spawns (see onRemoved).
async function handleUnpin(tabId, info) {
  canonical = canonical.filter((e) => e.pinId !== info.pinId);
  reindex();
  await persist();

  unregister(tabId);
  try { await browser.sessions.removeTabValue(tabId, SESSION_KEY); } catch (e) { /* ignore */ }

  for (const [, m] of windowMap) {
    const tid = m.get(info.pinId);
    if (tid != null) await removeManaged(tid);
  }
}

// Re-spawn a pinned tab the user closed (protect-from-close). Only Unpin truly
// removes a pin; an accidental ✕/Ctrl+W brings it back at its home URL.
const lastRespawn = new Map(); // pinId -> timestamp, runaway guard
async function respawn(info) {
  if (!settings.protectFromClose) return;
  const entry = canonical.find((e) => e.pinId === info.pinId);
  if (!entry) return;

  const now = Date.now();
  const prev = lastRespawn.get(info.pinId) || 0;
  if (now - prev < 1000) return; // user mashing Ctrl+W: don't fight in a tight loop
  lastRespawn.set(info.pinId, now);

  await withWindowLock(info.windowId, async () => {
    if (!(await isManageableWindow(info.windowId))) return;
    const m = windowMap.get(info.windowId);
    if (m && m.has(info.pinId)) return; // already restored
    // Always load a respawn: you just closed a tab you were using; bringing it
    // back blank (lazy) would be the wrong feel for accidental-close recovery.
    await createPinned(info.windowId, entry, true);
    await reorder(info.windowId);
  });
}

// ---- Manage pins (from the options page) -----------------------------------

// Re-point a pin's home URL in place: update the stored URL but leave live
// copies where they are. New windows / Restore / restart-reset use the new URL.
async function updatePinUrl(pinId, url) {
  if (!isManageableUrl(url)) return false;
  const entry = canonical.find((e) => e.pinId === pinId);
  if (!entry) return false;
  entry.url = url;
  await persist();
  return true;
}

// Remove a pin from the set and close its copies everywhere (like Unpin).
async function removePinById(pinId) {
  canonical = canonical.filter((e) => e.pinId !== pinId);
  reindex();
  await persist();
  for (const [, m] of windowMap) {
    const tid = m.get(pinId);
    if (tid != null) await removeManaged(tid);
  }
}

// Reorder the set to match `order` (array of pinIds), then re-order live windows.
async function reorderPinsByIds(order) {
  const byId = new Map(canonical.map((e) => [e.pinId, e]));
  const next = [];
  for (const id of order) { const e = byId.get(id); if (e) { next.push(e); byId.delete(id); } }
  for (const e of byId.values()) next.push(e); // keep any not listed
  canonical = next;
  reindex();
  await persist();
  for (const [wid] of windowMap) await withWindowLock(wid, () => reorder(wid));
}

// ---- Address bar protection (Layer 1, optional) ---------------------------
//
// A top-level navigation in a tracked pinned tab with NO document origin is a
// typed/bookmark/external navigation (link clicks and in-page JS carry the page
// as originUrl). Cancel it and open the destination in a new tab, so the pin
// stays on its home page. Must stay synchronous to return {cancel}. Needs the
// <all_urls> host permission, registered only when enabled AND granted.
const PROTECT_ORIGINS = { origins: ["<all_urls>"] };
let protecting = false;

function pinAddressBarGuard(details) {
  if (details.type !== "main_frame") return;
  const info = tabIndex.get(details.tabId);
  if (!info) return;                                   // not a tracked pin
  if (details.originUrl || details.documentUrl) return; // link / JS nav: allow
  const entry = canonical.find((e) => e.pinId === info.pinId);
  if (!entry) return;
  if (sameUrl(details.url, entry.url)) return;          // refresh / same page: allow

  // Typed a different URL into the pin's address bar: divert to a new tab.
  // Open it container-less (like a normal new tab) rather than inheriting the
  // pin's container — a typed URL is fresh intent.
  browser.tabs.create({ url: details.url, active: true, windowId: info.windowId });
  return { cancel: true };
}

async function refreshAddressBarProtection() {
  const wanted = settings.addressBarProtection === true && (await browser.permissions.contains(PROTECT_ORIGINS));
  if (wanted && !protecting) {
    browser.webRequest.onBeforeRequest.addListener(
      pinAddressBarGuard,
      { urls: ["<all_urls>"], types: ["main_frame"] },
      ["blocking"]
    );
    protecting = true;
  } else if (!wanted && protecting) {
    browser.webRequest.onBeforeRequest.removeListener(pinAddressBarGuard);
    protecting = false;
  }
}

// ---- Event wiring ----------------------------------------------------------

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;

  if ("pinned" in changeInfo) {
    if (reconciling > 0) return; // our own injection churn
    if (changeInfo.pinned === true) {
      if (tabIndex.has(tabId)) return; // already tracked
      if (!(await isManageableWindow(tab.windowId))) return;
      if (!isManageableUrl(tab.url)) return; // privileged page: leave it native
      await adoptUserPinned(tab);
    } else {
      const info = tabIndex.get(tabId);
      if (info) await handleUnpin(tabId, info);
    }
  }
  // No URL drift: a pin's URL is fixed at pin time ("open at home").
});

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ready;
  const info = tabIndex.get(tabId);

  if (suppress.has(tabId)) {        // our own programmatic removal
    suppress.delete(tabId);
    unregister(tabId);
    return;
  }
  if (removeInfo.isWindowClosing) { // window teardown never touches the set
    unregister(tabId);
    return;
  }
  if (!info) return;                // not a tracked pinned tab

  unregister(tabId);
  await respawn(info); // user closed a pin directly -> bring it back (if enabled)
});

browser.windows.onCreated.addListener(async (win) => {
  await ready;
  if (win.incognito || win.type !== "normal") return;
  // Global auto-materializes into every new window; otherwise just track.
  await withWindowLock(win.id, () => reconcileWindow(win.id, settings.global));
});

browser.windows.onRemoved.addListener((windowId) => {
  const m = windowMap.get(windowId);
  if (m) {
    for (const tabId of m.values()) tabIndex.delete(tabId);
    windowMap.delete(windowId);
  }
  queues.delete(windowId);
});

// Settings live-update + side effects.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (k in changes) settings[k] = (changes[k].newValue !== undefined) ? changes[k].newValue : SETTINGS_DEFAULTS[k];
  }
  if ("addressBarProtection" in changes) refreshAddressBarProtection();
  // Turning Global on materializes the set into every window. Turning it off
  // leaves existing copies alone (we never yank live tabs).
  if ("global" in changes && changes.global.newValue === true) reconcileAll(undefined, true);
});
browser.permissions.onAdded.addListener(refreshAddressBarProtection);
browser.permissions.onRemoved.addListener(refreshAddressBarProtection);

// Messages from the popup / options page.
browser.runtime.onMessage.addListener(async (msg) => {
  await ready;
  if (!msg) return undefined;
  if (msg.type === "restore") {
    await restorePins(msg.windowId);
    return { ok: true };
  }
  if (msg.type === "clearPins") {
    canonical = [];
    windowMap.clear();
    tabIndex.clear();
    await persist();
    return { ok: true };
  }
  if (msg.type === "listPins") {
    return canonical.map((e) => ({ pinId: e.pinId, url: e.url, title: e.title, favIconUrl: e.favIconUrl }));
  }
  if (msg.type === "updatePinUrl") {
    return { ok: await updatePinUrl(msg.pinId, msg.url) };
  }
  if (msg.type === "removePin") {
    await removePinById(msg.pinId);
    return { ok: true };
  }
  if (msg.type === "reorderPins") {
    await reorderPinsByIds(msg.order);
    return { ok: true };
  }
  return undefined;
});

// ---- Startup ---------------------------------------------------------------
//
// Persistent background loads once at browser start and at install. Reconcile
// what's open (track always; materialize only when Global is on), then a second
// pass to catch windows session restore is still materializing. pinId tags keep
// both passes idempotent.
ready.then(async () => {
  await reconcileAll(undefined, settings.global);
  setTimeout(() => reconcileAll(undefined, settings.global), 1500);
  refreshAddressBarProtection();
});

browser.runtime.onInstalled.addListener(() => ready.then(() => reconcileAll(undefined, settings.global)));

// Browser restart (fires ONLY on real startup, not extension reload). Turn on
// reset-to-home while session restore materializes its windows, then off so
// navigating a pin during the session is never forced back.
browser.runtime.onStartup.addListener(() => {
  resetToHome = true;
  setTimeout(() => { resetToHome = false; }, 8000);
  ready.then(() => reconcileAll(undefined, settings.global));
  setTimeout(() => ready.then(() => reconcileAll(undefined, settings.global)), 2500);
});
