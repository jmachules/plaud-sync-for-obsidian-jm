import {App, Modal} from 'obsidian';

// A dismissal (Escape, click-outside, close button) resolves to `false` -- fail closed, since
// the caller is asking "is it OK to write this secret as plaintext?" and an ambiguous dismissal
// should never be treated as consent.
class PlaintextFallbackModal extends Modal {
	private resolved = false;
	private resolveChoice: (value: boolean) => void = () => {};

	constructor(app: App, private readonly label: string) {
		super(app);
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.createEl('h2', {text: 'Save as plaintext?'});
		contentEl.createEl('p', {
			text: `OS-level encryption isn't available in this runtime. Saving the ${this.label} now `
				+ 'will store it as plaintext in local storage, readable directly from DevTools -> '
				+ 'Application -> Local Storage. Continue anyway?'
		});

		const buttonRow = contentEl.createDiv({cls: 'plaud-sync-modal-button-row'});

		buttonRow.createEl('button', {text: 'Cancel'})
			.addEventListener('click', () => this.finish(false));

		buttonRow.createEl('button', {text: 'Save as plaintext', cls: 'mod-warning'})
			.addEventListener('click', () => this.finish(true));
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(false);
	}

	waitForChoice(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolveChoice = resolve;
		});
	}

	private finish(result: boolean): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolveChoice(result);
		this.close();
	}
}

export function confirmPlaintextFallback(app: App, label: string): Promise<boolean> {
	const modal = new PlaintextFallbackModal(app, label);
	const choice = modal.waitForChoice();
	modal.open();
	return choice;
}
