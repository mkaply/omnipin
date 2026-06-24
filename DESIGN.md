# Omnipin — Design

## Vision

Omnipin is a **focused suite of pinned-tab behaviors with opinionated defaults**, not a
configuration panel. Install it, change nothing, and pinned tabs behave the way they always
should have. The toggles exist so people can *subtract* behaviors they don't want — not so they
have to assemble the product themselves.

**The core idea, in one sentence: Omnipin pins URLs, not tabs.** Firefox's pinned tabs are
*session* objects bound to a window — they drift as you navigate, carry session state, and vanish
when their window closes. An Omnipin pin is the **original URL you pinned**: a durable identity
that is remembered, always reopens at that URL, and can't be lost. Pinned URL, not pinned tab —
that's the whole difference.

The irreducible promise, true even with every toggle off: **the URL you pinned is remembered and
recoverable.** "Everything off" is *not* vanilla Firefox — it's ordinary pinned tabs whose
original URL is remembered and one action away from coming back.

Discipline guardrails:
- Keep the toggle count small (~4 meaningful behaviors). Every switch doubles the test surface.
- Strong defaults: out of the box you get the full opinionated mechanic.
- A behavior earns a toggle only if real people genuinely want it *off*.

## Architecture: foundation + behaviors

The single-tab behaviors never reach into the global machinery, so behaviors compose instead of
special-casing each other.

### Foundation — always on (the irreducible value)

1. **Per-tab home.** Every pinned tab remembers the URL it was pinned at (`homeUrl`), stored as a
   `sessions` tab value (survives restart) and mirrored in memory for synchronous reads. Set for
   any manageable (`http`/`https`) pinned tab, regardless of which toggles are on. Everything in
   Layer 1 reads only this.

2. **Persisted set.** The canonical set of pins — `{pinId, homeUrl, cookieStoreId, order}` — lives
   in `storage.local`. Updated on pin (add) and unpin (remove); **never** touched by closing a
   tab, closing a window, or restart. This is "we always remember." It is *not* a toggle.

3. **Restore on demand.** A **"Restore pins to this window"** action (toolbar button + tab context
   menu) materializes the persisted set into the current window. This is the universal recovery
   mechanism: if pins ever go away from view, one action brings them back. Implementation is just
   `reconcileWindow` aimed at the current window.

So: *persistence* keeps the set alive; *Restore* brings it back; *Global* (below) is simply the
automatic, every-window version of Restore.

### Layer 1 — per-tab behaviors (toggles)

Read `homeUrl`, operate on a single tab in place. Do **not** require the global layer — so e.g.
"lock navigation" works on ordinary per-window pinned tabs.

| Behavior | What it does | Default |
|----------|--------------|---------|
| **Lock navigation** | A typed/foreign top-level navigation away from `homeUrl` is diverted to a new tab; the pin stays on its page. | **Off** (needs `<all_urls>`, requested on enable) |
| **Open at home** | On restart, reset each pinned tab to its `homeUrl` instead of the session-restored URL. Pins are URLs, not sessions. | **On** |
| **Protect from close** | Closing a pinned tab (✕ / Ctrl+W, not a window close) respawns it at its `homeUrl` in the same window. Only Unpin removes. | **On** |

### Layer 2 — Global (toggle)

The **automatic** form of Restore: keep the persisted set materialized in *every* normal window
(on window creation + kept in sync), so closing any window is a non-event.

| Behavior | What it does | Default |
|----------|--------------|---------|
| **Pin to every window** | Auto-restore the set into every window and keep them in sync. (A copy's `homeUrl` = its set entry's URL, so Layer 1 applies uniformly.) | **On** |
| **Load in background** | Sub-option: copies load resident (ready on click) vs. lazy (load when clicked). Lazy is for people running many windows. | **On** (resident) — *debatable; see open questions* |

With Global **off**: the set is still persisted; pins simply aren't auto-replicated. You recover
them per-window with **Restore**. ("Want them in every window? Turn Global on.")

Container preservation (recreate copies in the same container) is intrinsic to materialization,
always on — not a toggle. Requires the `cookies` permission (already added).

## Scenario walk-through

Two windows, you close the one holding the pins:
- **Global on:** the other window already has them (auto-restored on creation) — nothing lost,
  nothing to do.
- **Global off:** no window shows them now, **but the set is still remembered.** Hit **Restore pins
  to this window** and they reappear. Persistence guarantees *recoverable*; Restore is how you
  recover. (We deliberately do **not** auto-relocate them into a surviving window — that's the
  "moving" jank Omnipin exists to avoid. Auto-everywhere is exactly what Global is for.)

## What this changes in the current code

Today the lock/respawn logic is wired to the global canonical set. The refactor:

1. **Add the home foundation** — track `homeUrl` per pinned tab (session value + memory), set on
   pin/adopt for any manageable pinned tab.
2. **Always persist the set** — maintain the canonical set on pin/unpin regardless of the Global
   toggle (today it only exists when Global is effectively on).
3. **Add the Restore action** — `reconcileWindow(current)` behind a toolbar button + context menu.
4. **Rewrite the address-bar guard** to fire for *any* pinned tab with a `homeUrl`, comparing the
   target to that home — not to the canonical set.
5. **Rewrite respawn** to recreate at the tab's `homeUrl`.
6. **Gate auto-materialization** (replicate into every window, keep in sync) behind the "Pin to
   every window" toggle — *not* the persistence itself.
7. **Settings UI** — one toggle per behavior, plus Restore and Clear actions.

## Settings (options page)

```
Pinned tabs
  [x] Pin to every window               (auto-keep the set in every window)
        [x] Load in the background        (off = load when clicked; for many windows)
  [ ] Keep pins on their page            (lock navigation — asks for all-sites access)
  [x] Reopen pins at their URL on restart
  [x] Protect pins from accidental close

  [ Restore pins to this window ]        (also on toolbar + tab context menu)
  [ Clear saved pins ]
```

Defaults reproduce **today's** behavior, so existing installs see no change on update.

## Sync across devices (future — not in the first cut)

Because Omnipin pins URLs, not tab sessions, the pinned set is small, portable data — so "my
pinned URLs follow me across devices" is a natural extension of the URL thesis. It's deferred, not
rejected, because naive sync is hazardous. If/when built, these rules are non-negotiable:

- **Remote changes never touch live windows.** Today the set is materialized live (reconcile
  opens/closes/reorders real tabs; we react to `storage.onChanged`). If the set lived in
  `storage.sync`, a change on one device would reach across and close/open/reorder tabs on another
  *running* browser — invasive and wrong. A synced set must update only the stored **definition**
  and apply **lazily**: next window open, next restart, or a manual Restore. **No remote action
  ever closes a live tab.**
- **Conflicts.** `storage.sync` is last-write-wins / eventually consistent; offline edits on two
  devices clobber each other. Mitigate with per-pin keys (so adds/removes merge) rather than one
  blob, or accept LWW.
- **Containers don't roam.** `cookieStoreId` is per-profile — the same ID is a different/absent
  container on another device. Sync URLs only; drop the container across devices.
- **Quotas (minor).** ~8KB/item, ~100KB total; a URL list is tiny, but 100+ long-URL pins could
  force per-pin keys. Write-rate is fine (we write only on pin/unpin).

Shape: an opt-in toggle ("Sync pinned URLs across devices"); the synced set is the *definition*,
and each browser materializes it on its own schedule through the same Restore/Global machinery.

## Non-goals / open questions

- **Decided — there is one set of pins, not per-window sets.** A pin you designate belongs to the
  single global set; Restore brings the whole set into a window. A power user *might* want two
  windows with two different pin sets, but that's explicitly **not** who Omnipin is for — building
  it would mean per-window sets / workspaces, a heavier product that compromises the simple case.
  The "two windows, two sets" scenario merges into the one set; that's an accepted consequence.
- **Non-goals:** per-window pin sets / workspaces; managing container definitions. (Cross-device
  sync is deferred, not rejected — see *Sync across devices* above.)
- **Decided — Load-in-background defaults to resident**, with lazy as the opt-out for many-window
  users.
- **Future:** extend "lock navigation" to domain-aware link handling (cross-domain link → new tab,
  same-domain stays), not just the address bar.
- **Naming:** "Omnipin" (*omni* = every window) now names just Layer 2. Identity is locked, so this
  only affects display name/tagline — not urgent.

## Key combinations to test

- Lock navigation **without** Global (the per-window-only user).
- Global **without** background loading (the many-windows user).
- Everything off — pins still remembered; **Restore** brings them back.
- Everything on (current default) — must match present behavior.
