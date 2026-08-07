#!/usr/bin/env node
/**
 * Emits the MCP config block with this installation's real path already filled
 * in, and can write it into a known client's config file.
 *
 * The point is that nobody should ever retype a path. The script knows where it
 * lives, so the block it prints is correct by construction.
 *
 * Usage:
 *   node scripts/configure-agent.mjs                 print the block
 *   node scripts/configure-agent.mjs --list          show detected clients
 *   node scripts/configure-agent.mjs --write claude-desktop
 *   node scripts/configure-agent.mjs --write cursor
 *   node scripts/configure-agent.mjs --write project  (.mcp.json here)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_KEY = 'bg3-agent-bridge';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const entryPoint = path.join(packageRoot, 'dist', 'index.js');

// Forward slashes throughout: a single backslash in JSON is an escape character
// and produces a file that fails to parse, usually silently.
const entryForJson = entryPoint.replace(/\\/g, '/');

const serverEntry = {
    command: 'node',
    args: [entryForJson],
};

const appData = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');

const CLIENTS = {
    'claude-desktop': {
        label: 'Claude Desktop',
        file: path.join(appData, 'Claude', 'claude_desktop_config.json'),
    },
    kimi: {
        label: 'Kimi Code',
        file: path.join(homedir(), '.kimi-code', 'mcp.json'),
    },
    cursor: {
        label: 'Cursor (global)',
        file: path.join(homedir(), '.cursor', 'mcp.json'),
    },
    project: {
        label: 'Project-scoped .mcp.json, written to the current folder',
        file: path.join(process.cwd(), '.mcp.json'),
    },
};

function printBlock() {
    console.log('\n  Paste this into your agent\'s MCP config:\n');
    console.log(
        JSON.stringify({ mcpServers: { [SERVER_KEY]: serverEntry } }, null, 2)
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n'),
    );
    console.log('\n  Claude Code users can skip the file entirely:\n');
    console.log(`    claude mcp add ${SERVER_KEY} -- node "${entryPoint}"\n`);
}

function listClients() {
    console.log('\n  Known config locations:\n');
    for (const [key, client] of Object.entries(CLIENTS)) {
        const state = existsSync(client.file) ? 'exists' : 'not found';
        console.log(`    ${key.padEnd(16)} ${client.label}`);
        console.log(`    ${''.padEnd(16)} ${client.file}  (${state})`);
    }
    console.log('\n  Write one with:  node scripts/configure-agent.mjs --write <name>');
    console.log('  Not listed?      node scripts/configure-agent.mjs --path "C:/path/to/its/mcp.json"');
    console.log('\n  ("project" writes to whatever folder you run this from, currently:');
    console.log(`     ${process.cwd()} )\n`);
}

function writeClient(key, explicitPath) {
    // --path covers clients that are not in the table. New agents appear faster
    // than this list can track them, and they nearly all read `mcpServers`.
    const client =
        explicitPath !== undefined
            ? { label: 'custom path', file: path.resolve(explicitPath) }
            : CLIENTS[key];

    if (client === undefined) {
        console.error(
            `\n  Unknown client "${key}". Known: ${Object.keys(CLIENTS).join(', ')}\n\n` +
                '  For anything else, point at its config file directly:\n' +
                '    node scripts/configure-agent.mjs --path "C:/Users/you/.some-agent/mcp.json"\n',
        );
        process.exit(1);
    }

    let config = {};
    if (existsSync(client.file)) {
        try {
            // Strip a UTF-8 BOM before parsing. Notepad and PowerShell's
            // Out-File both write one by default, and JSON.parse rejects it —
            // which would otherwise look like "your config is corrupt".
            const raw = readFileSync(client.file, 'utf8').replace(/^﻿/, '');
            config = raw.trim() === '' ? {} : JSON.parse(raw);
        } catch (error) {
            console.error(
                `\n  ${client.file} exists but is not valid JSON, so it has been left alone:\n` +
                    `    ${error.message}\n\n  Fix or delete it, then re-run.\n`,
            );
            process.exit(1);
        }
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const backup = `${client.file}.backup-${stamp}`;
        copyFileSync(client.file, backup);
        console.log(`\n  backup: ${backup}`);
    } else {
        mkdirSync(path.dirname(client.file), { recursive: true });
        console.log(`\n  creating: ${client.file}`);
    }

    const existed = config.mcpServers?.[SERVER_KEY] !== undefined;
    config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_KEY]: serverEntry };
    writeFileSync(client.file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    console.log(`  ${existed ? 'updated' : 'added'} "${SERVER_KEY}" in ${client.label}`);
    console.log(`  -> ${entryPoint}`);
    console.log('\n  Restart the client for it to pick this up.\n');
}

function main() {
    if (!existsSync(entryPoint)) {
        console.error(
            `\n  ${entryPoint} is missing.\n\n` +
                '  If you cloned the repo, build it first:  npm install && npm run build\n' +
                '  If you downloaded the release zip, it should already be there — re-extract it.\n',
        );
        process.exit(1);
    }

    const args = process.argv.slice(2);
    if (args.includes('--list')) return listClients();

    const pathIndex = args.indexOf('--path');
    if (pathIndex !== -1) {
        const target = args[pathIndex + 1];
        if (target === undefined) {
            console.error('\n  --path needs a file, e.g. --path "C:/Users/you/.some-agent/mcp.json"\n');
            process.exit(1);
        }
        return writeClient(undefined, target);
    }

    const writeIndex = args.indexOf('--write');
    if (writeIndex !== -1) {
        const target = args[writeIndex + 1];
        if (target === undefined) {
            console.error(`\n  --write needs a client name. Known: ${Object.keys(CLIENTS).join(', ')}\n`);
            process.exit(1);
        }
        return writeClient(target);
    }

    printBlock();
    console.log('  Or write it automatically:  node scripts/configure-agent.mjs --list\n');
}

main();
