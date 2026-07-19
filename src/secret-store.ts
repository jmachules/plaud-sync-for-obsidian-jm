export const PLAUD_TOKEN_SECRET_KEY = 'plaud-sync.token';
export const PLAUD_BRIDGE_SECRET_KEY = 'plaud-sync.bridge-secret';

type SecretCapableHost = {
	getSecret?: (key: string) => Promise<string | null>;
	setSecret?: (key: string, value: string) => Promise<void>;
	deleteSecret?: (key: string) => Promise<void>;
};

type LocalStorageCapableHost = {
	loadLocalStorage?: (key: string) => unknown;
	saveLocalStorage?: (key: string, data: unknown) => void;
};

export type SecretStoreHost = SecretCapableHost & LocalStorageCapableHost;

type SafeStorageApi = {
	isEncryptionAvailable: () => boolean;
	encryptString: (plainText: string) => Buffer;
	decryptString: (encrypted: Buffer) => string;
};

const ENCRYPTED_ENVELOPE_FORMAT = 'plaud-sync.safeStorage.v1';

type EncryptedEnvelope = {
	format: typeof ENCRYPTED_ENVELOPE_FORMAT;
	data: string;
};

// hasSecretApi() below is dead code on every current Obsidian build -- getSecret/setSecret/
// deleteSecret are all undefined at runtime -- so the loadLocalStorage fallback is what
// actually stores the Plaud token and bridge secret in practice, and it was doing so as
// plaintext. @electron/remote's safeStorage is reachable via the Electron renderer's global
// `require`, the same implicit host module Obsidian itself already relies on for "electron"
// (see esbuild.config.mjs). It's deliberately not a declared dependency: it doesn't exist on
// mobile, and a future Obsidian/Electron upgrade could remove or relocate it. Every access goes
// through this function so a missing or broken module degrades to plaintext storage instead of
// crashing the plugin. This also doubles as the desktop/mobile gate -- `require` is only a
// working global in the desktop Electron renderer -- without needing to import Obsidian's
// `Platform` here, which would break loading this module directly under plain Node (see
// test/secret-store.test.mjs).
function getSafeStorage(): SafeStorageApi | null {
	try {
		const globalRequire = (globalThis as Record<string, unknown>).require;
		if (typeof globalRequire !== 'function') {
			return null;
		}

		const requireFn = globalRequire as (id: string) => unknown;
		const electronRemote = requireFn('@electron/remote') as {safeStorage?: SafeStorageApi} | undefined;
		const safeStorage = electronRemote?.safeStorage;
		if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
			return null;
		}

		return safeStorage.isEncryptionAvailable() ? safeStorage : null;
	} catch {
		return null;
	}
}

export function isEncryptedStorageAvailable(): boolean {
	return getSafeStorage() !== null;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
	return typeof value === 'object'
		&& value !== null
		&& (value as {format?: unknown}).format === ENCRYPTED_ENVELOPE_FORMAT
		&& typeof (value as {data?: unknown}).data === 'string';
}

function encryptForStorage(safeStorage: SafeStorageApi, value: string): EncryptedEnvelope {
	// encryptString() returns a Buffer; loadLocalStorage/saveLocalStorage JSON-serialize
	// whatever they're given, and a raw Buffer doesn't round-trip through JSON, so store it
	// as base64 text instead.
	return {
		format: ENCRYPTED_ENVELOPE_FORMAT,
		data: safeStorage.encryptString(value).toString('base64')
	};
}

function decryptFromStorage(safeStorage: SafeStorageApi, envelope: EncryptedEnvelope): string | null {
	try {
		return normalizeToken(safeStorage.decryptString(Buffer.from(envelope.data, 'base64')));
	} catch {
		return null;
	}
}

function normalizeToken(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function hasSecretApi(host: SecretStoreHost): host is Required<Pick<SecretStoreHost, 'getSecret' | 'setSecret' | 'deleteSecret'>> {
	return typeof host.getSecret === 'function'
		&& typeof host.setSecret === 'function'
		&& typeof host.deleteSecret === 'function';
}

function hasLocalStorageApi(host: SecretStoreHost): host is Required<Pick<SecretStoreHost, 'loadLocalStorage' | 'saveLocalStorage'>> {
	return typeof host.loadLocalStorage === 'function' && typeof host.saveLocalStorage === 'function';
}

async function getSecretValue(host: SecretStoreHost, key: string): Promise<string | null> {
	if (hasSecretApi(host)) {
		return normalizeToken(await host.getSecret(key));
	}

	if (hasLocalStorageApi(host)) {
		const stored = host.loadLocalStorage(`${key}.fallback`);

		if (isEncryptedEnvelope(stored)) {
			const safeStorage = getSafeStorage();
			if (!safeStorage) {
				console.warn('[plaud-sync] secret-store: a value is stored encrypted but OS-level decryption is unavailable in this runtime; treating it as unreadable rather than guessing.');
				return null;
			}

			const decrypted = decryptFromStorage(safeStorage, stored);
			if (decrypted === null) {
				console.warn('[plaud-sync] secret-store: failed to decrypt a stored value. Encrypted values are tied to this OS user account and machine, so this is expected if it was copied from elsewhere.');
			}

			return decrypted;
		}

		// Legacy plaintext value (written before this fix, or written because encryption
		// was unavailable at save time -- see setSecretValue below). Migrate it to an
		// encrypted envelope on this read if we can, so a value doesn't sit in plaintext
		// indefinitely just because nothing happens to call setSecretValue again. This is a
		// read function with a write side effect, which is a real property of this code, not
		// an accident -- the next read after this hits the isEncryptedEnvelope branch above
		// instead of this one, so the migration write only ever happens once per value.
		const normalized = normalizeToken(stored);
		if (normalized) {
			const safeStorage = getSafeStorage();
			if (safeStorage) {
				host.saveLocalStorage(`${key}.fallback`, encryptForStorage(safeStorage, normalized));
			} else {
				console.warn('[plaud-sync] secret-store: a legacy plaintext value was read but could not be migrated to encrypted storage because OS-level encryption is unavailable in this runtime; it remains plaintext on disk.');
			}
		}

		return normalized;
	}

	return null;
}

async function setSecretValue(host: SecretStoreHost, key: string, value: string, emptyMessage: string): Promise<void> {
	const normalizedValue = normalizeToken(value);
	if (!normalizedValue) {
		throw new Error(emptyMessage);
	}

	if (hasSecretApi(host)) {
		await host.setSecret(key, normalizedValue);
		return;
	}

	if (hasLocalStorageApi(host)) {
		const safeStorage = getSafeStorage();
		if (safeStorage) {
			host.saveLocalStorage(`${key}.fallback`, encryptForStorage(safeStorage, normalizedValue));
			return;
		}

		console.warn('[plaud-sync] secret-store: OS-level encryption is unavailable in this runtime; storing this value as plaintext in local storage. See Settings -> Plaud Sync for details.');
		host.saveLocalStorage(`${key}.fallback`, normalizedValue);
		return;
	}

	throw new Error('No secret storage API is available in this Obsidian runtime.');
}

async function clearSecretValue(host: SecretStoreHost, key: string): Promise<void> {
	if (hasSecretApi(host)) {
		await host.deleteSecret(key);
		return;
	}

	if (hasLocalStorageApi(host)) {
		host.saveLocalStorage(`${key}.fallback`, null);
	}
}

export function getPlaudToken(host: SecretStoreHost): Promise<string | null> {
	return getSecretValue(host, PLAUD_TOKEN_SECRET_KEY);
}

export function setPlaudToken(host: SecretStoreHost, token: string): Promise<void> {
	return setSecretValue(host, PLAUD_TOKEN_SECRET_KEY, token, 'Plaud token cannot be empty. Paste a valid token string.');
}

export function clearPlaudToken(host: SecretStoreHost): Promise<void> {
	return clearSecretValue(host, PLAUD_TOKEN_SECRET_KEY);
}

export function getBridgeSecret(host: SecretStoreHost): Promise<string | null> {
	return getSecretValue(host, PLAUD_BRIDGE_SECRET_KEY);
}

export function setBridgeSecret(host: SecretStoreHost, secret: string): Promise<void> {
	return setSecretValue(host, PLAUD_BRIDGE_SECRET_KEY, secret, 'Bridge secret cannot be empty.');
}

export function clearBridgeSecret(host: SecretStoreHost): Promise<void> {
	return clearSecretValue(host, PLAUD_BRIDGE_SECRET_KEY);
}
