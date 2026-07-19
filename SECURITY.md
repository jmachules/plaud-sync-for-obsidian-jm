# Security Policy

## Supported versions

Only the [latest release](https://github.com/jmachules/plaud-sync-for-obsidian-jm/releases/latest)
is supported with security fixes. There's no long-term-support branch — please upgrade before
reporting an issue, in case it's already fixed.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Preferred: use GitHub's private vulnerability reporting — go to this repo's **Security** tab →
**Report a vulnerability**. That opens a draft advisory visible only to the maintainer until a
fix is ready. (If that option isn't visible, it may need to be enabled in the repo's Settings →
Security first.)

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof of concept
- The affected version or commit

This is a single-maintainer open source project — there's no formal SLA, but reports will be
acknowledged and triaged as soon as possible.

## Scope

This plugin is an unofficial integration with Plaud's undocumented, reverse-engineered API (see
[README](README.md)). Vulnerabilities in **Plaud's own service** are out of scope here — please
report those to Plaud directly. In scope: this repository's code — the Obsidian plugin (`src/`)
and the companion browser extension (`browser-extension/`) — and specifically how they handle
your Plaud session token and this system's own bridge pairing secret.

## Security architecture (for context)

- **Plaud token & bridge secret at rest**: encrypted via the OS credential store (Keychain /
  DPAPI / libsecret) where the Obsidian runtime supports it, with a non-silent fallback and an
  explicit consent prompt before anything is ever written unencrypted. See
  [`docs/browser-token-bridge.md`](docs/browser-token-bridge.md) §8 and `src/secret-store.ts`.
- **Browser token bridge listener**: binds to `127.0.0.1` only, never reachable from the LAN or
  internet. Every request requires a shared secret compared with a timing-safe equality check;
  there's no GET route, so a leaked secret only allows *pushing* a token in, not reading one back
  out. See `src/token-bridge-server.ts`.
- **Browser extension**: host permissions scoped to exactly two origins (`web.plaud.ai` and
  `127.0.0.1`) — nothing else. No `eval`, `innerHTML` assignment, or remote script loading,
  enforced in CI by `browser-extension/test/manifest-security.test.mjs` on every change.
- **Secret scanning**: `gitleaks` scans the full repository history on every push
  (`.github/workflows/secret-scan.yml`).

## Review history

| Date | Scope | Findings & fixes | Reference |
|---|---|---|---|
| 2026-07-16 | Browser token bridge HTTP listener (Obsidian side) | Oversized request bodies could crash the connection instead of returning 413; no permanent error listener on the server; port validation gaps | `996dcdc` |
| 2026-07-16 | Secret storage at rest | The Plaud token and bridge secret were landing in local storage as **plaintext**, readable from DevTools. Fixed with OS-backed encryption and a non-silent fallback. | `9a0e3c4`, [`docs/browser-token-bridge.md`](docs/browser-token-bridge.md) §8 |
| 2026-07-19 | Plaintext-fallback UX | The encryption fix's own fallback path was still silent (console-only warning) when encryption was unavailable. Added a confirm-before-write modal and loud notices, including one case (`ensureBridgeSecret`) missed on the first pass and caught by manual click-through testing. | `e587f30`, `66dc750` |
| 2026-07-19 | Browser extension — fresh implementation + review | Extension had never been version-controlled or reviewed anywhere (confirmed absent from every branch and this machine); rebuilt from the design spec and reviewed. 10 findings (most severe: failed pushes were marked as sent, permanently suppressing retries), all fixed with regression tests. A second verification pass on the fixes themselves caught 4 more issues introduced by the first round of fixes. | `browser-extension/`, 49-test suite |
| 2026-07-19 | Static & secret scanning | Full git history and the extension folder scanned with `gitleaks` — clean. Manifest-hardening checks (permission scope, no `eval`/`innerHTML`, no remote script loading, no `<all_urls>`) added as permanent CI tests rather than a one-off check. | `.github/workflows/secret-scan.yml`, `browser-extension/test/manifest-security.test.mjs` |
| 2026-07-19 | Live end-to-end verification | Loaded the real extension into a real browser against a real running Obsidian instance and Plaud account: confirmed granted permissions match the manifest exactly, all network traffic from the extension's service worker is loopback-only, and `chrome.storage.local` never holds the raw Plaud token — only the bridge pairing credentials and status metadata. | Release [1.1.0](https://github.com/jmachules/plaud-sync-for-obsidian-jm/releases/tag/1.1.0) |

## Known limitations (accepted, not open vulnerabilities)

- `chrome.storage.local` (holding the browser extension's port and pairing secret) is not
  encrypted at rest by the browser itself — a platform limitation, not something fixable from
  inside an extension. See `docs/browser-token-bridge.md` §8.
- Plaud's own web session/cookie handling is outside this project's control.
- The Plaud API this plugin talks to is unofficial and reverse-engineered; it can change without
  notice (see [README](README.md)). That's a reliability risk, not a security one, but it's
  worth knowing when reviewing this code.
