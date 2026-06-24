# Omnipin

**Firefox pins tabs; Omnipin pins URLs.**

A Firefox extension that fixes pinned tabs. Firefox pins a *tab* — a window-bound session object
that drifts as you navigate, carries session state, and vanishes when its window closes. An
Omnipin pin is the **URL you pinned**: a durable identity that's remembered, reopens at that URL,
and can't be lost.

## What it does

Omnipin is a small suite of pinned-tab behaviors with opinionated defaults. Install it, change
nothing, and pinned tabs just work the way they should. The options exist so you can *subtract*
behaviors you don't want.

**Always on (the floor):** your pinned set is remembered in extension storage and is never lost
by closing a tab, closing a window, or restarting. If pins ever go away from view, the toolbar
button's **Restore pins to this window** brings the whole set back. "Everything off" is not vanilla
Firefox — it's ordinary pinned tabs that are remembered and one click from coming back.

**Toggles** (all default **on** except where noted):

| Setting | Behavior | Default |
|---------|----------|---------|
| **Pin to every window** | The same set is auto-materialized in *every* window and kept in sync, so closing any window can't lose anything. Off: pins stay where you make them; use **Restore** to pull them into a window. | On |
| **Load pinned tabs in the background** | Copies stay resident, ready the instant you click. Off (for many-window users): copies load only when clicked. | On |
| **Reopen pins at their URL on restart** | After a restart, each pin returns to its pinned URL, not wherever it wandered. | On |
| **Protect pins from accidental close** | ✕ / Ctrl+W on a pin brings it right back; only **Unpin** removes a pin. | On |
| **Keep pins on their page** | Typing a URL into a pinned tab opens it in a new tab instead of navigating the pin away. Needs the all-sites permission, requested only when enabled. | **Off** |

Pinned **container** tabs are preserved — a pin keeps its container in every window, and the same
URL in two containers is two distinct pins.

See [`DESIGN.md`](DESIGN.md) for the architecture (foundation → per-tab behaviors → global layer)
and the deferred cross-device-sync plan.

## Install (temporary, for testing)

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `manifest.json` in this folder.

> **Restart behavior can't be tested this way.** A temporary add-on is *removed* when Firefox
> closes, so `runtime.onStartup` never fires and "Reopen pins at their URL on restart" can't run.
> To test that, install non-temporarily — run it under `web-ext`, or set
> `xpinstall.signatures.required=false` in Developer Edition/Nightly and install the packaged xpi.

## Verify

With defaults (Pin-to-every-window on):
1. Pin a tab → open a new window → it appears at the front.
2. Open 3 windows; close one that has pinned tabs → the others are unaffected; nothing lost.
3. Ctrl+W / ✕ a pinned tab → it re-spawns. *(protect from close)*
4. Right-click → **Unpin** → it disappears from the set in every window. *(deliberate removal)*
5. Pin a container tab → it reopens in the same container everywhere.
6. *(non-temporary install)* Navigate a pin somewhere, quit and restart → it reopens at the pinned
   URL, not where it wandered. *(open at home)*

Toggle behaviors (in the toolbar popup → **Settings…**):
7. Turn **Pin to every window** off → pinning no longer fills other windows. Open a fresh window,
   click the toolbar button → **Restore pins to this window** → the set appears. *(recoverable)*
8. Turn **Load in the background** off → new-window copies are unloaded until clicked.
9. Turn **Keep pins on their page** on (grant the prompt) → type a URL into a pin → it opens in a
   new tab, the pin stays put. Toggle off → the all-sites permission is revoked.
10. Under **Your pins**, edit a pin's URL → it re-points in place; open a new window (or Restore)
    → the copy opens at the new URL. Reorder / remove also work.

## Files

- `manifest.json` — MV2 manifest; base permissions `tabs`, `storage`, `sessions`, `cookies`,
  `webRequest`, `webRequestBlocking`; `<all_urls>` is optional (only for "Keep pins on their page").
- `background.js` — the engine: set tracking, reconcile/materialize, behaviors, Restore.
- `popup.html` / `popup.js` — toolbar button: Restore + Settings.
- `options.html` / `options.js` — the behavior toggles, a manage-pins list (edit a pin's URL,
  reorder, remove), and Clear saved pins.
- `updates.json` — self-hosted update manifest (rewritten by CI on each release).
- `.github/workflows/release.yml` — on a `manifest.json` version bump, signs via AMO (unlisted)
  and publishes the `.xpi` as a GitHub release.
- `DESIGN.md` — design and roadmap.

## Releasing

Bump `version` in `manifest.json` and push to `main`. CI signs (unlisted channel) and cuts a
release. Requires two repo secrets — `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (from your
[AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/)).

## License

[MIT](LICENSE) © Mike Kaply
