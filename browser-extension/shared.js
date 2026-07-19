// Loaded by content-script.js (via manifest.json content_scripts), background.js (via
// importScripts), and options.html (via <script src>) so all three share one definition instead
// of drifting independently. Classic (non-module) script -- declares plain globals in whichever
// context loads it.

const MESSAGE_TYPE_TOKEN = 'plaud-token-bridge/token';

function isBridgeConfigured({port, secret}) {
	return Boolean(port) && Boolean(secret);
}
