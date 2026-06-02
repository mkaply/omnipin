# Omnipin

A Firefox WebExtension that makes pinned tabs **window-independent** — the same pins in every
window, never lost.

## The problem

Firefox stores pinned tabs in **per-window session state**. They are owned by one window,
so if you close that window (or the "wrong" one in a multi-window setup) the pinned tabs go
with it. Existing add-ons work around this by *relocating* pinned tabs to the foreground
window, which is clunky and has a visible "moving" moment.

## The approach

Stop treating any window as the owner. `storage.local` becomes the **single source of truth**
for the pinned set; each window's native pinned strip is just a *materialized view* of that
list. Windows become disposable — closing any one of them cannot lose the set, because no
window owns it.

| Aspect       | Behavior |
|--------------|----------|
| **Model**    | Global — the same pinned set is injected into the front of *every* normal window. |
| **Storage**  | `storage.local` (this profile, survives restart, no Firefox Sync). |
| **Open at home** | A pin's URL is fixed at pin time. Navigating a copy moves only that live tab (Firefox keeps same-domain navigation in place); **new windows and restart always open the pinned URL**, never wherever a copy wandered. |
| **Closing**  | Protected — this is the accidental gesture. ✕ / Ctrl+W on a pinned tab **re-spawns** it; closing a whole window never loses anything. |
| **Removing** | **Unpin** is the deliberate removal gesture. Unpinning a tab drops it from the set in every window (the tab itself stays open as an ordinary tab). |
| **Address bar protection** | *Optional, off by default.* When enabled in options, typing a URL into a pinned tab opens it in a **new tab** instead of navigating the pin away. Requires the all-sites permission, so it's requested only when you turn it on. |
| **Manifest** | MV2, persistent background. |

`pinId` (stored as a `sessions` tab value, so it survives session restore) is the logical
identity of a pin and is shared by every window's copy.

## Install (temporary, for testing)

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `manifest.json` in this folder.

> **Note on testing restart behavior (verify step 7):** a temporary add-on is *removed* when
> Firefox closes, so `runtime.onStartup` never fires and the reset-to-home pass can't run. To
> actually test "pins reopen at their URL across a restart," install it non-temporarily —
> e.g. run it under `web-ext`, or set `xpinstall.signatures.required=false` in Developer
> Edition/Nightly and install the packaged extension.

## Verify

1. Pin a tab → open a new window → it appears at the front. *(global injection)*
2. Open 3 windows; close one that has pinned tabs → the others are unaffected. *(core fix)*
3. Close the "wrong" whole window → nothing is lost. *(no-owner invariant)*
4. Ctrl+W / ✕ a pinned tab → it re-spawns. *(can't be closed away)*
5. Right-click → **Unpin** → it disappears from the set in every window. *(deliberate removal)*
6. Navigate a pinned tab somewhere, then open a new window → the new copy opens at the **pinned
   URL**, not where you navigated. *(open at home)*
7. Quit and restart Firefox → pins reopen at their **pinned URL**, not wherever they wandered,
   with no duplicates. *(URLs, not sessions — requires a non-temporary install; see note)*
8. Pin a container tab → it reopens with the same container everywhere. *(cookieStoreId preserved)*
9. Options → enable **Address bar protection** (grant the prompt) → type a URL into a pinned tab →
   it opens in a new tab, pin stays put. Toggle off → the all-sites permission is revoked. *(optional)*

## Files

- `manifest.json` — MV2 manifest; base permissions `tabs`, `storage`, `sessions`, `webRequest`,
  `webRequestBlocking`; `<all_urls>` is optional (requested only for address bar protection).
- `background.js` — the reconciler and all event handling.
- `options.html` / `options.js` — settings page with the address bar protection toggle.
- `updates.json` — self-hosted update manifest (rewritten by CI on each release).
- `.github/workflows/release.yml` — on a `manifest.json` version bump, signs the add-on via AMO
  (unlisted) and publishes the `.xpi` as a GitHub release.

## Releasing

Bump `version` in `manifest.json` and push to `main`. CI signs (unlisted channel) and cuts a
release. Requires two repo secrets — `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (from your
[AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/)).

## License

[MIT](LICENSE) © Mike Kaply
