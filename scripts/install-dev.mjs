#!/usr/bin/env node
/**
 * Development install: copies the companion mod into the game's own Data/Mods
 * as loose files and registers it in modsettings.lsx.
 *
 * Thin wrapper — the logic lives in src/cli/install-dev.ts so this script and
 * the compiled exe share one implementation. Requires a build (dist/) or the
 * release zip, which ships dist/ already built.
 *
 * Usage:  node scripts/install-dev.mjs [--uninstall]
 */
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../dist/cli/install-dev.js', import.meta.url);
if (!existsSync(moduleUrl)) {
    console.error('\n  dist/ is missing. Build first:  npm install && npm run build\n');
    process.exit(1);
}

const { main } = await import(moduleUrl.href);
main(process.argv.slice(2));
