#!/usr/bin/env node
/**
 * Emits the MCP config block with this installation's real path already filled
 * in, and can write it into a known client's config file.
 *
 * The point is that nobody should ever retype a path. The command knows where
 * it lives, so the block it prints is correct by construction.
 *
 * Usage:
 *   bg3-bridge configure                 print the block (exe)
 *   bg3-bridge configure --list          show detected clients
 *   bg3-bridge configure --write kimi    write a known client's config
 *   bg3-bridge configure --path <file>   write any other client's config
 * Under Node, the same via: node scripts/configure-agent.mjs [...]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { invocation, isCompiledExe, mcpServerEntry, packageRoot, ranDirectly } from '../runtime.js';

const SERVER_KEY = 'bg3-agent-bridge';

// Forward slashes throughout: a single backslash in JSON is an escape character
// and produces a file that fails to parse, usually silently.
const serverEntry = mcpServerEntry();
const entryDisplay = [serverEntry.command, ...(serverEntry.args ?? [])].join(' ');

const appData = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');

interface Client {
    label: string;
    file: string;
}

const CLIENTS: Record<string, Client> = {
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

function printBlock(): void {
    console.log('\n  ─────────────────────────────────────────────────────────────────');
    console.log('   Copy this and paste it to your AI agent, asking it to add the');
    console.log('   server to its MCP config.');
    console.log('  ─────────────────────────────────────────────────────────────────\n');
    console.log(
        JSON.stringify({ mcpServers: { [SERVER_KEY]: serverEntry } }, null, 2)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
    );
    console.log('\n  ─────────────────────────────────────────────────────────────────\n');
    console.log(
        '  Most agents know where their own config lives and will create it if\n' +
            '  needed. Restart the agent afterwards.\n\n' +
            '  Claude Code can be told directly instead:\n' +
            `    claude mcp add ${SERVER_KEY} -- ${entryDisplay}\n\n` +
            `  Or write the file yourself:  ${invocation('configure')} --list\n`,
    );
}

function listClients(): void {
    console.log('\n  Known config locations:\n');
    for (const [key, client] of Object.entries(CLIENTS)) {
        const state = existsSync(client.file) ? 'exists' : 'not found';
        console.log(`    ${key.padEnd(16)} ${client.label}`);
        console.log(`    ${''.padEnd(16)} ${client.file}  (${state})`);
    }
    console.log(`\n  Write one with:  ${invocation('configure')} --write <name>`);
    console.log(`  Not listed?      ${invocation('configure')} --path "C:/path/to/its/mcp.json"`);
    console.log('\n  ("project" writes to whatever folder you run this from, currently:');
    console.log(`     ${process.cwd()} )\n`);
}

interface McpConfig {
    mcpServers?: Record<string, unknown>;
    [key: string]: unknown;
}

function writeClient(key: string | undefined, explicitPath?: string): void {
    // --path covers clients that are not in the table. New agents appear faster
    // than this list can track them, and they nearly all read `mcpServers`.
    const client = explicitPath !== undefined ? { label: 'custom path', file: path.resolve(explicitPath) } : CLIENTS[key!];

    if (client === undefined) {
        console.error(
            `\n  Unknown client "${key}". Known: ${Object.keys(CLIENTS).join(', ')}\n\n` +
                '  For anything else, point at its config file directly:\n' +
                `    ${invocation('configure')} --path "C:/Users/you/.some-agent/mcp.json"\n`,
        );
        process.exit(1);
    }

    let config: McpConfig = {};
    if (existsSync(client.file)) {
        try {
            // Strip a UTF-8 BOM before parsing. Notepad and PowerShell's
            // Out-File both write one by default, and JSON.parse rejects it —
            // which would otherwise look like "your config is corrupt".
            const raw = readFileSync(client.file, 'utf8').replace(/^﻿/, '');
            config = raw.trim() === '' ? {} : (JSON.parse(raw) as McpConfig);
        } catch (error) {
            console.error(
                `\n  ${client.file} exists but is not valid JSON, so it has been left alone:\n` +
                    `    ${(error as Error).message}\n\n  Fix or delete it, then re-run.\n`,
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
    console.log(`  -> ${entryDisplay}`);
    console.log('\n  Restart the client for it to pick this up.\n');
}

export function main(args: string[]): void {
    // Under Node the server entry must exist to be configured; the exe is
    // self-evidently present.
    if (!isCompiledExe() && !existsSync(path.join(packageRoot(), 'dist', 'index.js'))) {
        console.error(
            `\n  ${path.join(packageRoot(), 'dist', 'index.js')} is missing.\n\n` +
                '  If you cloned the repo, build it first:  npm install && npm run build\n' +
                '  If you downloaded the release zip, it should already be there — re-extract it.\n',
        );
        process.exit(1);
    }

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
}

if (ranDirectly(import.meta.url)) main(process.argv.slice(2));
