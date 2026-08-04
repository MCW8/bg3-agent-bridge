#!/usr/bin/env node
/**
 * Packs the companion mod into a .pak and drops it in the BG3 Mods directory.
 *
 * Deliberately does not touch modsettings.lsx. Rewriting a load order in place
 * is the single easiest way to break someone's install, so enabling the mod
 * stays a manual step in whatever mod manager they already trust.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOD_FOLDER, modsDir } from '../paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..');
const workspace = path.join(packageRoot, 'mod');

const COMMON_DIVINE_LOCATIONS = [
    'C:\\Program Files\\BG3 Modders Multitool\\Tools\\divine.exe',
    'C:\\Program Files (x86)\\BG3 Modders Multitool\\Tools\\divine.exe',
];

function findDivine(): string | null {
    const configured = process.env.BG3_DIVINE_PATH;
    if (configured !== undefined && configured !== '') {
        return existsSync(configured) ? configured : null;
    }

    const onPath = spawnSync('where', ['divine.exe'], { encoding: 'utf8' });
    if (onPath.status === 0) {
        const first = onPath.stdout.split(/\r?\n/).find((line) => line.trim() !== '');
        if (first !== undefined) return first.trim();
    }

    return COMMON_DIVINE_LOCATIONS.find((candidate) => existsSync(candidate)) ?? null;
}

function main(): number {
    const force = process.argv.includes('--force');

    if (!existsSync(workspace)) {
        console.error(`Mod workspace missing at ${workspace}`);
        return 1;
    }

    const divine = findDivine();
    if (divine === null) {
        console.error(
            'Could not find divine.exe (the LSLib CLI).\n\n' +
                'Install BG3 Modders Multitool or LSLib, then either add divine.exe to PATH or set BG3_DIVINE_PATH to its full path.\n' +
                'LSLib: https://github.com/Norbyte/lslib',
        );
        return 1;
    }

    const destination = path.join(modsDir(), `${MOD_FOLDER}.pak`);
    if (existsSync(destination) && !force) {
        console.error(`${destination} already exists. Re-run with --force to overwrite it.`);
        return 1;
    }

    console.log(`divine:      ${divine}`);
    console.log(`workspace:   ${workspace}`);
    console.log(`destination: ${destination}\n`);

    const result = spawnSync(
        divine,
        ['-g', 'bg3', '-a', 'create-package', '-s', workspace, '-d', destination],
        { encoding: 'utf8', stdio: 'inherit' },
    );

    if (result.error !== undefined) {
        console.error(`Failed to run divine: ${result.error.message}`);
        return 1;
    }
    if (result.status !== 0) {
        console.error(`divine exited with code ${result.status}`);
        return result.status ?? 1;
    }

    console.log(
        `\nPacked ${MOD_FOLDER}.pak.\n\n` +
            'Next steps:\n' +
            '  1. Enable "BG3 Agent Bridge" in your mod manager and export the load order.\n' +
            '  2. Launch the game and load a save.\n' +
            '  3. Run the bg3_bridge_status tool to confirm the bridge answers.\n',
    );
    return 0;
}

process.exit(main());
