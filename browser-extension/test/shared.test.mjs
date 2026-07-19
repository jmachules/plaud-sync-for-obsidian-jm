import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {runInContext} from './helpers/sandbox.mjs';

function load() {
	const context = vm.createContext({});
	runInContext(context, 'shared.js');
	return context;
}

test('isBridgeConfigured requires both port and secret', () => {
	const {isBridgeConfigured} = load();
	assert.equal(isBridgeConfigured({port: 8765, secret: 'x'}), true);
	assert.equal(isBridgeConfigured({port: undefined, secret: 'x'}), false);
	assert.equal(isBridgeConfigured({port: 8765, secret: undefined}), false);
	assert.equal(isBridgeConfigured({port: undefined, secret: undefined}), false);
	assert.equal(isBridgeConfigured({port: 0, secret: 'x'}), false, '0 is falsy, same as unset');
	assert.equal(isBridgeConfigured({port: 8765, secret: ''}), false, 'empty string is falsy');
});

test('MESSAGE_TYPE_TOKEN is a stable, non-empty string', () => {
	const context = load();
	// MESSAGE_TYPE_TOKEN is declared with `const`, so unlike `function isBridgeConfigured`, it
	// isn't exposed as an own property of the vm context object -- read it by evaluating the
	// bare identifier in the context instead, which does see const/let bindings.
	const value = vm.runInContext('MESSAGE_TYPE_TOKEN', context);
	assert.equal(typeof value, 'string');
	assert.ok(value.length > 0);
});
