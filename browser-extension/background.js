// Service worker. Receives token pushes from content-script.js and relays them to the local
// Obsidian Plaud Sync bridge listener (127.0.0.1:<port>/token, loopback-only). Never talks to
// web.plaud.ai -- only reads {port, secret} out of chrome.storage.local and POSTs to the local
// listener. See docs/browser-token-bridge.md section 8 for the security model.

importScripts('shared.js');

const PUSH_TIMEOUT_MS = 5000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || message.type !== MESSAGE_TYPE_TOKEN) {
		return false;
	}

	const ambiguous = Boolean(message.ambiguous);

	pushToken(message.token, message.expiresAt, ambiguous)
		.then((ok) => sendResponse({ok}))
		.catch((error) => {
			// Anything that reaches here happened outside pushToken's own handled failure paths
			// (e.g. chrome.storage.local.get/set rejecting after an extension reload) -- record
			// and log it instead of silently discarding it, so it's not indistinguishable from a
			// documented status on the options page. recordStatus itself writes to storage, so
			// it can fail for the same underlying reason this catch fired for -- .catch(noop)
			// plus .finally() guarantees sendResponse still fires either way, rather than leaving
			// the message port hanging on a second, unrelated unhandled rejection.
			recordStatus('extension_error', ambiguous, error)
				.catch(() => {})
				.finally(() => sendResponse({ok: false}));
		});

	return true; // keep the message channel open for the async response
});

async function pushToken(token, expiresAt, ambiguous) {
	const {port, secret} = await chrome.storage.local.get(['port', 'secret']);

	if (!isBridgeConfigured({port, secret})) {
		await recordStatus('not_configured', ambiguous);
		return false;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

	let response;
	try {
		response = await fetch(`http://127.0.0.1:${port}/token`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-bridge-secret': secret
			},
			body: JSON.stringify({token, expiresAt}),
			signal: controller.signal
		});
	} catch (error) {
		await recordStatus('network_error', ambiguous, error);
		return false;
	} finally {
		clearTimeout(timeout);
	}

	if (response.ok) {
		await recordStatus('ok', ambiguous);
		return true;
	}

	await recordStatus(`http_${response.status}`, ambiguous);
	return false;
}

async function recordStatus(status, ambiguous, error) {
	if (error) {
		console.error('[plaud-token-bridge]', status, error);
	}
	await chrome.storage.local.set({
		lastStatus: status,
		lastStatusAt: Date.now(),
		lastPushAmbiguous: Boolean(ambiguous)
	});
}
