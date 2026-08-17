import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';

const root = process.cwd();
const schemaModuleUrl = pathToFileURL(path.join(root, 'src/settings-schema.ts')).href;
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  toPersistedSettings,
  isValidBridgePort
} = await import(schemaModuleUrl);

const mainSource = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');

test('default settings expose full Plaud sync schema', () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), [
    'apiDomain',
    'bridgeEnabled',
    'bridgePort',
    'enrichConfigPath',
    'filenamePattern',
    'lastSyncAtMs',
    'syncFolder',
    'syncOnStartup',
    'updateExisting'
  ]);

  assert.equal(DEFAULT_SETTINGS.apiDomain, 'https://api.plaud.ai');
  assert.equal(DEFAULT_SETTINGS.syncFolder, 'Plaud');
  assert.equal(DEFAULT_SETTINGS.syncOnStartup, true);
  assert.equal(DEFAULT_SETTINGS.updateExisting, true);
  assert.equal(DEFAULT_SETTINGS.filenamePattern, 'plaud-{date}-{title}');
  assert.equal(DEFAULT_SETTINGS.lastSyncAtMs, 0);
  assert.equal(DEFAULT_SETTINGS.bridgeEnabled, false);
  assert.equal(DEFAULT_SETTINGS.bridgePort, 8765);
  assert.equal(DEFAULT_SETTINGS.enrichConfigPath, '');
});

test('normalizeSettings trims enrichConfigPath and defaults non-strings to disabled', () => {
  assert.equal(normalizeSettings({enrichConfigPath: '  notes/config.md  '}).enrichConfigPath, 'notes/config.md');
  assert.equal(normalizeSettings({enrichConfigPath: 42}).enrichConfigPath, '');
  assert.equal(normalizeSettings({}).enrichConfigPath, '');
});

test('normalizeSettings merges persisted partial values with defaults', () => {
  const merged = normalizeSettings({
    syncFolder: 'My Plaud Notes',
    syncOnStartup: false,
    lastSyncAtMs: 1730000000123
  });

  assert.equal(merged.apiDomain, DEFAULT_SETTINGS.apiDomain);
  assert.equal(merged.syncFolder, 'My Plaud Notes');
  assert.equal(merged.syncOnStartup, false);
  assert.equal(merged.updateExisting, DEFAULT_SETTINGS.updateExisting);
  assert.equal(merged.filenamePattern, DEFAULT_SETTINGS.filenamePattern);
  assert.equal(merged.lastSyncAtMs, 1730000000123);
});

test('normalizeSettings protects against malformed persisted values', () => {
  const merged = normalizeSettings({
    apiDomain: '',
    syncFolder: 42,
    syncOnStartup: 'yes',
    updateExisting: null,
    filenamePattern: '',
    lastSyncAtMs: -100,
    bridgeEnabled: 'yes',
    bridgePort: 99999
  });

  assert.deepEqual(merged, DEFAULT_SETTINGS);
});

test('normalizeSettings rejects out-of-range or non-numeric bridge ports', () => {
  assert.equal(normalizeSettings({bridgePort: 80}).bridgePort, DEFAULT_SETTINGS.bridgePort);
  assert.equal(normalizeSettings({bridgePort: 70000}).bridgePort, DEFAULT_SETTINGS.bridgePort);
  assert.equal(normalizeSettings({bridgePort: 'abc'}).bridgePort, DEFAULT_SETTINGS.bridgePort);
  assert.equal(normalizeSettings({bridgePort: 1023}).bridgePort, DEFAULT_SETTINGS.bridgePort);
  assert.equal(normalizeSettings({bridgePort: 65536}).bridgePort, DEFAULT_SETTINGS.bridgePort);
  assert.equal(normalizeSettings({bridgePort: 12345}).bridgePort, 12345);
});

test('normalizeSettings coerces a non-boolean bridgeEnabled to the default', () => {
  assert.equal(normalizeSettings({bridgeEnabled: 'true'}).bridgeEnabled, DEFAULT_SETTINGS.bridgeEnabled);
  assert.equal(normalizeSettings({bridgeEnabled: 1}).bridgeEnabled, DEFAULT_SETTINGS.bridgeEnabled);
  assert.equal(normalizeSettings({bridgeEnabled: true}).bridgeEnabled, true);
});

test('isValidBridgePort enforces the 1024-65535 range on integers only', () => {
  assert.equal(isValidBridgePort(8765), true);
  assert.equal(isValidBridgePort(1024), true);
  assert.equal(isValidBridgePort(65535), true);
  assert.equal(isValidBridgePort(1023), false);
  assert.equal(isValidBridgePort(65536), false);
  assert.equal(isValidBridgePort(8765.5), false);
});

test('toPersistedSettings preserves explicit lastSyncAtMs checkpoint semantics', () => {
  const persisted = toPersistedSettings({
    ...DEFAULT_SETTINGS,
    lastSyncAtMs: 1731000000000
  });

  assert.equal(persisted.lastSyncAtMs, 1731000000000);
});

test('plugin main wiring uses normalizeSettings during load path', () => {
  assert.match(mainSource, /this\.settings\s*=\s*normalizeSettings\(await this\.loadData\(\)\)/);
});
