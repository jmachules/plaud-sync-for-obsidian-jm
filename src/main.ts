import {Notice, Platform, Plugin, requestUrl, TFile} from 'obsidian';
import {registerPlaudCommands} from './commands';
import {type PlaudPluginSettings, normalizeSettings, toPersistedSettings} from './settings-schema';
import {PlaudSettingTab} from './settings';
import {createPlaudSyncRuntime, type PlaudSyncRuntime, type SyncTrigger} from './sync-runtime';
import {createObsidianPlaudApiClient} from './plaud-api-obsidian';
import {getBridgeSecret, getPlaudToken, isEncryptedStorageAvailable, setBridgeSecret, setPlaudToken} from './secret-store';
import {normalizePlaudDetail} from './plaud-normalizer';
import {renderPlaudMarkdown} from './plaud-renderer';
import {enrichMarkdown, parseEnrichSpec, type EnrichSpec} from './note-enricher';
import {isTrashedFile, runPlaudSync, type PlaudSyncSummary} from './plaud-sync';
import {type PlaudVaultAdapter, upsertPlaudNote} from './plaud-vault';
import {PlaudApiError, type PlaudApiClient, type PlaudFileDetail} from './plaud-api';
import {DEFAULT_RETRY_POLICY, sanitizeTelemetryMessage, type RetryTelemetryEvent, withRetry} from './plaud-retry';
import {hydratePlaudDetailContent} from './plaud-content-hydrator';
import {createTokenBridgeServer, generateBridgeSecret} from './token-bridge-server';
import {createTokenBridgeRuntime, type TokenBridgeRuntime, type TokenBridgeStatus} from './token-bridge-runtime';

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return 'Unknown error';
}

function toActionableMessage(error: unknown): string {
	if (error instanceof PlaudApiError) {
		if (error.category === 'auth') {
			return 'authentication failed. Re-save your Plaud token in settings.';
		}
		if (error.category === 'rate_limit') {
			return 'rate limited by Plaud API. Wait briefly and retry.';
		}
		if (error.category === 'network') {
			return 'network error. Check your connection and retry.';
		}
		if (error.category === 'server') {
			return 'Plaud API is temporarily unavailable. Retry shortly.';
		}
		if (error.category === 'invalid_response') {
			return 'unexpected API response format. Retry and inspect logs if it persists.';
		}
	}

	return sanitizeTelemetryMessage(toErrorMessage(error));
}

function formatSyncSummary(summary: PlaudSyncSummary): string {
	return `Plaud sync complete. Created ${summary.created}, updated ${summary.updated}, skipped ${summary.skipped}, failed ${summary.failed}.`;
}

export default class PlaudSyncPlugin extends Plugin {
	settings: PlaudPluginSettings;
	private syncRuntime: PlaudSyncRuntime | null = null;
	private tokenBridgeRuntime: TokenBridgeRuntime | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.syncRuntime = createPlaudSyncRuntime({
			isStartupEnabled: () => this.settings.syncOnStartup,
			runSync: async (trigger) => this.runSync(trigger),
			onLocked: (message) => {
				new Notice(message);
			}
		});

		registerPlaudCommands(this);
		this.addSettingTab(new PlaudSettingTab(this.app, this));

		await this.warnIfStoredSecretsAreUnencrypted();

		// Defer the startup sync until the vault index is fully loaded — running it
		// straight from onload races vault indexing, and reads of files outside the
		// warm sync folder (e.g. the enrichment config note) can fail spuriously.
		this.app.workspace.onLayoutReady(() => {
			void this.ensureSyncRuntime().runStartupSync();
		});

		if (this.settings.bridgeEnabled) {
			await this.ensureTokenBridgeRuntime().start();
		}
	}

	private async warnIfStoredSecretsAreUnencrypted(): Promise<void> {
		if (isEncryptedStorageAvailable()) {
			return;
		}

		const [token, bridgeSecret] = await Promise.all([
			getPlaudToken(this.app),
			getBridgeSecret(this.app)
		]);

		if (!token && !bridgeSecret) {
			return;
		}

		console.warn('[plaud-sync] secret storage encryption is unavailable in this runtime; a previously '
			+ 'stored Plaud token or bridge secret is plaintext on disk.');
		new Notice(
			'Plaud Sync: OS-level secret encryption is unavailable here, so your stored Plaud token / '
				+ 'bridge secret are plaintext on disk. See Settings -> Plaud Sync for details.',
			15000
		);
	}

	onunload(): void {
		void this.tokenBridgeRuntime?.stop();
	}

	async ensureBridgeSecret(): Promise<string> {
		const existing = await getBridgeSecret(this.app);
		if (existing) {
			return existing;
		}

		// This can fire just from opening the settings tab (no explicit user "save" action), so it
		// gets the same unattended-write treatment as the bridge auto-push in onToken below: a loud
		// Notice instead of a blocking confirm modal, so it doesn't ambush someone who only wanted
		// to look at settings.
		const generated = generateBridgeSecret();
		await setBridgeSecret(this.app, generated);
		if (!isEncryptedStorageAvailable()) {
			new Notice(
				'Plaud Sync: generated a new bridge secret. Stored as plaintext because OS-level '
					+ 'encryption is unavailable here.',
				10000
			);
		}
		return generated;
	}

	async regenerateBridgeSecret(): Promise<string> {
		return this.ensureTokenBridgeRuntime().regenerateSecret();
	}

	async setBridgeEnabled(enabled: boolean): Promise<void> {
		await this.ensureTokenBridgeRuntime().setEnabled(enabled);
	}

	getBridgeStatus(): TokenBridgeStatus {
		return this.ensureTokenBridgeRuntime().getStatus();
	}

	private ensureTokenBridgeRuntime(): TokenBridgeRuntime {
		if (!this.tokenBridgeRuntime) {
			this.tokenBridgeRuntime = createTokenBridgeRuntime({
				getBridgeEnabled: () => this.settings.bridgeEnabled,
				getBridgePort: () => this.settings.bridgePort,
				persistBridgeEnabled: async (enabled) => {
					this.settings.bridgeEnabled = enabled;
					await this.saveSettings();
				},
				ensureSecret: () => this.ensureBridgeSecret(),
				regenerateSecret: async () => {
					const generated = generateBridgeSecret();
					await setBridgeSecret(this.app, generated);
					return generated;
				},
				isDesktopApp: () => Platform.isDesktopApp,
				createServer: createTokenBridgeServer,
				onToken: async (payload) => {
					// expiresAt is captured for a future expiry-aware refresh scheduler; not consumed yet.
					await setPlaudToken(this.app, payload.token);
					// This push is unattended (triggered by the browser extension, not a user click), so
					// unlike the settings-tab writes there's no one present to gate with a confirm modal --
					// blocking here would just silently break the bridge's whole point. Surface it loudly
					// instead of the settings-tab-only indicator, so a plaintext write on a headless machine
					// still gets seen.
					if (isEncryptedStorageAvailable()) {
						new Notice('Plaud token updated via browser bridge.');
					} else {
						new Notice(
							'Plaud token updated via browser bridge. Stored as plaintext because OS-level '
								+ 'encryption is unavailable here.',
							10000
						);
					}
				},
				notify: (message) => {
					new Notice(message);
				},
				log: (message) => {
					console.warn('[plaud-sync] bridge', message);
				}
			});
		}

		return this.tokenBridgeRuntime;
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(toPersistedSettings(this.settings));
	}

	async runPlaudSyncNow(): Promise<void> {
		await this.ensureSyncRuntime().runManualSync();
	}

	async validatePlaudToken(): Promise<void> {
		const token = await getPlaudToken(this.app);
		if (!token) {
			new Notice('Plaud token missing. Configure it in settings before validation.');
			return;
		}

		try {
			const api = createObsidianPlaudApiClient({
				apiDomain: this.settings.apiDomain,
				token
			});

			const files = await this.retryApiCall('validate_token.list_files', async () => api.listFiles());
			const activeCount = files.filter((file) => !isTrashedFile(file)).length;
			new Notice(`Plaud token is valid. Active recordings visible: ${activeCount}.`);
		} catch (error) {
			this.logFailure('validate_token_failed', error);
			new Notice(`Plaud token validation failed: ${toActionableMessage(error)}`);
		}
	}

	private ensureSyncRuntime(): PlaudSyncRuntime {
		if (!this.syncRuntime) {
			this.syncRuntime = createPlaudSyncRuntime({
				isStartupEnabled: () => this.settings.syncOnStartup,
				runSync: async (trigger) => this.runSync(trigger),
				onLocked: (message) => {
					new Notice(message);
				}
			});
		}

		return this.syncRuntime;
	}

	private async runSync(trigger: SyncTrigger): Promise<void> {
		try {
			const summary = await this.executeSyncBatch();
			if (trigger === 'manual') {
				new Notice(formatSyncSummary(summary));
			}
		} catch (error) {
			this.logFailure('sync_failed', error);
			new Notice(`Plaud sync failed: ${toActionableMessage(error)}`);
		}
	}

	private async executeSyncBatch(): Promise<PlaudSyncSummary> {
		const token = await getPlaudToken(this.app);
		if (!token) {
			throw new Error('Plaud token missing. Configure it in settings before syncing.');
		}

		const api = createObsidianPlaudApiClient({
			apiDomain: this.settings.apiDomain,
			token
		});
		const resilientApi: PlaudApiClient = {
			listFiles: async () => this.retryApiCall('sync.list_files', async () => api.listFiles()),
			getFileDetail: async (fileId: string) => {
				const detail = await this.retryApiCall(`sync.file_detail.${fileId}`, async () => api.getFileDetail(fileId));
				const hydrated = await hydratePlaudDetailContent(detail, async (url) => {
					return this.retryApiCall(`sync.content_fetch.${fileId}`, async () => this.fetchSignedContent(url));
				});

				if (typeof hydrated.id === 'string' && hydrated.id.trim().length > 0) {
					return hydrated as PlaudFileDetail;
				}

				return detail;
			}
		};

		const vault = this.createVaultAdapter();
		const enrichSpec = await this.loadEnrichSpec(vault);

		return runPlaudSync({
			api: resilientApi,
			vault,
			settings: {
				syncFolder: this.settings.syncFolder,
				filenamePattern: this.settings.filenamePattern,
				updateExisting: this.settings.updateExisting,
				lastSyncAtMs: this.settings.lastSyncAtMs
			},
			saveCheckpoint: async (nextLastSyncAtMs) => {
				this.settings.lastSyncAtMs = nextLastSyncAtMs;
				await this.saveSettings();
			},
			normalizeDetail: normalizePlaudDetail,
			renderMarkdown: (detail) => {
				const markdown = renderPlaudMarkdown(detail);
				return enrichSpec ? enrichMarkdown(markdown, enrichSpec) : markdown;
			},
			upsertNote: upsertPlaudNote
		});
	}

	private async loadEnrichSpec(vault: PlaudVaultAdapter): Promise<EnrichSpec | null> {
		const configPath = this.settings.enrichConfigPath;
		if (!configPath) {
			return null;
		}

		try {
			const spec = parseEnrichSpec(await vault.read(configPath));
			if (!spec) {
				console.warn(`[plaud-sync] enrichment config at "${configPath}" is missing or invalid; enrichment disabled for this run.`);
			}
			return spec;
		} catch {
			console.warn(`[plaud-sync] enrichment config at "${configPath}" could not be read; enrichment disabled for this run.`);
			return null;
		}
	}

	private async retryApiCall<T>(operation: string, execute: () => Promise<T>): Promise<T> {
		return withRetry(operation, execute, {
			policy: DEFAULT_RETRY_POLICY,
			onRetry: (event) => {
				this.logRetry(event);
			}
		});
	}

	private logRetry(event: RetryTelemetryEvent): void {
		console.warn('[plaud-sync] retry', {
			operation: event.operation,
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			category: event.category ?? 'unknown',
			status: typeof event.status === 'number' ? event.status : null,
			message: event.message
		});
	}

	private logFailure(event: string, error: unknown): void {
		console.warn('[plaud-sync] failure', {
			event,
			category: error instanceof PlaudApiError ? error.category : 'unknown',
			status: error instanceof PlaudApiError && typeof error.status === 'number' ? error.status : null,
			message: sanitizeTelemetryMessage(toErrorMessage(error))
		});
	}

	private async fetchSignedContent(url: string): Promise<unknown> {
		const response = await requestUrl({
			url,
			method: 'GET',
			throw: false
		});

		if (response.status >= 400) {
			throw new Error(`Signed content fetch failed with HTTP ${response.status}.`);
		}

		const parsedJson: unknown = (response as {json?: unknown}).json;
		if (parsedJson !== null && parsedJson !== undefined) {
			return parsedJson;
		}

		const text = typeof response.text === 'string' ? response.text.trim() : '';
		if (!text) {
			return '';
		}

		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	private createVaultAdapter(): PlaudVaultAdapter {
		return {
			ensureFolder: async (folder) => {
				const normalized = folder.replace(/\/+$/, '').trim();
				if (!normalized) {
					return;
				}

				if (this.app.vault.getAbstractFileByPath(normalized)) {
					return;
				}

				try {
					await this.app.vault.createFolder(normalized);
				} catch {
					if (!this.app.vault.getAbstractFileByPath(normalized)) {
						throw new Error(`Unable to create Plaud sync folder: ${normalized}`);
					}
				}
			},
			listMarkdownFiles: (folder) => {
				const normalized = folder.replace(/\/+$/, '');
				const prefix = `${normalized}/`;
				return Promise.resolve(
					this.app.vault
						.getMarkdownFiles()
						.map((file) => file.path)
						.filter((filePath) => filePath.startsWith(prefix))
				);
			},
			read: async (path) => {
				return this.app.vault.cachedRead(this.requireFile(path));
			},
			write: async (path, content) => {
				await this.app.vault.modify(this.requireFile(path), content);
			},
			create: async (path, content) => {
				await this.app.vault.create(path, content);
			}
		};
	}

	private requireFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`Markdown file not found in vault: ${path}`);
		}

		return file;
	}
}
