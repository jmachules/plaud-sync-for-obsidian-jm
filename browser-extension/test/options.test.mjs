import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createStorageAreaMock, runInContext} from './helpers/sandbox.mjs';

function createElementMock(initial = {}) {
	return {
		value: initial.value ?? '',
		textContent: initial.textContent ?? '',
		style: {},
		_listeners: {},
		addEventListener(type, fn) {
			this._listeners[type] = fn;
		},
		click() {
			this._listeners.click?.();
		}
	};
}

function flushMicrotasks() {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

async function loadOptions({storage = {}} = {}) {
	const storageArea = createStorageAreaMock(storage);
	const elements = {
		port: createElementMock(),
		secret: createElementMock(),
		save: createElementMock(),
		saved: createElementMock(),
		status: createElementMock()
	};

	const document = {
		getElementById(id) {
			return elements[id];
		}
	};

	const context = vm.createContext({
		console,
		document,
		setTimeout,
		chrome: {
			storage: {
				local: storageArea,
				onChanged: storageArea.onChanged
			}
		}
	});

	runInContext(context, 'shared.js');
	runInContext(context, 'options.js');

	// options.js's own top-level `void refresh();` call is async and unawaited by the script
	// itself -- give its storage.local.get(...) microtasks a turn before tests inspect the DOM.
	await flushMicrotasks();
	await flushMicrotasks();

	return {elements, storageArea, context};
}

test('initial load populates the input fields and status text from storage', async () => {
	const {elements} = await loadOptions({
		storage: {port: 8765, secret: 's3cret', lastStatus: 'ok', lastStatusAt: 1700000000000}
	});

	assert.equal(elements.port.value, 8765);
	assert.equal(elements.secret.value, 's3cret');
	assert.match(elements.status.textContent, /Last push: ok at/);
});

test('with nothing configured, status explains what to do', async () => {
	const {elements} = await loadOptions({storage: {}});
	assert.match(elements.status.textContent, /not_configured/);
});

test('configured but no push yet shows the "open a tab" guidance', async () => {
	const {elements} = await loadOptions({storage: {port: 8765, secret: 's3cret'}});
	assert.match(elements.status.textContent, /No push yet/);
});

test('save() rejects an out-of-range port without writing to storage', async () => {
	const {elements, storageArea} = await loadOptions({storage: {}});
	elements.port.value = '80'; // below the 1024 minimum
	elements.secret.value = 's3cret';
	elements.save.click();
	await flushMicrotasks();

	assert.match(elements.status.textContent, /between 1024 and 65535/);
	assert.equal(storageArea._store.has('port'), false);
});

test('save() rejects an empty secret without writing to storage', async () => {
	const {elements, storageArea} = await loadOptions({storage: {}});
	elements.port.value = '8765';
	elements.secret.value = '   ';
	elements.save.click();
	await flushMicrotasks();

	assert.match(elements.status.textContent, /Secret cannot be empty/);
	assert.equal(storageArea._store.has('secret'), false);
});

test('save() with valid input writes port and secret to storage', async () => {
	const {elements, storageArea} = await loadOptions({storage: {}});
	elements.port.value = '9000';
	elements.secret.value = 'my-secret';
	elements.save.click();
	await flushMicrotasks();
	await flushMicrotasks();

	assert.equal(storageArea._store.get('port'), 9000);
	assert.equal(storageArea._store.get('secret'), 'my-secret');
});

test('a routine status-only storage change updates the status text without touching the input fields (regression)', async () => {
	// Found during review: the original onChanged listener called the full refresh() (which
	// repopulates the port/secret <input> values) on ANY watched key change, including the
	// status keys background.js writes on every push (~every 60s) -- silently overwriting
	// whatever the user was mid-typing into the port/secret fields.
	const {elements, storageArea} = await loadOptions({storage: {port: 8765, secret: 's3cret'}});

	// Simulate the user mid-typing a different port than what's actually stored.
	elements.port.value = '9999';
	elements.secret.value = 'still-typing';

	// Simulate background.js's routine status write (not a credential change).
	await storageArea.set({lastStatus: 'ok', lastStatusAt: Date.now(), lastPushAmbiguous: false});
	await flushMicrotasks();

	assert.equal(elements.port.value, '9999', 'in-progress port edit must survive a status update');
	assert.equal(elements.secret.value, 'still-typing', 'in-progress secret edit must survive a status update');
	assert.match(elements.status.textContent, /Last push: ok at/, 'status text should still update');
});

test('a genuine port/secret storage change does repopulate the input fields', async () => {
	const {elements, storageArea} = await loadOptions({storage: {port: 8765, secret: 'old'}});

	await storageArea.set({port: 9000, secret: 'new-secret'});
	await flushMicrotasks();

	assert.equal(elements.port.value, 9000);
	assert.equal(elements.secret.value, 'new-secret');
});

test('ambiguous note is appended when lastPushAmbiguous is true, even while not configured', async () => {
	// Found during review: renderStatus() used to return early from the not-configured branch
	// without ever checking lastPushAmbiguous, hiding the warning on first-time setup.
	const {elements} = await loadOptions({storage: {lastPushAmbiguous: true}});
	assert.match(elements.status.textContent, /not_configured/);
	assert.match(elements.status.textContent, /multiple workspaces\/accounts/);
});

test('ambiguous note is appended to a normal ok status line', async () => {
	const {elements} = await loadOptions({
		storage: {
			port: 8765,
			secret: 's3cret',
			lastStatus: 'ok',
			lastStatusAt: Date.now(),
			lastPushAmbiguous: true
		}
	});
	assert.match(elements.status.textContent, /Last push: ok at/);
	assert.match(elements.status.textContent, /multiple workspaces\/accounts/);
});

test('no ambiguous note when lastPushAmbiguous is false', async () => {
	const {elements} = await loadOptions({
		storage: {port: 8765, secret: 's3cret', lastStatus: 'ok', lastStatusAt: Date.now(), lastPushAmbiguous: false}
	});
	assert.doesNotMatch(elements.status.textContent, /multiple workspaces/);
});
