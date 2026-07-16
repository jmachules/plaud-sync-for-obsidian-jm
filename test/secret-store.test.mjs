import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const secretModuleUrl = pathToFileURL(path.join(root, 'src/secret-store.ts')).href;
const {
  PLAUD_TOKEN_SECRET_KEY,
  PLAUD_BRIDGE_SECRET_KEY,
  getPlaudToken,
  setPlaudToken,
  clearPlaudToken,
  getBridgeSecret,
  setBridgeSecret,
  clearBridgeSecret,
  isEncryptedStorageAvailable
} = await import(secretModuleUrl);

const settingsSource = fs.readFileSync(path.join(root, 'src/settings.ts'), 'utf8');
const schemaSource = fs.readFileSync(path.join(root, 'src/settings-schema.ts'), 'utf8');

function makeLocalStorageHost() {
  const kv = new Map();
  return {
    kv,
    loadLocalStorage(key) {
      return kv.get(key) ?? null;
    },
    saveLocalStorage(key, value) {
      if (value === null) {
        kv.delete(key);
        return;
      }
      kv.set(key, value);
    }
  };
}

function makeWorkingSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = Buffer.from(encrypted).toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('bad ciphertext');
      }
      return text.slice('enc:'.length);
    }
  };
}

// @electron/remote isn't installed for plain Node test runs (it's an implicit host module,
// only reachable via require() inside the real Electron renderer -- see secret-store.ts),
// so stub the global `require` secret-store.ts looks up.
async function withGlobalRequire(impl, run) {
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(globalThis, 'require');
  const original = globalThis.require;
  globalThis.require = impl;
  try {
    return await run();
  } finally {
    if (hadOwnProperty) {
      globalThis.require = original;
    } else {
      delete globalThis.require;
    }
  }
}

test('secret key constant is stable and plugin-scoped', () => {
  assert.equal(PLAUD_TOKEN_SECRET_KEY, 'plaud-sync.token');
});

test('secret backend path is used when available', async () => {
  const storage = new Map();
  const host = {
    async getSecret(key) {
      return storage.get(key) ?? null;
    },
    async setSecret(key, value) {
      storage.set(key, value);
    },
    async deleteSecret(key) {
      storage.delete(key);
    }
  };

  await setPlaudToken(host, 'tok_abc');
  assert.equal(await getPlaudToken(host), 'tok_abc');

  await clearPlaudToken(host);
  assert.equal(await getPlaudToken(host), null);
});

test('fallback storage path still keeps token out of plugin saveData payload', async () => {
  const kv = new Map();
  const host = {
    loadLocalStorage(key) {
      return kv.get(key) ?? null;
    },
    saveLocalStorage(key, value) {
      if (value === null) {
        kv.delete(key);
        return;
      }
      kv.set(key, value);
    }
  };

  await setPlaudToken(host, 'tok_local');
  assert.equal(await getPlaudToken(host), 'tok_local');
  await clearPlaudToken(host);
  assert.equal(await getPlaudToken(host), null);

  assert.doesNotMatch(schemaSource, /token/i);
});

test('settings uses secret input flow and token feedback copy', () => {
  assert.match(settingsSource, /setPlaudToken\(/);
  assert.match(settingsSource, /getPlaudToken\(/);
  assert.match(settingsSource, /type\s*=\s*'password'/);
  assert.match(settingsSource, /Plaud token/);
});

test('bridge secret key is stable, plugin-scoped, and distinct from the token key', () => {
  assert.equal(PLAUD_BRIDGE_SECRET_KEY, 'plaud-sync.bridge-secret');
  assert.notEqual(PLAUD_BRIDGE_SECRET_KEY, PLAUD_TOKEN_SECRET_KEY);
});

test('bridge secret uses the secret backend path when available', async () => {
  const storage = new Map();
  const host = {
    async getSecret(key) {
      return storage.get(key) ?? null;
    },
    async setSecret(key, value) {
      storage.set(key, value);
    },
    async deleteSecret(key) {
      storage.delete(key);
    }
  };

  await setBridgeSecret(host, 'bridge_abc');
  assert.equal(await getBridgeSecret(host), 'bridge_abc');

  await clearBridgeSecret(host);
  assert.equal(await getBridgeSecret(host), null);
});

test('bridge secret falls back to local storage under its own key, independent of the token', async () => {
  const kv = new Map();
  const host = {
    loadLocalStorage(key) {
      return kv.get(key) ?? null;
    },
    saveLocalStorage(key, value) {
      if (value === null) {
        kv.delete(key);
        return;
      }
      kv.set(key, value);
    }
  };

  await setPlaudToken(host, 'tok_local');
  await setBridgeSecret(host, 'bridge_local');

  assert.equal(await getPlaudToken(host), 'tok_local');
  assert.equal(await getBridgeSecret(host), 'bridge_local');

  await clearBridgeSecret(host);
  assert.equal(await getBridgeSecret(host), null);
  assert.equal(await getPlaudToken(host), 'tok_local', 'clearing the bridge secret must not affect the token');
});

test('setBridgeSecret rejects an empty secret', async () => {
  const host = {
    async getSecret() { return null; },
    async setSecret() {},
    async deleteSecret() {}
  };

  await assert.rejects(() => setBridgeSecret(host, '   '));
});

test('isEncryptedStorageAvailable reflects whether a working safeStorage is reachable', async () => {
  assert.equal(isEncryptedStorageAvailable(), false, 'no require() global in a plain Node test run');

  await withGlobalRequire(
    (id) => (id === '@electron/remote' ? {safeStorage: makeWorkingSafeStorage()} : null),
    () => {
      assert.equal(isEncryptedStorageAvailable(), true);
    }
  );

  assert.equal(isEncryptedStorageAvailable(), false, 'restored after the stub is removed');
});

test('fallback storage encrypts the value at rest when safeStorage is available, and round-trips it', async () => {
  const host = makeLocalStorageHost();

  await withGlobalRequire(
    (id) => (id === '@electron/remote' ? {safeStorage: makeWorkingSafeStorage()} : null),
    async () => {
      await setPlaudToken(host, 'tok_secret_value');

      const stored = host.kv.get(`${PLAUD_TOKEN_SECRET_KEY}.fallback`);
      assert.equal(typeof stored, 'object', 'stored value should be an envelope, not a raw string');
      assert.equal(stored.format, 'plaud-sync.safeStorage.v1');
      assert.doesNotMatch(stored.data, /tok_secret_value/, 'plaintext must not appear in what gets persisted');

      assert.equal(await getPlaudToken(host), 'tok_secret_value');
    }
  );
});

test('fallback storage falls back to plaintext with a warning when require() throws', async (t) => {
  const host = makeLocalStorageHost();
  const warnMock = t.mock.method(console, 'warn');

  await withGlobalRequire(
    () => {
      throw new Error('module not found');
    },
    async () => {
      await setPlaudToken(host, 'tok_plaintext');
    }
  );

  assert.equal(host.kv.get(`${PLAUD_TOKEN_SECRET_KEY}.fallback`), 'tok_plaintext');
  assert.equal(await getPlaudToken(host), 'tok_plaintext');
  assert.ok(warnMock.mock.callCount() > 0, 'a degraded-state warning should be logged');
});

test('fallback storage falls back to plaintext with a warning when isEncryptionAvailable() is false', async (t) => {
  const host = makeLocalStorageHost();
  const warnMock = t.mock.method(console, 'warn');

  await withGlobalRequire(
    (id) => (id === '@electron/remote' ? {safeStorage: {isEncryptionAvailable: () => false}} : null),
    async () => {
      await setPlaudToken(host, 'tok_plaintext_2');
    }
  );

  assert.equal(host.kv.get(`${PLAUD_TOKEN_SECRET_KEY}.fallback`), 'tok_plaintext_2');
  assert.equal(await getPlaudToken(host), 'tok_plaintext_2');
  assert.ok(warnMock.mock.callCount() > 0);
});

test('fallback storage still reads legacy plaintext values written before this fix', async () => {
  const host = makeLocalStorageHost();
  host.kv.set(`${PLAUD_TOKEN_SECRET_KEY}.fallback`, 'tok_written_by_old_plugin_version');

  await withGlobalRequire(
    (id) => (id === '@electron/remote' ? {safeStorage: makeWorkingSafeStorage()} : null),
    async () => {
      assert.equal(await getPlaudToken(host), 'tok_written_by_old_plugin_version');
    }
  );
});

test('reading a legacy plaintext value migrates it to an encrypted envelope in place', async () => {
  const host = makeLocalStorageHost();
  host.kv.set(`${PLAUD_TOKEN_SECRET_KEY}.fallback`, 'tok_migrate_me');

  await withGlobalRequire(
    (id) => (id === '@electron/remote' ? {safeStorage: makeWorkingSafeStorage()} : null),
    async () => {
      const first = await getPlaudToken(host);
      assert.equal(first, 'tok_migrate_me');

      const stored = host.kv.get(`${PLAUD_TOKEN_SECRET_KEY}.fallback`);
      assert.equal(typeof stored, 'object', 'value should now be an envelope, not the raw string');
      assert.equal(stored.format, 'plaud-sync.safeStorage.v1');
      assert.doesNotMatch(stored.data, /tok_migrate_me/, 'plaintext must not remain in storage after migration');

      const second = await getPlaudToken(host);
      assert.equal(second, 'tok_migrate_me', 'value still reads correctly after migration, from the now-encrypted form');
    }
  );
});

test('reading a legacy plaintext value does not attempt migration when safeStorage is unavailable', async () => {
  const host = makeLocalStorageHost();
  host.kv.set(`${PLAUD_TOKEN_SECRET_KEY}.fallback`, 'tok_stays_plaintext');

  assert.equal(await getPlaudToken(host), 'tok_stays_plaintext');
  assert.equal(
    host.kv.get(`${PLAUD_TOKEN_SECRET_KEY}.fallback`),
    'tok_stays_plaintext',
    'no require() global means no migration should be attempted, and the value must be unchanged'
  );
});

test('fallback storage returns null and warns instead of crashing when a stored value cannot be decrypted', async (t) => {
  const host = makeLocalStorageHost();
  host.kv.set(`${PLAUD_TOKEN_SECRET_KEY}.fallback`, {
    format: 'plaud-sync.safeStorage.v1',
    data: Buffer.from('not valid ciphertext', 'utf8').toString('base64')
  });
  const warnMock = t.mock.method(console, 'warn');

  await withGlobalRequire(
    (id) => (id === '@electron/remote' ? {safeStorage: makeWorkingSafeStorage()} : null),
    async () => {
      assert.equal(await getPlaudToken(host), null, 'decrypting on a different machine/account should fail closed');
    }
  );

  assert.ok(warnMock.mock.callCount() > 0);
});

test('fallback storage returns null instead of guessing when an encrypted value exists but safeStorage is gone', async () => {
  const host = makeLocalStorageHost();
  host.kv.set(`${PLAUD_TOKEN_SECRET_KEY}.fallback`, {
    format: 'plaud-sync.safeStorage.v1',
    data: Buffer.from('irrelevant', 'utf8').toString('base64')
  });

  assert.equal(await getPlaudToken(host), null);
});
