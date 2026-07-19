// Loads the extension's real, unmodified source files into a Node vm context with mocked
// browser APIs, so tests exercise the actual shipped code rather than a re-implementation kept
// in sync by hand. Function declarations at a script's top level become properties of the vm
// context (so e.g. context.readWorkspaceEntry() is callable from tests); const/let bindings do
// not, but remain visible via closures to functions declared in the same or later
// vm.runInContext calls on that same context -- which is exactly how content-script.js depends
// on shared.js's MESSAGE_TYPE_TOKEN and how background.js's importScripts('shared.js') works.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(HERE, '..', '..');

export function readSource(filename) {
	return fs.readFileSync(path.join(EXT_DIR, filename), 'utf8');
}

export function runInContext(context, filename) {
	vm.runInContext(readSource(filename), context, {filename});
}

export function createLocalStorageMock(initial = {}) {
	const backing = new Map(Object.entries(initial));
	return {
		get length() {
			return backing.size;
		},
		key(index) {
			return [...backing.keys()][index] ?? null;
		},
		getItem(key) {
			return backing.has(key) ? backing.get(key) : null;
		},
		setItem(key, value) {
			backing.set(key, String(value));
		},
		removeItem(key) {
			backing.delete(key);
		},
		_backing: backing
	};
}

// A minimal chrome.storage.local + chrome.storage.onChanged mock shared by the background.js
// and options.js sandboxes, so both exercise the same semantics real chrome.storage.local has:
// get() only returns keys that exist, set() fires onChanged listeners with {oldValue, newValue}.
export function createStorageAreaMock(initial = {}) {
	const store = new Map(Object.entries(initial));
	const changeListeners = [];

	return {
		async get(keys) {
			const keyList = Array.isArray(keys) ? keys : [keys];
			const result = {};
			for (const key of keyList) {
				if (store.has(key)) {
					result[key] = store.get(key);
				}
			}
			return result;
		},
		async set(patch) {
			const changes = {};
			for (const [key, newValue] of Object.entries(patch)) {
				changes[key] = {oldValue: store.get(key), newValue};
				store.set(key, newValue);
			}
			for (const listener of changeListeners) {
				listener(changes, 'local');
			}
		},
		onChanged: {
			addListener(fn) {
				changeListeners.push(fn);
			}
		},
		_store: store
	};
}

// Controllable fake timers so tests can exercise the AbortController timeout path without
// actually waiting on real time.
export function createFakeTimers() {
	let idCounter = 0;
	const pending = new Map();
	return {
		setTimeout(fn) {
			const id = (idCounter += 1);
			pending.set(id, fn);
			return id;
		},
		clearTimeout(id) {
			pending.delete(id);
		},
		flush() {
			const fns = [...pending.values()];
			pending.clear();
			for (const fn of fns) {
				fn();
			}
		},
		pendingCount() {
			return pending.size;
		}
	};
}
