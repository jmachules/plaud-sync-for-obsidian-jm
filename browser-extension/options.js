// Depends on shared.js being loaded first (see options.html) for isBridgeConfigured.

const portInput = document.getElementById('port');
const secretInput = document.getElementById('secret');
const saveButton = document.getElementById('save');
const savedLabel = document.getElementById('saved');
const statusEl = document.getElementById('status');

const CREDENTIAL_KEYS = ['port', 'secret'];
const STATUS_KEYS = ['lastStatus', 'lastStatusAt', 'lastPushAmbiguous'];
const STORAGE_KEYS = [...CREDENTIAL_KEYS, ...STATUS_KEYS];

async function refresh() {
	const stored = await chrome.storage.local.get(STORAGE_KEYS);
	applyStoredCredentials(stored);
	renderStatus(stored);
}

function applyStoredCredentials({port, secret}) {
	if (port) {
		portInput.value = port;
	}
	if (secret) {
		secretInput.value = secret;
	}
}

async function refreshStatusOnly() {
	const stored = await chrome.storage.local.get(STORAGE_KEYS);
	renderStatus(stored);
}

function renderStatus({port, secret, lastStatus, lastStatusAt, lastPushAmbiguous}) {
	const ambiguousNote = lastPushAmbiguous
		? ' Note: multiple workspaces/accounts were detected -- this may not be the token you '
			+ 'expect; see README.'
		: '';

	if (!isBridgeConfigured({port, secret})) {
		statusEl.textContent = 'not_configured -- paste the port and secret above, then Save.'
			+ ambiguousNote;
		return;
	}

	if (!lastStatus) {
		statusEl.textContent = 'No push yet. Open a web.plaud.ai tab where you\'re already logged '
			+ 'in and leave it open -- the content script checks every 60s.';
		return;
	}

	const when = lastStatusAt ? new Date(lastStatusAt).toLocaleString() : 'unknown time';
	statusEl.textContent = `Last push: ${lastStatus} at ${when}${ambiguousNote}`;
}

async function save() {
	const port = Number.parseInt(portInput.value, 10);
	const secret = secretInput.value.trim();

	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		statusEl.textContent = 'Port must be a number between 1024 and 65535.';
		return;
	}

	if (!secret) {
		statusEl.textContent = 'Secret cannot be empty.';
		return;
	}

	await chrome.storage.local.set({port, secret});
	savedLabel.style.display = 'inline';
	setTimeout(() => {
		savedLabel.style.display = 'none';
	}, 1500);
	// No explicit refresh() call here -- the storage.onChanged listener below reacts to this
	// same set() call and re-renders, so there's exactly one path that keeps the UI in sync
	// with storage instead of two.
}

saveButton.addEventListener('click', () => {
	void save();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== 'local') {
		return;
	}

	// Split on which keys actually changed: background.js writes the status keys on every push
	// attempt (roughly every 60s), which must never repopulate the port/secret inputs and risk
	// clobbering whatever the user is mid-typing. Only a genuine port/secret change (this page's
	// own Save, or another options tab's Save) should touch those fields.
	if (CREDENTIAL_KEYS.some((key) => key in changes)) {
		void refresh();
		return;
	}

	if (STATUS_KEYS.some((key) => key in changes)) {
		void refreshStatusOnly();
	}
});

void refresh();
