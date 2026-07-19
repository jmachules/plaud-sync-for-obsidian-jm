import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createFakeTimers, createStorageAreaMock, runInContext} from './helpers/sandbox.mjs';

// Loads the real background.js (and, via its own importScripts('shared.js') call, shared.js)
// into a sandbox. background.js registers its onMessage listener at load time; dispatch()
// below drives it the same way chrome would when a real message arrives.
function loadBackground({storage = {}, fetchImpl, timers = createFakeTimers()} = {}) {
	const storageArea = createStorageAreaMock(storage);
	const consoleErrors = [];
	let messageListener;

	let context; // referenced by the importScripts closure below before assignment completes
	const sandbox = {
		// Real console.error calls here are the code correctly logging real failure scenarios
		// these tests intentionally trigger -- capture them instead of printing, so test output
		// stays readable and a real assertion failure isn't buried in expected noise.
		console: {...console, error: (...args) => consoleErrors.push(args)},
		fetch: fetchImpl,
		AbortController: globalThis.AbortController,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		importScripts(specifier) {
			runInContext(context, specifier);
		},
		chrome: {
			storage: {local: storageArea},
			runtime: {
				onMessage: {
					addListener(fn) {
						messageListener = fn;
					}
				}
			}
		}
	};

	context = vm.createContext(sandbox);
	runInContext(context, 'background.js');

	return {
		context,
		storageArea,
		timers,
		consoleErrors,
		dispatch(message) {
			return new Promise((resolve) => {
				const keepOpen = messageListener(message, {}, resolve);
				assert.equal(keepOpen, true, 'listener must return true to keep the channel open');
			});
		},
		dispatchUnknown(message) {
			return messageListener(message, {}, () => {
				throw new Error('sendResponse should not be called for an unrecognized message');
			});
		}
	};
}

test('unrecognized message type is ignored (listener returns false, no storage access)', () => {
	const {storageArea, dispatchUnknown} = loadBackground({storage: {port: 8765, secret: 's3cret'}});
	const result = dispatchUnknown({type: 'something-else'});
	assert.equal(result, false);
	assert.equal(storageArea._store.has('lastStatus'), false);
});

test('not_configured when port or secret is missing', async () => {
	const {storageArea, dispatch} = loadBackground({storage: {}});
	const response = await dispatch({type: 'plaud-token-bridge/token', token: 'tok_1'});
	assert.equal(response.ok, false);
	assert.equal(storageArea._store.get('lastStatus'), 'not_configured');
	assert.equal(storageArea._store.get('lastPushAmbiguous'), false);
});

test('ok on a successful 2xx push, with the correct request shape', async () => {
	let capturedUrl;
	let capturedOptions;
	const fetchImpl = async (url, options) => {
		capturedUrl = url;
		capturedOptions = options;
		return {ok: true, status: 200};
	};

	const {storageArea, dispatch} = loadBackground({
		storage: {port: 8765, secret: 's3cret'},
		fetchImpl
	});

	const response = await dispatch({
		type: 'plaud-token-bridge/token',
		token: 'tok_1',
		expiresAt: 12345,
		ambiguous: true
	});

	assert.equal(response.ok, true);
	assert.equal(storageArea._store.get('lastStatus'), 'ok');
	assert.equal(storageArea._store.get('lastPushAmbiguous'), true);
	assert.equal(typeof storageArea._store.get('lastStatusAt'), 'number');

	assert.equal(capturedUrl, 'http://127.0.0.1:8765/token');
	assert.equal(capturedOptions.method, 'POST');
	assert.equal(capturedOptions.headers['x-bridge-secret'], 's3cret');
	assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
	assert.deepEqual(JSON.parse(capturedOptions.body), {token: 'tok_1', expiresAt: 12345});
	assert.ok(capturedOptions.signal, 'fetch must be given an abort signal');
});

test('http_<status> on a non-2xx response', async () => {
	const fetchImpl = async () => ({ok: false, status: 401});
	const {storageArea, dispatch} = loadBackground({
		storage: {port: 8765, secret: 'wrong'},
		fetchImpl
	});

	const response = await dispatch({type: 'plaud-token-bridge/token', token: 'tok_1'});
	assert.equal(response.ok, false);
	assert.equal(storageArea._store.get('lastStatus'), 'http_401');
});

test('network_error when fetch rejects, and the real error is logged for debugging', async () => {
	const fetchImpl = async () => {
		throw new Error('ECONNREFUSED');
	};
	const {storageArea, dispatch, consoleErrors} = loadBackground({
		storage: {port: 8765, secret: 's3cret'},
		fetchImpl
	});

	const response = await dispatch({type: 'plaud-token-bridge/token', token: 'tok_1'});
	assert.equal(response.ok, false);
	assert.equal(storageArea._store.get('lastStatus'), 'network_error');
	assert.equal(consoleErrors.length, 1);
});

test('a hung fetch is aborted by the timeout and reported as network_error', async () => {
	const timers = createFakeTimers();
	let observedSignal;
	const fetchImpl = (url, options) => {
		observedSignal = options.signal;
		return new Promise((resolve, reject) => {
			options.signal.addEventListener('abort', () => {
				reject(new Error('The operation was aborted'));
			});
		});
	};

	const {storageArea, dispatch} = loadBackground({
		storage: {port: 8765, secret: 's3cret'},
		fetchImpl,
		timers
	});

	const responsePromise = dispatch({type: 'plaud-token-bridge/token', token: 'tok_1'});
	// pushToken() awaits chrome.storage.local.get(...) before reaching the setTimeout call, so
	// let that microtask chain settle before asserting the timer was scheduled.
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
	assert.equal(timers.pendingCount(), 1, 'a timeout timer should have been scheduled');
	timers.flush();
	const response = await responsePromise;

	assert.equal(response.ok, false);
	assert.equal(storageArea._store.get('lastStatus'), 'network_error');
	assert.equal(observedSignal.aborted, true);
	assert.equal(timers.pendingCount(), 0, 'the timer must be cleared after settling (finally block)');
});

test('the timeout timer is cleared on a normal (non-hung) response too', async () => {
	const timers = createFakeTimers();
	const fetchImpl = async () => ({ok: true, status: 200});
	const {dispatch} = loadBackground({
		storage: {port: 8765, secret: 's3cret'},
		fetchImpl,
		timers
	});

	await dispatch({type: 'plaud-token-bridge/token', token: 'tok_1'});
	assert.equal(timers.pendingCount(), 0, 'clearTimeout must run even when the fetch succeeds');
});

test('an error outside pushToken (e.g. storage.get rejecting) is recorded as extension_error, preserving the real ambiguous value (regression)', async () => {
	// Found during review: this path used to hardcode ambiguous:false, discarding whatever the
	// message actually said.
	const {storageArea, dispatch, consoleErrors} = loadBackground({storage: {port: 8765, secret: 's3cret'}});
	storageArea.get = async () => {
		throw new Error('Extension context invalidated.');
	};

	const response = await dispatch({type: 'plaud-token-bridge/token', token: 'tok_1', ambiguous: true});
	assert.equal(response.ok, false);
	assert.equal(storageArea._store.get('lastStatus'), 'extension_error');
	assert.equal(storageArea._store.get('lastPushAmbiguous'), true);
	assert.equal(consoleErrors.length, 1, 'the real error must be logged, not silently discarded');
});

test('sendResponse still fires even if recordStatus itself fails in the extension_error path', async () => {
	// Found during review: without .catch(noop).finally(...), a second failure inside the error
	// handler itself (e.g. storage.set also broken) would leave sendResponse never called.
	const {storageArea, dispatch} = loadBackground({storage: {port: 8765, secret: 's3cret'}});
	storageArea.get = async () => {
		throw new Error('Extension context invalidated.');
	};
	storageArea.set = async () => {
		throw new Error('storage.set also broken');
	};

	const response = await dispatch({type: 'plaud-token-bridge/token', token: 'tok_1'});
	assert.equal(response.ok, false);
});

test('lastError is never written to storage (dead field removed)', async () => {
	const fetchImpl = async () => ({ok: false, status: 500});
	const {storageArea, dispatch} = loadBackground({
		storage: {port: 8765, secret: 's3cret'},
		fetchImpl
	});

	await dispatch({type: 'plaud-token-bridge/token', token: 'tok_1'});
	assert.equal(storageArea._store.has('lastError'), false);
});
