import {App, Notice, PluginSettingTab, Setting} from 'obsidian';
import type PlaudSyncPlugin from './main';
import {clearPlaudToken, getPlaudToken, isEncryptedStorageAvailable, setPlaudToken} from './secret-store';
import {DEFAULT_SETTINGS, isValidBridgePort} from './settings-schema';

export class PlaudSettingTab extends PluginSettingTab {
	plugin: PlaudSyncPlugin;
	private bridgeSecretSetting: Setting | null = null;
	private bridgeStatusSetting: Setting | null = null;

	constructor(app: App, plugin: PlaudSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		const encryptionAvailable = isEncryptedStorageAvailable();
		new Setting(containerEl)
			.setName('Secret storage encryption')
			.setDesc(
				encryptionAvailable
					? 'Available. Your Plaud token and bridge secret are encrypted with this OS user account\'s '
						+ 'credential store before being written to local storage.'
					: 'Unavailable in this runtime. Your Plaud token and bridge secret are being stored as '
						+ 'plaintext in local storage. This is expected on mobile; on desktop it likely means '
						+ 'Obsidian\'s bundled Electron no longer exposes @electron/remote\'s safeStorage API.'
			);

		const tokenStatusSetting = new Setting(containerEl)
			.setName('Plaud token status')
			.setDesc('Checking token status...');

		new Setting(containerEl)
			.setName('Plaud token')
			.setDesc('Stored in Obsidian secret storage when available.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Paste plaud token');

				void getPlaudToken(this.app).then((token) => {
					text.setValue(token ?? '');
				});

				text.onChange(async (value) => {
					const token = value.trim();
					if (!token) {
						await clearPlaudToken(this.app);
						await this.refreshTokenStatus(tokenStatusSetting);
						new Notice('Plaud token cleared. Paste a token to enable API sync.');
						return;
					}

					try {
						await setPlaudToken(this.app, token);
						await this.refreshTokenStatus(tokenStatusSetting);
						new Notice('Plaud token saved.');
					} catch (error) {
						const message = error instanceof Error ? error.message : 'Failed to save Plaud token.';
						new Notice(message);
					}
				});
			});

		void this.refreshTokenStatus(tokenStatusSetting);

		new Setting(containerEl)
			.setName('API domain')
			.setDesc('Base endpoint for plaud requests.')
			.addText((text) => text
				.setPlaceholder(DEFAULT_SETTINGS.apiDomain)
				.setValue(this.plugin.settings.apiDomain)
				.onChange(async (value) => {
					this.plugin.settings.apiDomain = value.trim() || DEFAULT_SETTINGS.apiDomain;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync folder')
			.setDesc('Store synced notes in this folder.')
			.addText((text) => text
				.setPlaceholder('Plaud')
				.setValue(this.plugin.settings.syncFolder)
				.onChange(async (value) => {
					this.plugin.settings.syncFolder = value.trim() || DEFAULT_SETTINGS.syncFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Run a sync automatically when Obsidian starts.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Update existing notes')
			.setDesc('Update existing files when matching plaud recordings are found.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.updateExisting)
				.onChange(async (value) => {
					this.plugin.settings.updateExisting = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Filename pattern')
			.setDesc('Pattern used for new synced files.')
			.addText((text) => text
				.setPlaceholder(DEFAULT_SETTINGS.filenamePattern)
				.setValue(this.plugin.settings.filenamePattern)
				.onChange(async (value) => {
					this.plugin.settings.filenamePattern = value.trim() || DEFAULT_SETTINGS.filenamePattern;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Last sync checkpoint')
			.setDesc('Unix timestamp in milliseconds for incremental sync state.')
			.addText((text) => text
				.setValue(String(this.plugin.settings.lastSyncAtMs))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.lastSyncAtMs = Number.isFinite(parsed) && parsed >= 0
						? parsed
						: DEFAULT_SETTINGS.lastSyncAtMs;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Browser token bridge (desktop only)')
			.setHeading()
			.setDesc('Lets a companion browser extension push a freshly-refreshed Plaud token to this plugin '
				+ 'automatically, so you don\'t have to paste one by hand. The listener only binds to 127.0.0.1 '
				+ 'and requires the secret below on every request.');

		this.bridgeStatusSetting = new Setting(containerEl)
			.setName('Bridge status')
			.setDesc('Checking bridge status...');

		new Setting(containerEl)
			.setName('Enable browser token bridge')
			.setDesc('Starts a local-only listener that accepts token updates from the browser extension.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.bridgeEnabled)
				.onChange(async (value) => {
					await this.plugin.setBridgeEnabled(value);
					await this.refreshBridgeSecretField();
					this.refreshBridgeStatus();
				}));

		new Setting(containerEl)
			.setName('Bridge port')
			.setDesc('Local port the listener binds to. Toggle the bridge off and back on after changing this.')
			.addText((text) => {
				text.setValue(String(this.plugin.settings.bridgePort));
				text.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (isValidBridgePort(parsed)) {
						this.plugin.settings.bridgePort = parsed;
						await this.plugin.saveSettings();
						return;
					}

					new Notice('Bridge port must be a number between 1024 and 65535.');
					text.setValue(String(this.plugin.settings.bridgePort));
				});
			});

		this.bridgeSecretSetting = new Setting(containerEl)
			.setName('Bridge secret')
			.setDesc('Paste this into the browser extension\'s options page. Regenerating invalidates the old value everywhere.')
			.addButton((button) => button
				.setButtonText('Regenerate')
				.onClick(async () => {
					await this.plugin.regenerateBridgeSecret();
					new Notice('Bridge secret regenerated. Update the browser extension with the new value.');
					await this.refreshBridgeSecretField();
					this.refreshBridgeStatus();
				}));

		void this.refreshBridgeSecretField();
		this.refreshBridgeStatus();

		containerEl.createEl('p', {
			text: `Endpoint the extension posts to: http://127.0.0.1:${this.plugin.settings.bridgePort}/token`
		});
	}

	private async refreshTokenStatus(statusSetting: Setting): Promise<void> {
		const token = await getPlaudToken(this.app);
		statusSetting.setDesc(
			token
				? 'Plaud token configured. Use Validate token command to confirm access.'
				: 'Plaud token missing. Paste your token above to enable sync.'
		);
	}

	private refreshBridgeStatus(): void {
		if (!this.bridgeStatusSetting) {
			return;
		}

		const status = this.plugin.getBridgeStatus();
		if (!status.enabled) {
			this.bridgeStatusSetting.setDesc('Disabled.');
			return;
		}

		if (status.running) {
			this.bridgeStatusSetting.setDesc('Running.');
			return;
		}

		this.bridgeStatusSetting.setDesc(
			status.lastError
				? `Enabled but not running: ${status.lastError}`
				: 'Enabled but not running.'
		);
	}

	private async refreshBridgeSecretField(): Promise<void> {
		if (!this.bridgeSecretSetting) {
			return;
		}

		const secret = await this.plugin.ensureBridgeSecret();
		this.bridgeSecretSetting.setDesc(
			`Paste this into the browser extension's options page: ${secret}`
		);
	}
}
