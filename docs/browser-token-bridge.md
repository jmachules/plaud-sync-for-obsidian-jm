# Plaud Browser Token Bridge — Design, Findings & Runbook

**Status as of 2026-07-15.** This document exists so the whole token-bridge
solution (and the reverse-engineering that led to it) can be recreated,
debugged, or extended without repeating the investigation from scratch.
Plaud's API is unofficial and undocumented — anything in this file could
break the next time Plaud ships a web app update. If it does, the
"Reverse-engineering findings" section below is where to start re-digging.

---

## 1. Problem this solves

The stock plugin (`plaud-sync-for-obsidian`) requires pasting a Plaud
session token by hand into Settings → Plaud Sync → Plaud token. Two
problems with that:

1. **The originally-documented extraction method is dead.** The README/an
   upstream GitHub issue said to run `localStorage.getItem("tokenstr")` in
   the browser console. That key no longer exists in Plaud's web app —
   extracting via that method and pasting it produces "authentication
   failed" no matter what.
2. **Even with a valid token, it expires in ~24 hours**, so manual
   copy-paste has to be repeated roughly daily forever.

This bridge automates step 2 (getting a fresh token into the plugin
automatically) by piggybacking on the fact that the Plaud **web app**
already keeps its own token fresh on its own schedule. We never had to
reverse-engineer Plaud's refresh flow — we just read whatever valid token
the web app currently has, whenever a Plaud tab happens to be open.

---

## 2. Architecture

```
┌─────────────────────────┐         ┌──────────────────────────┐         ┌────────────────────────────┐
│  web.plaud.ai tab        │         │  Browser extension        │         │  Obsidian (Plaud Sync)     │
│  (content-script.js)     │  msg    │  background.js            │  HTTP   │  token-bridge-server.ts    │
│  reads localStorage      │ ──────► │  POST /token with shared  │ ──────► │  127.0.0.1:<port>, checks  │
│  workspaceToken every    │         │  secret header             │         │  secret, calls              │
│  60s, on change          │         │                            │         │  setPlaudToken()            │
└─────────────────────────┘         └──────────────────────────┘         └────────────────────────────┘
```

- The web app's own `WorkspaceInterceptor` logic keeps `workspaceToken`
  valid in `localStorage` as long as the tab is open (even backgrounded/
  unfocused — Chrome throttles but does not stop background-tab timers).
- The extension's content script never talks to the network directly; it
  only reads `localStorage` and messages the background service worker.
- The background service worker does the actual `fetch()` to
  `127.0.0.1`, authenticated with a shared secret.
- The Obsidian plugin's listener is loopback-only, write-only (no GET
  route to read the token back out), and desktop-only
  (`Platform.isDesktopApp` guarded).

No new network calls to Plaud were added anywhere in this design — the
bridge only reads what the web app already fetched for itself.

---

## 3. Reverse-engineering findings (for when Plaud changes something again)

These were discovered by instrumenting `fetch`/`XHR` in the DevTools
console on `web.plaud.ai`, static-searching the bundled app JS
(`app-initial-common.*.chunk.js`) via Sources → Search, and inspecting
Application → Local Storage / Cookies. Keep this section updated if any
of it changes.

### 3.1 Where the working token actually lives

```
localStorage["pld_<hashedUserId>:workspaceList"]
```

Value is a JSON array (one entry per workspace; a personal account has
one). Relevant fields on `list[0]`:

| Field              | Meaning                                  | Observed TTL |
|---------------------|-------------------------------------------|--------------|
| `workspaceToken`    | The access token used as the Bearer value | ~24 hours    |
| `expiresAt`         | Epoch ms when `workspaceToken` expires    | —            |
| `refreshToken`      | Separate JWT, intended for refresh calls  | ~30 days     |
| `refreshExpiresAt`  | Epoch ms when `refreshToken` expires      | —            |
| `domain`            | API base, e.g. `https://api.plaud.ai`     | —            |
| `workspaceId`       | e.g. `ws_xxxxxxxx`, used in refresh path  | —            |

The old, previously-documented key (`pld_tokenstr` /
`localStorage.getItem("tokenstr")`) **does not exist** in the current web
app. If validation starts failing again and the token was extracted via
some older instruction set, check first whether the storage key changed
again — search all of `localStorage` for a key ending in `:workspaceList`
rather than assuming a fixed name.

### 3.2 Confirmed-working auth format

```
Authorization: Bearer <workspaceToken>
```

This is exactly what the stock plugin already sends
(`plaud-api.ts` → `createPlaudApiClient`). The plugin's auth mechanism was
never broken — only the token *extraction* method was. Validating a
freshly-pulled `workspaceToken` via **Plaud: validate token** succeeded
with no plugin code changes required.

### 3.3 The refresh endpoint (found, not working — open item)

Two refresh flows exist in the bundled app code (found via Sources →
search across files for `refreshToken`):

**Flow A — cookie-based user-token refresh (not usable outside a browser):**
```
POST {apiBase}/auth/refresh-user-token
Body: {}
withCredentials: true   (relies on an HttpOnly cookie, e.g. pld_ut)
```
Not usable by the Obsidian plugin — HttpOnly cookies are invisible to any
code outside the browser that set them.

**Flow B — workspace-token refresh (the one that matters, still unsolved):**
```
POST {domain}/user-app/workspace/refresh/{workspaceId}
Headers: Authorization: Bearer {refreshToken}
```
Every manual replication attempt (via `fetch()` in the DevTools console,
with `credentials: 'include'`, various header combinations) returned
`400 {"msg": "bad request"}` with no further detail. Root cause not
confirmed. Leading theories, untested:

- The `Authorization` scheme word might not literally be `Bearer` for this
  call — the JWTs' own header `typ` claims were `WT` (workspaceToken),
  `UT` (user token / cookie), and `WRT` (workspace refresh token). It's
  possible the refresh call expects `Authorization: WRT <refreshToken>`
  instead.
- One or more of the following headers (confirmed required by *some*
  endpoints, via the `access-control-allow-headers` CORS response) may be
  mandatory and weren't correctly reproduced:
  `X-Request-ID, x-device-id, timezone, app-language, app-platform,
  app-version, app-versionNumber, edit-from, x-pld-user`. A retry that
  added `x-device-id` and `x-pld-user` still failed, but `app-version` /
  `app-versionNumber` were never tried.
- **The most reliable next step, if this is picked back up**: force the
  *real app* to fire this call itself (not our replica) and capture it
  via DevTools Network tab. A plain page reload does **not** trigger it —
  the app unconditionally re-fetches the whole workspace list
  (`GET /device/list`-adjacent flow, observed as a `list` request) on
  every boot, which silently overwrites any backdated `expiresAt` before
  the refresh-guard logic ever runs. Triggering the real call requires
  either (a) a DevTools breakpoint on the exact `vu.post(...)` call site
  in `app-initial-common.*.chunk.js` combined with manipulating the *live
  in-memory* Pinia/Vue store (not just localStorage) to look near-expiry,
  or (b) simply waiting for it to fire naturally near the real ~24h mark
  with a Network-tab capture running.

**Why this matters**: if Flow B is ever cracked, the plugin could refresh
its own token directly with no browser dependency at all, making this
entire browser-extension bridge unnecessary. Until then, the extension
approach is the practical solution because it doesn't need Flow B to
work — it just reads whatever the web app's own (successful, but
unreplicated) internal refresh produces.

### 3.4 Full custom header set Plaud's API accepts

From the `access-control-allow-headers` response header on
`api.plaud.ai` requests:

```
Authorization, Content-Type, X-Request-ID, x-device-id, timezone,
app-language, app-platform, app-version, app-versionNumber, edit-from,
x-pld-user, X-Encrypt-Response
```

`x-device-id` is mirrored to a **non-HttpOnly** cookie named
`pld_x-pld-tag` (readable via `document.cookie`). `x-pld-user` matches the
PostHog `distinct_id` stored in `localStorage` under a key containing
`_posthog`, and also matches the `uid` field inside the `visited_history`
array. Neither is secret in the way a token is, but both are still
account-identifying — treat with the same "don't paste in chat" caution.

---

## 4. Files changed / created

### Plugin repo (`jmachules/plaud-sync-for-obsidian-jm`)

| File | Change |
|---|---|
| `src/token-bridge-server.ts` | **New.** Loopback-only HTTP listener, shared-secret auth, `POST /token` only. |
| `src/secret-store.ts` | Generalized to a `key`-parameterized implementation; added `getBridgeSecret`/`setBridgeSecret`/`clearBridgeSecret` alongside the existing token functions. Storage keys unchanged for the token (`plaud-sync.token`); new key `plaud-sync.bridge-secret` for the pairing secret. |
| `src/settings-schema.ts` | Added `bridgeEnabled: boolean` (default `false`) and `bridgePort: number` (default `8765`, validated to the 1024–65535 range). **Deliberately did not use "token" in these field names** — an existing test (`secret-store.test.mjs`) asserts `settings-schema.ts` never contains the substring "token", so the real token can never end up in the plaintext `data.json` settings file. |
| `src/settings.ts` | New "Browser token bridge (desktop only)" section: enable toggle, port field, secret field (read-only display + Regenerate button), endpoint URL shown for convenience. |
| `src/main.ts` | Added `startTokenBridge()`/`stopTokenBridge()`/`ensureBridgeSecret()`/`regenerateBridgeSecret()`/`setBridgeEnabled()`. Bridge starts on `onload()` if enabled and `Platform.isDesktopApp`; stops in `onunload()`. |
| `eslint.config.mts` | Scoped override for `src/token-bridge-server.ts` only: enables Node globals and permits `import/no-nodejs-modules`, since this one file legitimately needs real `http`/`crypto` (rest of the plugin stays mobile-safe/browser-global-only). |
| `test/token-bridge-server.test.mjs` | **New.** Covers: valid push accepted, wrong/missing secret rejected (401), missing `token` field rejected (400), unknown route/method rejected (404), `stop()` idempotency and port re-use. |
| `test/settings-schema.test.mjs` | Updated the explicit key allow-list to include `bridgeEnabled`/`bridgePort`. |

Build verified: `npm run build` (tsc + esbuild) clean, `npm test` 61/61
passing, `npm run lint` clean.

### Extension

**Status as of 2026-07-19: lives in this repo, at `browser-extension/`.**
The original extension described in the rest of this document (built on a
Windows machine, at `C:\Users\jmach\Sync\jmita\.obsidian\plugins\plaud-token-bridge-extension\`)
was never checked into version control anywhere and was lost — no copy of it
was found on any machine or in any git history. `browser-extension/` is a
full rewrite from this document's own spec (the localStorage shape in §3, the
files table below, the security notes in §8), then taken through two rounds
of independent code review (correctness + a manual click-through verification
pass in a real Obsidian instance) and given a 49-test automated suite
(`browser-extension/test/`, zero dependencies, loads the real source files
into a Node `vm` sandbox with mocked `chrome`/`localStorage`/`fetch` APIs —
see `browser-extension/README.md`). CI (`.github/workflows/browser-extension-ci.yml`)
runs that suite on every push/PR that touches the folder; `.github/workflows/secret-scan.yml`
runs `gitleaks` across the whole repo on every push/PR.

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3. `host_permissions`: `*://web.plaud.ai/*`, `http://127.0.0.1/*`. `permissions`: `storage` only. |
| `shared.js` | `MESSAGE_TYPE_TOKEN` and `isBridgeConfigured()`, loaded by all three of the files below (content_scripts array / `importScripts` / `<script src>`) so there's one definition instead of copies to keep in sync. |
| `content-script.js` | Runs on `web.plaud.ai`, polls for a localStorage key ending in `:workspaceList` every 60s, messages background on a token or ambiguity change. |
| `background.js` | Service worker; on message, reads `{port, secret}` from `chrome.storage.local` and POSTs to the local listener (5s timeout via `AbortController`); records `lastStatus`/`lastStatusAt`/`lastPushAmbiguous`. Reports the real push outcome back to the content script so a failed push gets retried instead of silently marked as sent. |
| `options.html` / `options.js` | Configuration UI: port + secret fields, live status display via `chrome.storage.onChanged` (not polling). |
| `test/` | 49 tests: parsing/dedup logic, every push outcome, the fetch timeout, options-page rendering, and manifest hardening checks (permission scope, no `eval`/`innerHTML`, no remote script loading). |
| `README.md` | Setup steps (a shorter version of section 5 below) plus how to run the test suite. |

It's a real subfolder of this repo now, not a separate unpacked-only
directory — `git clone` gets you both halves of the bridge together, and CI
validates the extension the same way it validates the plugin.

---

## 5. Extension setup, step by step

1. **Build and deploy the plugin first** (see section 6), and confirm
   Obsidian has the new `main.js` loaded (disable/re-enable the plugin,
   or fully restart Obsidian).
2. In Obsidian: **Settings → Community plugins → Plaud Sync** → scroll to
   **Browser token bridge (desktop only)** → toggle **Enable browser
   token bridge** on.
   - Note the **Bridge port** field (default `8765`).
   - Note the **Bridge secret** value shown in that setting's description.
3. Open your browser's extension management page:
   - Edge: `edge://extensions`
   - Chrome: `chrome://extensions`
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** → select this repo's `browser-extension/` folder.
6. Open the extension's **options page** (click the extension's icon in
   the toolbar — pin it first via the puzzle-piece menu if it's hidden —
   or go back to the extensions page → Plaud Token Bridge → **Extension
   options**).
7. Paste the **port** and **secret** from step 2 → click **Save**.
   ⚠️ **The Bridge port field shows `8765` as gray placeholder text, not an
   actual value** — even though it matches the real default, that text isn't
   really in the field. Click in and type the port yourself, or **Save**
   fails with "Port must be a number between 1024 and 65535." (This is a
   confirmed live gotcha from setup verification on 2026-07-19, not
   hypothetical — it's exactly what happened the first time.)
8. Open (or reload) a `web.plaud.ai` tab where you're already logged in.
   Leave it open — it doesn't need to be focused, just loaded.
9. Wait up to ~60 seconds, then re-check the extension's options page. It
   should show `Last push: ok at <timestamp>`.
10. Back in Obsidian, you should see a notice: *"Plaud token updated via
    browser bridge."* Confirm with the command **Plaud: validate token**.

### Reconfiguring after a secret regeneration

If you ever click **Regenerate** on the Bridge secret in Obsidian
settings, the extension's saved secret becomes stale immediately —
pushes will start failing with `http_401` on the options status line.
Repeat steps 6–7 with the new secret.

---

## 6. Rebuilding from scratch

```bash
git clone https://github.com/jmachules/plaud-sync-for-obsidian-jm.git
cd plaud-sync-for-obsidian-jm
npm ci
npm run build          # tsc -noEmit && esbuild production bundle -> main.js
npm test                # should show 61 passing
npm run lint             # should be clean
```

Then copy the three release artifacts into the vault:

```
main.js       -> <vault>/.obsidian/plugins/plaud-sync/main.js
manifest.json -> <vault>/.obsidian/plugins/plaud-sync/manifest.json
styles.css    -> <vault>/.obsidian/plugins/plaud-sync/styles.css
```

Reload Obsidian (or disable/re-enable the plugin under Settings →
Community plugins) to pick up the new build.

The extension needs no build step — it's plain JS/HTML, loaded directly via
"Load unpacked" (pointed at `browser-extension/`) as described in section 5.
To run its own test suite:

```bash
cd browser-extension
npm test                # should show 49 passing, zero dependencies
```

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Save fails with "Port must be a number between 1024 and 65535" even though the port field visibly shows `8765` | That `8765` is gray placeholder text, not a real value — nothing was actually typed into the field | Click into the Bridge port field and type the port yourself before Save |
| Extension options page shows `not_configured` | Secret field empty in extension options | Paste the secret from Obsidian settings, Save |
| Extension options page shows `http_401` | Secret mismatch (e.g. after a Regenerate in Obsidian) | Re-copy the current secret from Obsidian into the extension options |
| Extension options page shows `network_error` | Obsidian not running, or bridge toggle is off, or port mismatch | Check Obsidian is open, bridge toggle is on, and the port matches on both sides |
| No push ever happens, no status at all | No `web.plaud.ai` tab open/loaded | Open one and leave it loaded; wait ~60s |
| Push succeeds (`ok`) but **Plaud: validate token** still fails | Plaud changed the auth requirements again (see §3.4 for the full header list) | Re-run the DevTools capture process (§3.3's "most reliable next step") against a currently-working request to see what changed |
| `Plaud token bridge failed to start on port <n>` notice in Obsidian | Port already in use by another process (or another instance of this listener) | Pick a different port in both Obsidian settings and the extension options |
| Content script finds nothing (no pushes, extension shows nothing) | Plaud renamed the localStorage key away from `*:workspaceList` again | Repeat the DevTools localStorage inspection from §3.1 to find the new key name, update `content-script.js`'s `readWorkspaceEntry()` accordingly |

---

## 8. Security notes

- The bridge listener binds to `127.0.0.1` only — never reachable from
  the LAN or internet.
- Every request requires the shared secret, compared with a timing-safe
  equality check; there is no GET route, so even a leaked secret only
  grants the ability to *push* a token in, not read one out.
- The extension has host permissions for exactly two origins
  (`web.plaud.ai`, `127.0.0.1`) — nothing else.
- **Obsidian-side storage is encrypted at rest where the OS supports it
  (fixed 2026-07, branch `fix/encrypt-secret-storage-fallback`).**
  `src/secret-store.ts`'s documented first-choice path
  (`app.getSecret`/`setSecret`/`deleteSecret`) is currently dead code — no
  shipping Obsidian build implements it — so the Plaud token and the
  bridge secret were both landing in `loadLocalStorage`/`saveLocalStorage`
  as **plaintext**, readable directly from DevTools → Application → Local
  Storage. This has been fixed: on desktop, before a value is written to
  that fallback store, it's encrypted with
  [`@electron/remote`](https://www.npmjs.com/package/@electron/remote)'s
  `safeStorage` (Chromium's OS-backed credential store — Keychain on
  macOS, DPAPI on Windows, libsecret on Linux). `@electron/remote` is
  **not a declared dependency** — like `electron` itself, it's reached via
  the Electron renderer's global `require(...)`, which Obsidian's own
  bundled Electron already provides, so it doesn't need to ship inside
  `main.js`. Every access is wrapped so a missing/broken module degrades
  to the old plaintext behavior instead of crashing the plugin — and that
  degraded state is no longer silent: it logs a `console.warn` and shows
  a "Secret storage encryption: unavailable" line in Settings → Plaud
  Sync, specifically so this doesn't ship unnoticed a second time. Any
  plaintext value already sitting in storage from before this fix gets
  migrated to an encrypted envelope automatically the next time it's
  read (e.g. opening Settings → Plaud Sync) — no manual re-paste needed,
  and it's a one-time upgrade, not a write on every read.
  Practical implications:
  - **Encrypted values are tied to the OS user account and machine that
    encrypted them.** A value encrypted on, say, Matt's MacBook under
    his OS login **will not decrypt** if the `data.json`/local-storage
    file is copied to another machine or read under a different OS user
    — `safeStorage.decryptString()` throws, which the plugin treats as
    "can't read this" rather than crashing (you'd need to re-paste the
    token / let the bridge re-push it).
  - **This only fixes the Obsidian-side store.** The browser extension's
    own secret storage — `chrome.storage.local` holding `{port, secret}`
    in `options.js` (§4/§5 above) — is a real repo file now (`browser-extension/`),
    but the storage mechanism itself is entirely the browser's: Chrome/Edge
    extension storage is not encrypted at rest, and there's no equivalent of
    Electron's `safeStorage` available to a content script or service worker.
    That remains a known, accepted limitation; not addressed by this fix.
  - Mobile Obsidian has no Electron/`require`, so this is desktop-only by
    construction — no separate `Platform.isDesktopApp` check was needed
    to gate it; feature-detecting `require`/`@electron/remote` already
    fails closed on mobile, and doing it that way (rather than importing
    Obsidian's `Platform`) keeps `secret-store.ts` free of any Obsidian
    import, which is what lets `test/secret-store.test.mjs` load and
    exercise it directly under plain Node.
- **Lesson from building this**: during the investigation that led here,
  live Plaud tokens, refresh tokens, and full cookie headers were
  accidentally pasted into chat multiple times while debugging in
  DevTools. Each time required rotating the Plaud account session
  (log out all sessions / change password) to invalidate the exposed
  values. If you're re-doing any of the DevTools investigation in §3,
  **never paste full `Authorization` or `Cookie` header values, or full
  `localStorage` dumps, anywhere outside your own machine** — field
  names and structure are enough for debugging; redact the values.

---

## 9. Open items / possible future work

- Flow B (the real workspace-token refresh endpoint, §3.3) is still
  unsolved. Cracking it would let the plugin refresh itself with zero
  browser dependency, making the entire extension unnecessary.
- No automated way yet to detect "the extension hasn't pushed a fresh
  token in over 24h" and surface a warning in Obsidian — currently you'd
  only notice via a failed sync.
- The 30-day `refreshToken` lifetime is the true outer bound: even with
  the bridge running perfectly, if no Plaud tab is opened for 30+ days,
  the web app's own session will expire and require an interactive
  re-login before the bridge has anything valid to read again.
