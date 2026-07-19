import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createLocalStorageMock, runInContext} from './helpers/sandbox.mjs';

function workspaceList(entries) {
	return JSON.stringify(entries);
}

// Loads the real content-script.js (and shared.js, which it depends on) into a sandbox. Note
// that content-script.js calls checkAndForward() once immediately at top level on load (the
// real "run on page load" behavior) -- so sentMessages may already contain one entry by the
// time this returns, before any test code calls checkAndForward() itself.
function loadContentScript({localStorageData = {}, sendMessageImpl} = {}) {
	const localStorage = createLocalStorageMock(localStorageData);
	const sentMessages = [];

	const chrome = {
		runtime: {
			lastError: undefined,
			sendMessage(message, callback) {
				sentMessages.push(message);
				if (sendMessageImpl) {
					sendMessageImpl(message, callback, chrome);
				} else {
					callback?.({ok: true});
				}
			}
		}
	};

	const context = vm.createContext({
		localStorage,
		chrome,
		console,
		// content-script.js registers a real setInterval(checkAndForward, 60000) at load time;
		// tests drive checkAndForward() directly instead of waiting on it, so these are no-ops.
		setInterval: () => 0,
		clearInterval: () => {}
	});

	runInContext(context, 'shared.js');
	runInContext(context, 'content-script.js');

	return {context, localStorage, sentMessages, chrome};
}

test('readWorkspaceEntry: no matching localStorage key returns null', () => {
	const {context} = loadContentScript({localStorageData: {}});
	assert.equal(context.readWorkspaceEntry(), null);
});

test('readWorkspaceEntry: a key not ending in :workspaceList is ignored', () => {
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:somethingElse': workspaceList([{workspaceToken: 'nope'}])}
	});
	assert.equal(context.readWorkspaceEntry(), null);
});

test('readWorkspaceEntry: malformed JSON returns null instead of throwing', () => {
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': 'not valid json{{'}
	});
	assert.equal(context.readWorkspaceEntry(), null);
});

test('readWorkspaceEntry: empty array returns null', () => {
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([])}
	});
	assert.equal(context.readWorkspaceEntry(), null);
});

test('readWorkspaceEntry: entry missing workspaceToken returns null', () => {
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{expiresAt: 123}])}
	});
	assert.equal(context.readWorkspaceEntry(), null);
});

test('readWorkspaceEntry: blank workspaceToken (whitespace only) returns null', () => {
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{workspaceToken: '   '}])}
	});
	assert.equal(context.readWorkspaceEntry(), null);
});

test('readWorkspaceEntry: single workspace, single key -> not ambiguous', () => {
	const {context} = loadContentScript({
		localStorageData: {
			'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1', expiresAt: 999}])
		}
	});
	const entry = context.readWorkspaceEntry();
	// Not deepEqual against a plain object literal: entry was created inside the vm context, a
	// different realm with its own Object.prototype, so strict deep-equality on the whole object
	// would spuriously fail on prototype identity even with identical own-properties.
	assert.equal(entry.token, 'tok_1');
	assert.equal(entry.expiresAt, 999);
	assert.equal(entry.ambiguous, false);
});

test('readWorkspaceEntry: non-numeric expiresAt is dropped, not coerced', () => {
	const {context} = loadContentScript({
		localStorageData: {
			'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1', expiresAt: 'soon'}])
		}
	});
	const entry = context.readWorkspaceEntry();
	assert.equal(entry.token, 'tok_1');
	assert.equal(entry.expiresAt, undefined);
});

test('readWorkspaceEntry: multiple workspaces in the array is flagged ambiguous', () => {
	const {context} = loadContentScript({
		localStorageData: {
			'pld_abc:workspaceList': workspaceList([
				{workspaceToken: 'tok_1'},
				{workspaceToken: 'tok_2'}
			])
		}
	});
	const entry = context.readWorkspaceEntry();
	assert.equal(entry.token, 'tok_1', 'still uses the first entry');
	assert.equal(entry.ambiguous, true);
});

test('readWorkspaceEntry: multiple matching localStorage keys is flagged ambiguous', () => {
	const {context} = loadContentScript({
		localStorageData: {
			'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1'}]),
			'pld_stale:workspaceList': workspaceList([{workspaceToken: 'tok_stale'}])
		}
	});
	assert.equal(context.readWorkspaceEntry().ambiguous, true);
});

test('checkAndForward: does not resend an unchanged token/ambiguous pair', () => {
	const sentMessages = [];
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1'}])},
		sendMessageImpl: (message, callback) => {
			sentMessages.push(message);
			callback?.({ok: true});
		}
	});
	assert.equal(sentMessages.length, 1, 'the load-time checkAndForward() call already sent once');

	context.checkAndForward();
	context.checkAndForward();
	assert.equal(sentMessages.length, 1, 'no new sends once the same token/ambiguous succeeded');
});

test('checkAndForward: resends when the token value changes', () => {
	const sentMessages = [];
	const {context, localStorage} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1'}])},
		sendMessageImpl: (message, callback) => {
			sentMessages.push(message);
			callback?.({ok: true});
		}
	});
	assert.equal(sentMessages.length, 1);

	localStorage.setItem('pld_abc:workspaceList', workspaceList([{workspaceToken: 'tok_2'}]));
	context.checkAndForward();
	assert.equal(sentMessages.length, 2);
	assert.equal(sentMessages[1].token, 'tok_2');
});

test('checkAndForward: resends when only the ambiguous flag changes (regression)', () => {
	// Found during review: the original dedup gated purely on token value, so a newly-true
	// ambiguous flag on an unchanged token was silently never forwarded.
	const sentMessages = [];
	const {context, localStorage} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1'}])},
		sendMessageImpl: (message, callback) => {
			sentMessages.push(message);
			callback?.({ok: true});
		}
	});
	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].ambiguous, false);

	localStorage.setItem('pld_stale:workspaceList', workspaceList([{workspaceToken: 'tok_stale'}]));
	context.checkAndForward();
	assert.equal(sentMessages.length, 2, 'the ambiguity change alone must trigger a resend');
	assert.equal(sentMessages[1].token, 'tok_1', 'token itself is unchanged');
	assert.equal(sentMessages[1].ambiguous, true);
});

test('checkAndForward: a failed push (response.ok false) does not suppress the next retry (regression)', () => {
	// Found during review: pushToken used to always resolve "successfully" from the content
	// script's point of view even when the push itself failed, permanently suppressing retries.
	const sentMessages = [];
	let succeed = false;
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1'}])},
		sendMessageImpl: (message, callback) => {
			sentMessages.push(message);
			callback?.({ok: succeed});
		}
	});
	assert.equal(sentMessages.length, 1, 'initial push (fails, since succeed starts false)');

	context.checkAndForward();
	assert.equal(sentMessages.length, 2, 'a failed push must be retried on the next poll');

	succeed = true;
	context.checkAndForward();
	assert.equal(sentMessages.length, 3, 'retried push now succeeds');

	context.checkAndForward();
	assert.equal(sentMessages.length, 3, 'a succeeded push must stop being resent');
});

test('checkAndForward: a message-channel failure (chrome.runtime.lastError) does not suppress the next retry', () => {
	const sentMessages = [];
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1'}])},
		sendMessageImpl: (message, callback, chrome) => {
			sentMessages.push(message);
			chrome.runtime.lastError = {message: 'no receiver'};
			callback?.();
			chrome.runtime.lastError = undefined;
		}
	});
	assert.equal(sentMessages.length, 1);
	context.checkAndForward();
	assert.equal(sentMessages.length, 2, 'a dropped message must be retried, not treated as sent');
});

test('checkAndForward: a missing response (undefined) is treated as failure, not success', () => {
	const sentMessages = [];
	const {context} = loadContentScript({
		localStorageData: {'pld_abc:workspaceList': workspaceList([{workspaceToken: 'tok_1'}])},
		sendMessageImpl: (message, callback) => {
			sentMessages.push(message);
			callback?.(); // no response object at all
		}
	});
	assert.equal(sentMessages.length, 1);
	context.checkAndForward();
	assert.equal(sentMessages.length, 2, 'an undefined response must not be read as ok');
});
