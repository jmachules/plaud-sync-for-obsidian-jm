# Plaud Token Bridge (browser extension)

Reads the Plaud web app's own refreshed session token out of `web.plaud.ai`'s localStorage and
pushes it to the local Plaud Sync Obsidian plugin, so you don't have to paste a token by hand.
Full design/rationale: `../docs/browser-token-bridge.md` in this repo.

This folder is **not** an Obsidian plugin -- Obsidian never loads it. It's a subfolder of this
repo purely for version control/CI; load it into your browser separately as an unpacked
extension (point "Load unpacked" at this folder directly from your local clone).

## Development

```
npm test
```

Runs the test suite (`test/*.test.mjs`, Node's built-in test runner, zero dependencies). It loads
the real `shared.js`/`content-script.js`/`background.js`/`options.js` source files -- unmodified
-- into a sandboxed `vm` context with mocked `chrome`/`localStorage`/`fetch` APIs, rather than
re-implementing the logic separately for testing. Covers the retry/dedup state machine, the
ambiguous-workspace detection, every `pushToken()` outcome (`ok`/`not_configured`/`http_<status>`/
`network_error`/`extension_error`), the fetch timeout, and the options page's status rendering
-- including regression tests for bugs found during code review of this extension.

## Setup

1. In Obsidian: **Settings -> Community plugins -> Plaud Sync -> Browser token bridge** -> toggle
   **Enable browser token bridge** on. Note the **Bridge port** (default `8765`) and **Bridge
   secret** shown there.
2. Open your browser's extensions page:
   - Edge: `edge://extensions`
   - Chrome: `chrome://extensions`
3. Enable **Developer mode** (top-right toggle).
4. **Load unpacked** -> select this folder.
5. Open the extension's options page (click its toolbar icon -- pin it via the puzzle-piece menu
   if it's hidden -- or Extensions page -> Plaud Token Bridge -> **Extension options**).
6. Paste the **port** and **secret** from step 1 -> **Save**.
   **The Bridge port field shows `8765` as gray placeholder text, not a real value** -- even
   though it matches the actual default port, that gray text is not actually in the field. You
   must click in and type the port yourself, or **Save** will fail with "Port must be a number
   between 1024 and 65535." (confirmed live: this is exactly what happened during setup
   verification).
7. Open (or reload) a `web.plaud.ai` tab where you're already logged in. Leave it open -- it
   doesn't need to be focused, just loaded.
8. Wait up to ~60s, then re-check the options page. It should show `Last push: ok at <timestamp>`.
9. In Obsidian, confirm with the **Plaud: validate token** command.

If you ever click **Regenerate** on the bridge secret in Obsidian, repeat steps 5-6 with the new
value. The extension only re-pushes when the Plaud token itself changes, so the old secret won't
visibly fail until then -- **reload the `web.plaud.ai` tab** right after saving the new secret to
force an immediate re-push (and a fresh `http_401` if you didn't update it in time) instead of
waiting for the token to next rotate on its own.

## Status values (shown on the options page)

| Status | Meaning |
|---|---|
| `not_configured` | Port or secret field is empty here |
| `ok` | Last push succeeded |
| `http_401` | Secret mismatch -- re-copy it from Obsidian |
| `http_<other>` | The bridge listener rejected the push for another reason |
| `network_error` | Obsidian isn't running, the bridge toggle is off, the port doesn't match, or the push timed out after 5s |
| `extension_error` | An unexpected internal error (not a normal push failure) -- check this extension's service worker console (Extensions page -> Plaud Token Bridge -> "service worker" link) for details |

A `(multiple workspaces/accounts detected...)` suffix on the status means the extension found
more than one Plaud workspace, or more than one matching localStorage key (e.g. a stale one from
a previous login) -- it always uses the first one found, which may not be the one you're using.

If no status ever appears: no `web.plaud.ai` tab is open, or Plaud renamed the localStorage key
this extension reads (see `docs/browser-token-bridge.md` section 3.1 for how to re-find it and
update `content-script.js`).

## Security notes

- Host permissions cover exactly two origins: `web.plaud.ai` (read the token) and `127.0.0.1`
  (push it locally). Nothing else.
- The content script never makes network calls itself -- it only reads `localStorage` and
  messages the background service worker.
- `chrome.storage.local` (holding the port + secret here) is **not encrypted at rest** by the
  browser. This is a known, accepted limitation -- see `docs/browser-token-bridge.md` section 8.
