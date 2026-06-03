"use strict";

/*
 * Omnipin
 * -------
 * Pinned tabs in Firefox are owned by a single window's session, so closing
 * that window loses them. This extension removes the notion of an owning
 * window: storage.local holds the canonical pinned set, and every normal
 * window's pinned strip is just a materialized *view* of that set.
 *
 *   - Global:       the same set is injected into every normal window.
 *   - Open at home: a pin's canonical URL is fixed at pin time. Navigating a
 *                   copy moves only that tab (Firefox keeps same-domain nav in
 *                   place); new windows / restart always open the pinned URL.
 *   - Only Unpin:   closing a pinned tab (x / Ctrl+W) re-spawns it; the sole
 *                   way to remove an entry from the set is an explicit Unpin.
 *   - Persistence:  storage.local (this profile, survives restart, no Sync).
 *
 * Address bar protection (optional, off by default): typing a URL into a pin
 * opens it in a new tab instead of navigating the pin away. Needs <all_urls>,
 * so it's requested only when the user enables it in the options page.
 *
 * pinId is the LOGICAL identity of a pin and is shared by every window's copy
 * (stored as a sessions tab value so it survives Firefox's session restore).
 */

const SESSION_KEY = "pinId";

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
// True briefly after a browser restart: reconcile resets each pin to its
// canonical URL instead of trusting the session-restored (wandered) URL.
// Pins are URLs, not sessions — but only on restart, never mid-session.
let resetToHome = false;

// Load the canonical set once before handling any event.
const ready = (async () => {
  const data = await browser.storage.local.get("pinnedTabs");
  const stored = Array.isArray(data.pinnedTabs) ? data.pinnedTabs : [];
  // Drop stale entries we can no longer materialize (e.g. about: pages saved
  // before we started rejecting privileged URLs) so they stop erroring on
  // every startup.
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
// them into other windows. Only manage real web pages; leave the rest as
// ordinary native pinned tabs.
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
async function createPinned(windowId, entry) {
  reconciling++;
  try {
    // Create it loading in the background (active:false) and leave it resident,
    // so the page is ready the moment you click the pin and the favicon/title
    // come in naturally. (We can't create it pre-discarded — Firefox forbids
    // pinned + discarded — but here we want it loaded anyway.)
    const props = { url: entry.url, pinned: true, windowId, active: false };
    if (storeId(entry.cookieStoreId) !== "firefox-default") props.cookieStoreId = entry.cookieStoreId;

    let tab;
    try {
      tab = await browser.tabs.create(props);
    } catch (e) {
      // e.g. privileged URLs (about:, view-source:) can't be created. Don't let
      // one bad entry abort the whole window reconcile.
      console.error("[pin] tabs.create failed for", entry.url, e);
      return null;
    }
    register(windowId, entry.pinId, tab.id);
    await browser.sessions.setTabValue(tab.id, SESSION_KEY, entry.pinId);
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

// Make one window's pinned strip equal the canonical set, adopting any
// untagged native pinned tabs and de-duplicating copies that share a pinId
// (the latter guards against the startup/session-restore race).
async function reconcileWindow(windowId) {
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
      // Can't replicate privileged pages into other windows; leave them be.
      if (!isManageableUrl(tab.url)) continue;
      // Native pinned tab with no tag: reuse an existing pin with the same
      // target (e.g. the same site pinned in another window) or adopt fresh.
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

    // On restart, force the restored pin back to its canonical URL. Session
    // restore brings tabs back wherever they wandered; we don't want that.
    if (resetToHome) {
      const entry = canonical.find((e) => e.pinId === pinId);
      if (entry && !sameUrl(tab.url, entry.url)) {
        try {
          await browser.tabs.update(tab.id, { url: entry.url }); // reload home in place
        } catch (e) { /* ignore */ }
      }
    }
  }

  // Create copies for any canonical entries missing from this window.
  for (const entry of canonical) {
    if (!present.has(entry.pinId)) {
      const tab = await createPinned(windowId, entry);
      if (tab) present.set(entry.pinId, tab.id);
    }
  }

  await reorder(windowId);
}

async function reconcileAll(exceptWindowId) {
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
    await withWindowLock(win.id, () => reconcileWindow(win.id));
  }
}

// ---- User-driven changes ---------------------------------------------------

async function adoptUserPinned(tab) {
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
  // Mirror into every other window.
  await reconcileAll(tab.windowId);
}

// Unpinning is the deliberate removal gesture (you don't unpin by accident
// the way you fat-finger Ctrl+W). Drop the entry from the canonical set and
// remove its copies from every other window. The tab the user unpinned stays
// open as an ordinary tab. Closing, by contrast, re-spawns (see onRemoved).
async function handleUnpin(tabId, info) {
  canonical = canonical.filter((e) => e.pinId !== info.pinId);
  reindex();
  await persist();

  // The unpinned tab becomes an ordinary tab; just stop managing it.
  unregister(tabId);
  try { await browser.sessions.removeTabValue(tabId, SESSION_KEY); } catch (e) { /* ignore */ }

  // Remove this pin's copies from all other windows.
  for (const [, m] of windowMap) {
    const tid = m.get(info.pinId);
    if (tid != null) await removeManaged(tid);
  }
}

// Re-spawn a pinned tab the user closed (only Unpin may truly remove one).
const lastRespawn = new Map(); // pinId -> timestamp, runaway guard
async function respawn(info) {
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
    await createPinned(info.windowId, entry);
    await reorder(info.windowId);
  });
}

// ---- Event wiring ----------------------------------------------------------

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;

  if ("pinned" in changeInfo) {
    if (reconciling > 0) return; // our own injection churn
    if (changeInfo.pinned === true) {
      if (tabIndex.has(tabId)) return; // already managed
      if (!(await isManageableWindow(tab.windowId))) return;
      if (!isManageableUrl(tab.url)) return; // privileged page: leave it native
      await adoptUserPinned(tab);
    } else {
      const info = tabIndex.get(tabId);
      if (info) await handleUnpin(tabId, info);
    }
  }
  // No URL drift: a pin's canonical URL is fixed at pin time ("open at home").
  // Navigating a copy moves only that live tab, not the stored pin.
});

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ready;
  const info = tabIndex.get(tabId);

  // Our own programmatic removal.
  if (suppress.has(tabId)) {
    suppress.delete(tabId);
    unregister(tabId);
    return;
  }

  // Window teardown must NEVER touch the canonical set — this is what makes
  // "closing the wrong window" safe. Just forget the dead tab.
  if (removeInfo.isWindowClosing) {
    unregister(tabId);
    return;
  }

  if (!info) return; // not a managed pinned tab

  unregister(tabId);
  await respawn(info); // user closed a pinned tab directly -> bring it back
});

// ---- Address bar protection (optional, off by default) --------------------
//
// A top-level navigation in a managed pinned tab that has NO document origin is
// a typed/bookmark/external navigation (link clicks and in-page JS carry the
// page as originUrl). Cancel it and open the destination in a new tab instead,
// so the pinned page never moves. Must stay synchronous to return {cancel}.
// Needs the <all_urls> host permission, so it's only registered when the user
// has enabled the setting AND granted the permission.
const PROTECT_KEY = "addressBarProtection";
const PROTECT_ORIGINS = { origins: ["<all_urls>"] };
let protecting = false;

function pinAddressBarGuard(details) {
  if (details.type !== "main_frame") return;
  const info = tabIndex.get(details.tabId);
  if (!info) return;                                   // not a managed pin
  if (details.originUrl || details.documentUrl) return; // link / JS nav: allow
  const entry = canonical.find((e) => e.pinId === info.pinId);
  if (!entry) return;
  if (sameUrl(details.url, entry.url)) return;          // refresh / same page: allow

  // Typed a different URL into the pinned tab's address bar: divert it.
  browser.tabs.create({ url: details.url, active: true, windowId: info.windowId });
  return { cancel: true };
}

// Register/unregister the guard to match (setting enabled) && (permission held).
async function refreshAddressBarProtection() {
  const data = await browser.storage.local.get(PROTECT_KEY);
  const wanted = data[PROTECT_KEY] === true && (await browser.permissions.contains(PROTECT_ORIGINS));
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

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && PROTECT_KEY in changes) refreshAddressBarProtection();
});
browser.permissions.onAdded.addListener(refreshAddressBarProtection);
browser.permissions.onRemoved.addListener(refreshAddressBarProtection);

// Settings page -> wipe all saved pins (storage + in-memory). Currently-open
// pinned tabs are left as ordinary pinned tabs; re-pinning re-adopts them.
browser.runtime.onMessage.addListener(async (msg) => {
  if (msg && msg.type === "clearPins") {
    canonical = [];
    windowMap.clear();
    tabIndex.clear();
    await persist();
    return { ok: true };
  }
  return undefined;
});

browser.windows.onCreated.addListener(async (win) => {
  await ready;
  if (win.incognito || win.type !== "normal") return;
  await withWindowLock(win.id, () => reconcileWindow(win.id));
});

browser.windows.onRemoved.addListener((windowId) => {
  const m = windowMap.get(windowId);
  if (m) {
    for (const tabId of m.values()) tabIndex.delete(tabId);
    windowMap.delete(windowId);
  }
  queues.delete(windowId);
});

// ---- Startup ---------------------------------------------------------------
//
// Persistent background loads once at browser start and at install. Reconcile
// what's already open, then a second debounced pass to catch windows that
// Firefox's session restore is still materializing (pinId tags make both
// passes idempotent — no duplicates).
ready.then(async () => {
  await reconcileAll();
  setTimeout(() => reconcileAll(), 1500);
  refreshAddressBarProtection();
});

browser.runtime.onInstalled.addListener(() => ready.then(() => reconcileAll()));

// Browser restart (fires ONLY on real startup, not extension reload). Turn on
// reset-to-home while session restore materializes its windows, then turn it
// off so navigating a pin during the session is never forced back.
browser.runtime.onStartup.addListener(() => {
  resetToHome = true;
  setTimeout(() => { resetToHome = false; }, 8000);
  ready.then(() => reconcileAll());
  setTimeout(() => ready.then(() => reconcileAll()), 2500);
});
