import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/token-bridge-runtime.ts')).href;
const {createTokenBridgeRuntime} = await import(moduleUrl);

function fakeServerFactory(behavior = {}) {
  const instances = [];

  const factory = (options) => {
    const instance = {
      options,
      started: false,
      stopped: false,
      start: async () => {
        if (behavior.startError) {
          throw behavior.startError;
        }
        instance.started = true;
      },
      stop: async () => {
        instance.stopped = true;
      }
    };
    instances.push(instance);
    return instance;
  };

  factory.instances = instances;
  return factory;
}

function baseOptions(overrides = {}) {
  const state = {bridgeEnabled: false, bridgePort: 8765, secret: 'secret-a'};
  const notices = [];
  const logs = [];

  return {
    state,
    notices,
    logs,
    getBridgeEnabled: () => state.bridgeEnabled,
    getBridgePort: () => state.bridgePort,
    persistBridgeEnabled: async (enabled) => {
      state.bridgeEnabled = enabled;
    },
    ensureSecret: async () => state.secret,
    regenerateSecret: async () => {
      state.secret = `${state.secret}-regenerated`;
      return state.secret;
    },
    isDesktopApp: () => true,
    onToken: async () => {},
    notify: (message) => notices.push(message),
    log: (message) => logs.push(message),
    ...overrides
  };
}

test('setEnabled(true) persists the setting and starts the server', async () => {
  const factory = fakeServerFactory();
  const options = baseOptions({createServer: factory});
  const runtime = createTokenBridgeRuntime(options);

  await runtime.setEnabled(true);

  assert.equal(options.state.bridgeEnabled, true);
  assert.equal(factory.instances.length, 1);
  assert.equal(factory.instances[0].started, true);
  assert.deepEqual(runtime.getStatus(), {enabled: true, running: true, lastError: null});
});

test('setEnabled(false) persists the setting and stops the server', async () => {
  const factory = fakeServerFactory();
  const options = baseOptions({createServer: factory});
  const runtime = createTokenBridgeRuntime(options);

  await runtime.setEnabled(true);
  await runtime.setEnabled(false);

  assert.equal(options.state.bridgeEnabled, false);
  assert.equal(factory.instances[0].stopped, true);
  assert.deepEqual(runtime.getStatus(), {enabled: false, running: false, lastError: null});
});

test('a failed start() leaves lastError populated and running=false, instead of silently claiming success', async () => {
  const factory = fakeServerFactory({startError: new Error('EADDRINUSE')});
  const options = baseOptions({createServer: factory});
  const runtime = createTokenBridgeRuntime(options);

  await runtime.setEnabled(true);

  const status = runtime.getStatus();
  assert.equal(status.enabled, true, 'the persisted intent is still "enabled"');
  assert.equal(status.running, false, 'but nothing is actually listening');
  assert.match(status.lastError, /EADDRINUSE/);
  assert.equal(options.notices.length, 1);
  assert.match(options.notices[0], /failed to start/);
});

test('start() is a no-op on non-desktop platforms and records a status message', async () => {
  const factory = fakeServerFactory();
  const options = baseOptions({createServer: factory, isDesktopApp: () => false});
  const runtime = createTokenBridgeRuntime(options);

  await runtime.setEnabled(true);

  assert.equal(factory.instances.length, 0);
  const status = runtime.getStatus();
  assert.equal(status.running, false);
  assert.match(status.lastError, /desktop-only/);
});

test('regenerateSecret restarts a running server with the new secret', async () => {
  const factory = fakeServerFactory();
  const options = baseOptions({createServer: factory});
  const runtime = createTokenBridgeRuntime(options);

  await runtime.setEnabled(true);
  const newSecret = await runtime.regenerateSecret();

  assert.equal(newSecret, 'secret-a-regenerated');
  assert.equal(factory.instances.length, 2, 'expected the first server stopped and a second one started');
  assert.equal(factory.instances[0].stopped, true);
  assert.equal(factory.instances[1].started, true);
  assert.equal(factory.instances[1].options.secret, 'secret-a-regenerated');
});

test('regenerateSecret does not start a server when the bridge is not currently running', async () => {
  const factory = fakeServerFactory();
  const options = baseOptions({createServer: factory});
  const runtime = createTokenBridgeRuntime(options);

  await runtime.regenerateSecret();

  assert.equal(factory.instances.length, 0);
});

test('starting twice does not create a second server instance', async () => {
  const factory = fakeServerFactory();
  const options = baseOptions({createServer: factory});
  const runtime = createTokenBridgeRuntime(options);

  await runtime.start();
  await runtime.start();

  assert.equal(factory.instances.length, 1);
});
