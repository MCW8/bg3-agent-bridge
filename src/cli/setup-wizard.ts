#!/usr/bin/env node
/**
 * First-run setup, shown when the exe is double-clicked (or run with no
 * arguments in an interactive console). An MCP client launches the exe with no
 * arguments too, but over a pipe, so main.ts routes here only when stdin is a
 * TTY — the server path is untouched.
 *
 * Deliberately minimal. On a fresh machine it installs the mod and prints the
 * MCP config block to paste; on a machine where it is already installed it
 * offers reinstall/uninstall instead — so uninstalling is as easy as running
 * the same exe. Everything past pasting the config is the agent's job, so the
 * rest lives in the README, not here.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { performInstall, installStatus, type InstallResult } from './install-dev.js';
import { mcpServerEntry } from '../runtime.js';

const RULE = '  ─────────────────────────────────────────────────────────────────';

function reportInstalled(result: InstallResult): void {
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
}

function reportUninstalled(result: InstallResult): void {
    console.log(`  game:  ${result.gameDir}`);
    console.log(`  mod:   ${result.target}`);
    console.log('\n  Removed the companion mod\'s loose files.');
    console.log(`  modsettings.lsx: ${result.modsettingsNote}`);
    if (result.backupPath !== null) console.log(`  backup: ${result.backupPath}`);
    console.log('\n  Uninstalled. Also remove "bg3-agent-bridge" from your AI agent\'s MCP config.');
    console.log('  You can safely close this window.\n');
}

export async function main(): Promise<void> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        console.log('\n  BG3 Agent Bridge — setup');
        console.log('  ========================');

        // Already installed? Offer to manage it. A fresh machine skips the menu
        // entirely and goes straight to installing — the common first-run path.
        let uninstall = false;
        if (installStatus().installed) {
            console.log('  The bridge is already installed. What would you like to do?\n');
            console.log('    1. Reinstall / update (after downloading a newer version)');
            console.log('    2. Uninstall');
            console.log('    3. Cancel\n');
            const answer = (await rl.question('  Choose 1-3 [1]: ')).trim();
            const choice = answer === '' ? 1 : Number.parseInt(answer, 10);
            if (choice === 2) {
                uninstall = true;
            } else if (choice !== 1) {
                console.log('\n  Cancelled — nothing changed.\n');
                return;
            }
        }

        console.log(
            uninstall
                ? '\n  Uninstalling (Baldur\'s Gate 3 must be CLOSED)...\n'
                : '\n  Installing the companion mod (Baldur\'s Gate 3 must be CLOSED)...\n',
        );

        let result: InstallResult;
        try {
            result = performInstall({ uninstall });
        } catch (error) {
            console.log(`  ${uninstall ? 'Uninstall' : 'Install'} failed: ${(error as Error).message}\n`);
            console.log('  Fix the above and run this again. See the README if you get stuck.\n');
            return;
        }

        if (result.uninstall) reportUninstalled(result);
        else reportInstalled(result);
    } finally {
        // Hold the console open so a double-clicked window stays up long enough
        // to read (and copy) the output; Enter or closing the window ends it.
        await rl.question('');
        rl.close();
    }
}
