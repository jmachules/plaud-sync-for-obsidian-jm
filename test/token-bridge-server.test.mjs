import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/token-bridge-server.ts')).href;
const {createTokenBridgeServer, generateBridgeSecret} = await import(moduleUrl);

async function withServer(options, run) {
  const received = [];
  const server = createTokenBridgeServer({
    port: options.port,
    secret: options.secret,
    onToken: async (payload) => {
      received.push(payload);
    }
  });

  await server.start();
  try {
    await run(received);
  } finally {
    await server.stop();
  }
}

test('generateBridgeSecret produces distinct, sufficiently long secrets', () => {
  const a = generateBridgeSecret();
  const b = generateBridgeSecret();

  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});

test('accepts a valid token post with matching secret', async () => {
  const port = 18765;
  const secret = 'test-secret-value';

  await withServer({port, secret}, async (received) => {
    const response = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-bridge-secret': secret},
      body: JSON.stringify({token: 'tok_abc', expiresAt: 1234})
    });

    assert.equal(response.status, 200);
    assert.deepEqual(received, [{token: 'tok_abc', expiresAt: 1234}]);
  });
});

test('rejects requests with a wrong or missing secret', async () => {
  const port = 18766;
  const secret = 'correct-secret';

  await withServer({port, secret}, async (received) => {
    const wrongSecret = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-bridge-secret': 'wrong'},
      body: JSON.stringify({token: 'tok_abc'})
    });
    assert.equal(wrongSecret.status, 401);

    const missingSecret = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'tok_abc'})
    });
    assert.equal(missingSecret.status, 401);

    assert.equal(received.length, 0);
  });
});

test('rejects requests missing a token field', async () => {
  const port = 18767;
  const secret = 'test-secret-value';

  await withServer({port, secret}, async (received) => {
    const response = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-bridge-secret': secret},
      body: JSON.stringify({expiresAt: 1234})
    });

    assert.equal(response.status, 400);
    assert.equal(received.length, 0);
  });
});

test('rejects unknown routes and methods', async () => {
  const port = 18768;
  const secret = 'test-secret-value';

  await withServer({port, secret}, async () => {
    const wrongPath = await fetch(`http://127.0.0.1:${port}/not-token`, {
      method: 'POST',
      headers: {'x-bridge-secret': secret}
    });
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'GET',
      headers: {'x-bridge-secret': secret}
    });
    assert.equal(wrongMethod.status, 404);
  });
});

test('stop() is idempotent and frees the port for a subsequent start()', async () => {
  const port = 18769;
  const secret = 'test-secret-value';

  const server = createTokenBridgeServer({port, secret, onToken: async () => {}});
  await server.start();
  await server.stop();
  await server.stop();

  const server2 = createTokenBridgeServer({port, secret, onToken: async () => {}});
  await server2.start();
  await server2.stop();
});
