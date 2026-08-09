#!/usr/bin/env node
/**
 * Verify the bridge without an MCP client in the loop.
 *
 * Thin wrapper — the logic lives in src/cli/check-bridge.ts so this script and
 * the compiled exe share one implementation. Requires a build (dist/) or the
 * release zip, which ships dist/ already built.
 *
 * Usage:  node scripts/check-bridge.mjs
 */
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../dist/cli/check-bridge.js', import.meta.url);
if (!existsSync(moduleUrl)) {
    console.error('\n  dist/ is missing. Build first:  npm install && npm run build\n');
    process.exit(1);
}

const { main } = await import(moduleUrl.href);
await main();
