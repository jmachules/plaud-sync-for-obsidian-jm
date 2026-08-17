# Plaud Sync for Obsidian

Sync your [Plaud](https://plaud.ai/) voice recordings into Markdown notes inside your Obsidian vault — transcripts, AI summaries, highlights, and metadata included.

> **Unofficial plugin.** Plaud does not offer a public API. This plugin uses a [reverse-engineered API](https://github.com/leonardsellem/plaud-api-reveng) discovered by inspecting the Plaud web app. It may break without notice if Plaud changes their backend. Use at your own risk.

## Features

- **Incremental sync** — only fetches recordings newer than your last sync checkpoint; never creates duplicates
- **Rich Markdown notes** — renders title, date, duration, AI summary, key highlights, and full transcript with speaker labels
- **Idempotent updates** — uses a stable `file_id` in frontmatter to update existing notes in place
- **Automatic token refresh** — an optional companion browser extension keeps your Plaud session token fresh with zero manual re-pasting; see [Installation](#2-install-the-browser-extension-recommended)
- **Encrypted token storage** — your Plaud token is encrypted at rest with your OS credential store (Keychain/DPAPI/libsecret) where available, with a clearly-surfaced fallback (not silent) if it isn't
- **Retry with backoff** — transient failures (network, rate-limit, 5xx) are retried automatically; permanent failures (auth, bad response) are surfaced immediately
- **Trash filtering** — recordings you deleted in Plaud are automatically skipped
- **Content hydration** — fetches full transcript and AI summary content from Plaud's signed URLs
- **Optional template enrichment** — if your recordings follow a fixed summary template, a config note can drive deterministic frontmatter extraction, wikilinks, and highlights at sync time; see [Configuration](#post-render-enrichment-optional)

## Requirements

- Obsidian **0.15.0** or later
- A Plaud account with recordings
- A Plaud session token — kept fresh automatically by the companion browser extension
  (recommended), or pasted in by hand every ~24 hours (see
  [Getting a Plaud token](#getting-a-plaud-token))
- Chrome or Edge, **only** if you're using the browser extension

## Installation

This is a two-part system:

1. **The Obsidian plugin** (required) — syncs your Plaud recordings into notes.
2. **The browser extension** (optional, recommended) — a companion Chrome/Edge extension that
   keeps your Plaud token fresh automatically. Plaud web sessions expire roughly every 24 hours;
   without the extension you'll need to manually re-paste a token that often.

### 1. Install the Obsidian plugin

**Quick install:** download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/jmachules/plaud-sync-for-obsidian-jm/releases/latest) and
copy them into your vault's plugin directory (e.g. `<vault>/.obsidian/plugins/plaud-sync/`).

**Or build from source:**

```bash
git clone https://github.com/jmachules/plaud-sync-for-obsidian-jm.git
cd plaud-sync-for-obsidian-jm
npm ci
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` from the repo root into your vault's plugin
directory the same way.

Either way: restart Obsidian and enable **Plaud Sync** under **Settings → Community plugins**.

### 2. Install the browser extension (recommended)

Skip this if you'd rather paste your token by hand — see
[Getting a Plaud token](#getting-a-plaud-token) below for the manual method instead.

1. Download `plaud-token-bridge-extension.zip` from the
   [latest release](https://github.com/jmachules/plaud-sync-for-obsidian-jm/releases/latest) and
   unzip it (or use the repo's `browser-extension/` folder directly if you built from source).
2. In Obsidian: **Settings → Plaud Sync → Browser token bridge** → toggle **Enable browser token
   bridge** on. Note the **Bridge port** and **Bridge secret** shown there.
3. Open your browser's extensions page — `edge://extensions` (Edge) or `chrome://extensions`
   (Chrome) — and enable **Developer mode**.
4. Click **Load unpacked** → select the unzipped extension folder.
5. Open the extension's options page (click its toolbar icon — pin it via the puzzle-piece menu
   if it's hidden).
6. Paste the **port** and **secret** from step 2, then click **Save**.
   ⚠️ **The Bridge port field shows `8765` as gray placeholder text, not a real value** — even
   though it matches the actual default, nothing is typed in until you click in and type it
   yourself, or **Save** fails with "Port must be a number between 1024 and 65535."
7. Open (or reload) a [web.plaud.ai](https://web.plaud.ai/) tab where you're already logged in,
   and leave it open. Within ~60 seconds the extension pushes a fresh token to Obsidian
   automatically — its options page should show `Last push: ok at <timestamp>`.

Full design notes, security details, and a deeper troubleshooting table for the bridge:
[docs/browser-token-bridge.md](docs/browser-token-bridge.md).

### 3. Verify everything works

Open the command palette (`Ctrl/Cmd+P`) and run **Plaud: validate token**, then **Plaud: sync
now**.

## Getting a Plaud token

Skip this section if you installed the browser extension above — it does this automatically.

Plaud has no official API or developer portal, and the token is a session value kept in the
Plaud web app's `localStorage`. The previously-documented `localStorage.getItem("tokenstr")`
method **no longer works** — that key doesn't exist in the current Plaud web app.

1. Open [web.plaud.ai](https://web.plaud.ai/) and log in
2. Open Developer Tools (`F12` or `Cmd+Opt+I`) → **Console** tab
3. Run:
   ```js
   JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith(':workspaceList'))))[0].workspaceToken
   ```
4. Copy the returned string
5. In Obsidian, open **Settings → Plaud Sync** and paste it into the **Plaud token** field

This finds whichever `localStorage` key currently holds your workspace list (Plaud has renamed
this key before and may again) and reads the live token out of it — the same lookup the browser
extension performs automatically every 60 seconds. The token expires roughly every 24 hours;
without the extension, repeat these steps whenever sync starts failing with an auth error. See
[docs/browser-token-bridge.md §3.1](docs/browser-token-bridge.md) if this lookup ever stops
working.

## Configuration

Open **Settings → Community plugins → Plaud Sync**:

| Setting | Default | Description |
|---------|---------|-------------|
| Plaud token | — | Your session token (stored securely, not in plugin settings) |
| API domain | `https://api.plaud.ai` | API endpoint; change only if your account is in a different region |
| Sync folder | `Plaud` | Vault folder where notes are created |
| Filename pattern | `plaud-{date}-{title}` | Pattern for new note filenames (`{date}` and `{title}` are replaced) |
| Sync on startup | `true` | Automatically sync when Obsidian starts |
| Update existing notes | `true` | Overwrite notes that already exist (matched by `file_id`) |
| Enable browser token bridge | `false` | Starts a loopback-only (`127.0.0.1`) listener that accepts token pushes from the browser extension — see [Installation](#2-install-the-browser-extension-recommended) |
| Bridge port | `8765` | Local port the listener binds to |
| Bridge secret | (generated) | Shared secret the extension must send with every push; shown here to paste into the extension's options page |
| Enrichment config path | (empty) | Vault path of a note defining optional post-render enrichment; empty disables it — see below |

### Post-render enrichment (optional)

If your recordings follow a fixed note template (for example, a structured call-summary
template configured in Plaud), the plugin can deterministically enrich each synced note at
render time: extract labeled fields into YAML frontmatter, turn configured names into
`[[wikilinks]]`, wrap configured phrases in `==highlights==`, and append a footer listing
unanswered fields. It is pure pattern matching against your template — nothing is inferred,
misconfigured or unexpected input leaves notes untouched, and notes that don't match the
template are only stamped with a `note-kind` for triage.

Point **Enrichment config path** at a vault note whose ```` ```json ```` block defines the
template contract. Minimal example (placeholder values):

```json
{
  "markers": ["Contact Profile", "## Engagement Details"],
  "noteKind": "screening-call",
  "nonNoteKind": "non-screening",
  "gapToken": "NOT CAPTURED",
  "fields": [
    {"key": "contact-name", "label": "Name"},
    {"key": "contact-email", "label": "Email"},
    {"key": "conducted-by", "label": "Call conducted by", "link": "recruiters"}
  ],
  "recruiters": {"alex": "alex-doe"},
  "clients": [{"slug": "acme-corp", "match": ["acme", "ACM"]}],
  "footerTitle": "Note connections (added automatically at sync)"
}
```

See `src/note-enricher.ts` for the full `EnrichSpec` contract (highlight phrases,
value highlighting, static keys, gap reporting, and a routing-token context link).
Link slugs are restricted to `a-z0-9-`; the config is capped at 64 KB; any validation
failure disables enrichment for that run (with a console warning) rather than guessing.

## Usage

### Commands

Open the command palette (`Ctrl/Cmd+P`) and search for:

| Command | Description |
|---------|-------------|
| **Plaud: sync now** | Run an incremental sync immediately; shows a summary notice with created/updated/skipped/failed counts |
| **Plaud: validate token** | Test your token against the API and show your active recording count |

### How sync works

1. Fetches the full recording list from Plaud
2. Filters out trashed recordings
3. Selects candidates where `start_time > lastSyncAtMs`
4. For each candidate, fetches detail + content (transcript, AI summary)
5. Creates or updates the Markdown note in your sync folder
6. Advances the `lastSyncAtMs` checkpoint only after the full batch succeeds

If sync is already running (startup or manual), additional attempts are blocked until the current run finishes.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Plaud token missing…" | Token not set or cleared | Re-paste token in settings, then run **Plaud: validate token** |
| "authentication failed…" | Expired or invalid token | Extract a fresh token from the web app |
| "rate limited by Plaud API…" | Too many requests | Wait a few minutes and retry; avoid rapid manual syncs |
| "network error…" | Connectivity / DNS / VPN issue | Check your connection and retry |
| "Plaud API is temporarily unavailable…" | Plaud servers down (5xx) | Retry later |
| "unexpected API response format…" | Plaud changed their API | Check for a plugin update; open an issue if none exists |
| "Unable to create Plaud sync folder…" | Invalid path or vault permissions | Use a simple folder name; check vault write access |
| "Plaud token bridge failed to start on port…" | Port already in use | Pick a different port in both Obsidian settings and the extension options |
| Extension options page shows `not_configured` / `http_401` / `network_error` | Bridge secret not pasted yet, stale after a Regenerate, or Obsidian/port mismatch | See the full [bridge troubleshooting table](docs/browser-token-bridge.md) |

## Development

```bash
npm ci                # install dependencies
npm run dev           # watch mode with hot reload
npm run build         # typecheck + production build
npm run test          # run test suite (Node.js native test runner)
npm run lint          # eslint
```

The browser extension has its own independent test suite (zero dependencies):

```bash
cd browser-extension
npm test
```

### Project structure

```
src/
├── main.ts                    # Plugin lifecycle, command dispatch, error handling
├── commands.ts                # Command registration
├── settings.ts                # Settings UI tab
├── settings-schema.ts         # Settings interface and defaults
├── secret-store.ts            # Token storage (Obsidian secrets + encrypted fallback)
├── confirm-plaintext-modal.ts # Consent prompt before storing a secret unencrypted
├── token-bridge-server.ts     # Loopback HTTP listener for the browser extension
├── token-bridge-runtime.ts    # Bridge start/stop/enable/regenerate-secret orchestration
├── plaud-api.ts               # API client, error categorization
├── plaud-api-obsidian.ts      # Obsidian requestUrl transport adapter
├── plaud-normalizer.ts        # Payload normalization across API variants
├── plaud-renderer.ts          # Markdown rendering
├── plaud-content-hydrator.ts  # Content inflation from signed URLs
├── plaud-vault.ts             # Vault note identity and upsert logic
├── plaud-sync.ts              # Incremental sync orchestration
├── plaud-retry.ts             # Retry/backoff with telemetry sanitization
└── sync-runtime.ts            # Single-flight sync guard
test/
└── *.test.mjs                 # Matching test suite for each module

browser-extension/             # Companion Chrome/Edge extension (own package.json, own tests)
├── manifest.json              # Manifest V3
├── shared.js                  # Constants/helpers shared by all three scripts below
├── content-script.js          # Reads the Plaud token from web.plaud.ai's localStorage
├── background.js              # Service worker; pushes the token to the plugin's listener
├── options.html / options.js  # Port + secret configuration UI
└── test/                      # 49-test suite (Node's native test runner, zero dependencies)
```

## Legal Basis

This is an **unofficial** community plugin, not affiliated with or endorsed by PLAUD, Inc.

### Interoperability under EU law

This project is developed and distributed under the interoperability provisions of **EU Directive 2009/24/EC** (the Software Directive):

- **Article 5(3)** permits users to observe, study, and test software to determine underlying ideas and principles
- **Article 6** permits decompilation and reverse engineering when necessary to achieve interoperability with independently created software
- **Article 9** renders contractual clauses restricting these rights null and void

The Court of Justice of the European Union has consistently upheld these protections, notably in *SAS Institute v. World Programming* (C-406/10) and *Top System v. Belgian State* (C-13/20).

### Interoperability intent

This plugin enables PLAUD users to connect their recording data with [Obsidian](https://obsidian.md/), an independently created knowledge management application. PLAUD already supports third-party automation through their official Zapier integration, demonstrating acceptance of interoperability use cases. This project extends similar functionality to the Obsidian ecosystem.

### Disclaimer

This software is provided as-is for interoperability purposes. Users are responsible for compliance with PLAUD's Terms of Service and applicable laws in their jurisdiction. The maintainers make no warranty regarding account standing or service availability.

## Contributing

Contributions are welcome. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) — Leonard Sellem
