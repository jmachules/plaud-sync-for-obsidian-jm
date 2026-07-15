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
		return normalizeToken(host.loadLocalStorage(`${key}.fallback`));
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
