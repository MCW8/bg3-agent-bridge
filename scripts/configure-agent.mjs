#!/usr/bin/env node
/**
 * Emits the MCP config block with this installation's real path already filled
 * in, and can write it into a known client's config file.
 *
 * Thin wrapper — the logic lives in src/cli/configure-agent.ts so this script
 * and the compiled exe share one implementation. Requires a build (dist/) or
 * the release zip, which ships dist/ already built.
 *
 * Usage:
 *   node scripts/configure-agent.mjs                 print the block
 *   node scripts/configure-agent.mjs --list          show detected clients
 *   node scripts/configure-agent.mjs --write kimi    write a known client
 *   node scripts/configure-agent.mjs --path <file>   write any other client
 */
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../dist/cli/configure-agent.js', import.meta.url);
if (!existsSync(moduleUrl)) {
    console.error('\n  dist/ is missing. Build first:  npm install && npm run build\n');
    process.exit(1);
}

const { main } = await import(moduleUrl.href);
main(process.argv.slice(2));
