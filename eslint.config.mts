import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Desktop-only local listener (guarded at runtime via Platform.isDesktopApp).
		// Needs real Node builtins, unlike the rest of the plugin which stays mobile-safe.
		files: ['src/token-bridge-server.ts'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'import/no-nodejs-modules': 'off',
		},
	},
	{
		// Encrypts the secret-storage fallback via @electron/remote's safeStorage (desktop-only,
		// feature-detected at runtime -- see src/secret-store.ts). Needs the Buffer global.
		files: ['src/secret-store.ts'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	{
		// Test files run directly under Node (node --experimental-strip-types --test).
		files: ['test/**/*.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
