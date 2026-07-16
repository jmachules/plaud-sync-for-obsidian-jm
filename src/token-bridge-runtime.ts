import type {TokenBridgePayload, TokenBridgeServer, TokenBridgeServerOptions} from './token-bridge-server';

export interface TokenBridgeStatus {
	enabled: boolean;
	running: boolean;
	lastError: string | null;
}

export interface TokenBridgeRuntimeOptions {
	getBridgeEnabled: () => boolean;
	getBridgePort: () => number;
	persistBridgeEnabled: (enabled: boolean) => Promise<void>;
	ensureSecret: () => Promise<string>;
	regenerateSecret: () => Promise<string>;
	isDesktopApp: () => boolean;
	createServer: (options: TokenBridgeServerOptions) => TokenBridgeServer;
	onToken: (payload: TokenBridgePayload) => Promise<void>;
	notify: (message: string) => void;
	log: (message: string) => void;
}

export interface TokenBridgeRuntime {
	start(): Promise<void>;
	stop(): Promise<void>;
	setEnabled(enabled: boolean): Promise<void>;
	regenerateSecret(): Promise<string>;
	getStatus(): TokenBridgeStatus;
}

export function createTokenBridgeRuntime(options: TokenBridgeRuntimeOptions): TokenBridgeRuntime {
	let server: TokenBridgeServer | null = null;
	let lastError: string | null = null;

	async function start(): Promise<void> {
		if (server) {
			return;
		}

		if (!options.isDesktopApp()) {
			lastError = 'Browser token bridge is desktop-only.';
			options.notify(lastError);
			return;
		}

		const port = options.getBridgePort();
		const secret = await options.ensureSecret();
		const instance = options.createServer({
			port,
			secret,
			onToken: options.onToken,
			onLog: options.log
		});

		try {
			await instance.start();
			server = instance;
			lastError = null;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			lastError = message;
			options.notify(`Plaud token bridge failed to start on port ${port}: ${message}`);
		}
	}

	async function stop(): Promise<void> {
		if (!server) {
			return;
		}

		const instance = server;
		server = null;
		await instance.stop();
	}

	return {
		start,
		stop,
		async setEnabled(enabled: boolean): Promise<void> {
			await options.persistBridgeEnabled(enabled);

			if (enabled) {
				await start();
			} else {
				lastError = null;
				await stop();
			}
		},
		async regenerateSecret(): Promise<string> {
			const generated = await options.regenerateSecret();

			if (server) {
				await stop();
				await start();
			}

			return generated;
		},
		getStatus(): TokenBridgeStatus {
			return {
				enabled: options.getBridgeEnabled(),
				running: server !== null,
				lastError
			};
		}
	};
}
