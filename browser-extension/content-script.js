// Runs on web.plaud.ai. Reads the workspace token the web app already keeps fresh in
// localStorage and forwards it to the background service worker on change. Never talks to the
// network directly -- see docs/browser-token-bridge.md (plaud-sync-for-obsidian-jm repo) section 3
// for how this key was found and what could break if Plaud changes their web app again.
//
// Depends on shared.js being loaded first (see manifest.json content_scripts) for
// MESSAGE_TYPE_TOKEN.

const POLL_INTERVAL_MS = 60_000;
const WORKSPACE_LIST_KEY_SUFFIX = ':workspaceList';

let lastSentToken = null;
let lastSentAmbiguous = null;

function findWorkspaceListKeys() {
	const keys = [];
	for (let i = 0; i < localStorage.length; i += 1) {
		const key = localStorage.key(i);
		if (key && key.endsWith(WORKSPACE_LIST_KEY_SUFFIX)) {
			keys.push(key);
		}
	}
	return keys;
}

function readWorkspaceEntry() {
	const keys = findWorkspaceListKeys();
	if (keys.length === 0) {
		return null;
	}

	const raw = localStorage.getItem(keys[0]);
	if (!raw) {
		return null;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed) || parsed.length === 0) {
		return null;
	}

	const entry = parsed[0];
	const token = typeof entry?.workspaceToken === 'string' ? entry.workspaceToken.trim() : '';
	if (!token) {
		return null;
	}

	const expiresAt = typeof entry?.expiresAt === 'number' ? entry.expiresAt : undefined;

	// This always uses the first matching localStorage key and the first entry in its array --
	// the design doc documents that shape for a single-workspace account, but doesn't guarantee
	// ordering when there's more than one workspace, or more than one *:workspaceList key (e.g.
	// a stale key left behind by a previous login). There's no reliable signal here for which
	// one is "current", so rather than guess, surface the ambiguity to the user instead of
	// silently picking one and reporting success either way.
	const ambiguous = keys.length > 1 || parsed.length > 1;

	return {token, expiresAt, ambiguous};
}

function checkAndForward() {
	const entry = readWorkspaceEntry();
	if (!entry) {
		return;
	}

	// Re-send if either the token OR the ambiguity signal changed -- a token that's unchanged
	// but newly ambiguous (e.g. a second *:workspaceList key just appeared) still needs to reach
	// the options page, and gating purely on the token would silently drop that update forever.
	if (entry.token === lastSentToken && entry.ambiguous === lastSentAmbiguous) {
		return;
	}

	chrome.runtime.sendMessage(
		{
			type: MESSAGE_TYPE_TOKEN,
			token: entry.token,
			expiresAt: entry.expiresAt,
			ambiguous: entry.ambiguous
		},
		(response) => {
			// Don't mark as sent unless the push actually succeeded -- either the message
			// channel failed (chrome.runtime.lastError) or the push itself failed (response.ok
			// is false: wrong secret, bridge unreachable, etc). In both cases the next 60s poll
			// should retry with the same (still-current) token/ambiguity instead of going silent.
			if (chrome.runtime.lastError || !response?.ok) {
				return;
			}
			lastSentToken = entry.token;
			lastSentAmbiguous = entry.ambiguous;
		}
	);
}

checkAndForward();
setInterval(checkAndForward, POLL_INTERVAL_MS);
