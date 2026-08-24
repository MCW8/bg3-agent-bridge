#!/usr/bin/env node
/**
 * First-run setup, shown when the exe is double-clicked (or run with no
 * arguments in an interactive console). An MCP client launches the exe with no
 * arguments too, but over a pipe, so main.ts routes here only when stdin is a
 * TTY — the server path is untouched.
 *
 * Deliberately minimal: install the mod, print the MCP config block to paste,
 * and hold the window open so it can be copied. Once that block is pasted, the
 * agent handles connecting, testing and verifying — so anything more belongs in
 * the README, not here.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { performInstall } from './install-dev.js';
import { mcpServerEntry } from '../runtime.js';

const RULE = '  ─────────────────────────────────────────────────────────────────';

export async function main(): Promise<void> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        console.log('\n  BG3 Agent Bridge — setup');
        console.log('  ========================');
        console.log('  Installing the companion mod (Baldur\'s Gate 3 must be CLOSED)...\n');

        let result;
        try {
            result = performInstall();
        } catch (error) {
            console.log(`  Install failed: ${(error as Error).message}\n`);
            console.log('  Fix the above and run setup again. See the README if you get stuck.\n');
            return;
        }

        console.log(`  game:  ${result.gameDir}`);
        console.log(`  mod:   ${result.target}`);
        console.log(`\n  Copied ${result.copied} entries.`);
        console.log(`  modsettings.lsx: ${result.modsettingsNote}`);
        if (result.backupPath !== null) console.log(`  backup: ${result.backupPath}`);

        const block = JSON.stringify({ mcpServers: { 'bg3-agent-bridge': mcpServerEntry() } }, null, 2)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n');

        console.log(`\n${RULE}`);
        console.log('  NEXT: copy everything between the lines and paste it to your AI');
        console.log('  agent, asking it to add this to its MCP config.');
        console.log(`${RULE}\n`);
        console.log(block);
        console.log(`\n${RULE}\n`);
        console.log('  Then you can safely close this window. Check the README for more information.\n');
    } finally {
        // Hold the console open so a double-clicked window stays up long enough
        // to read and copy the block above; Enter (or closing the window) ends it.
        await rl.question('');
        rl.close();
    }
}
