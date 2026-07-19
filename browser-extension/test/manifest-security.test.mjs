// Static hardening checks for the extension's security-relevant surface: permission scope,
// XSS-prone JS patterns, and remote code loading. These aren't bugs in the functional sense --
// they're invariants worth pinning down with a failing test the moment they regress, since this
// is the piece that reads a live session token out of a webpage and relays it over HTTP.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EXT_DIR, readSource} from './helpers/sandbox.mjs';

const manifest = JSON.parse(readSource('manifest.json'));

test('manifest_version is 3 (not the weaker MV2 security/permission model)', () => {
	assert.equal(manifest.manifest_version, 3);
});

test('permissions requests exactly ["storage"] -- nothing broader', () => {
	assert.deepEqual(manifest.permissions, ['storage']);
});

test('host_permissions covers exactly the two required origins -- nothing broader', () => {
	assert.deepEqual(
		[...manifest.host_permissions].sort(),
		['*://web.plaud.ai/*', 'http://127.0.0.1/*'].sort()
	);
});

test('no <all_urls> or overly broad match pattern anywhere in the manifest', () => {
	const serialized = JSON.stringify(manifest);
	assert.doesNotMatch(serialized, /<all_urls>/);
	assert.doesNotMatch(serialized, /\*:\/\/\*\//, 'a "*://*/*"-style pattern would match every site');
});

test('no web_accessible_resources -- nothing in this extension should be exposed to web pages', () => {
	assert.equal('web_accessible_resources' in manifest, false);
});

test('background service worker has no "persistent" key (an MV2 concept; MV3 workers are never persistent)', () => {
	assert.equal('persistent' in manifest.background, false);
});

test('content_scripts only ever targets web.plaud.ai', () => {
	for (const entry of manifest.content_scripts) {
		for (const pattern of entry.matches) {
			assert.match(pattern, /^\*:\/\/web\.plaud\.ai\/\*$/);
		}
	}
});

const SHIPPED_JS_FILES = ['shared.js', 'content-script.js', 'background.js', 'options.js'];

test('no eval(), new Function(), or innerHTML assignment in any shipped script', () => {
	for (const filename of SHIPPED_JS_FILES) {
		const source = readSource(filename);
		assert.doesNotMatch(source, /\beval\s*\(/, `${filename}: eval() found`);
		assert.doesNotMatch(source, /\bnew Function\s*\(/, `${filename}: new Function() found`);
		assert.doesNotMatch(source, /\.innerHTML\s*=/, `${filename}: .innerHTML assignment found`);
	}
});

test('no remote script loading -- every <script src> in options.html is a local relative file', () => {
	const html = readSource('options.html');
	const scriptSrcPattern = /<script\s+src=["']([^"']+)["']/g;
	const sources = [...html.matchAll(scriptSrcPattern)].map((match) => match[1]);
	assert.ok(sources.length > 0, 'sanity check: options.html should reference at least one script');
	for (const src of sources) {
		assert.doesNotMatch(src, /^https?:\/\//, `remote script source found: ${src}`);
		assert.ok(fs.existsSync(path.join(EXT_DIR, src)), `referenced script does not exist: ${src}`);
	}
});

test('every JS file referenced by manifest.json actually exists in the folder', () => {
	const referenced = new Set();
	for (const entry of manifest.content_scripts) {
		for (const file of entry.js) {
			referenced.add(file);
		}
	}
	if (manifest.background?.service_worker) {
		referenced.add(manifest.background.service_worker);
	}
	for (const file of referenced) {
		assert.ok(fs.existsSync(path.join(EXT_DIR, file)), `manifest references missing file: ${file}`);
	}
});
