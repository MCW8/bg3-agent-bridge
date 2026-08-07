#!/usr/bin/env node
/**
 * Development install: copies the companion mod into the game's own Data/Mods
 * as loose files and registers it in modsettings.lsx.
 *
 * No divine, no mod manager, no packing. This is the right mode while
 * iterating, because a packed mod's Lua cannot be hot-reloaded — the pak is
 * read once at startup, so bg3_reload just re-reads the same bytes. Loose
 * files mean edits apply on the next reload.
 *
 * Deliberately plain .mjs with no imports beyond node builtins, so it runs
 * straight from a downloaded release without building anything first.
 *
 * Usage:  node scripts/install-dev.mjs [--uninstall]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOD_FOLDER = 'BG3AgentBridge';
const MOD_NAME = 'BG3 Agent Bridge';
const MOD_UUID = 'b0636853-9a7e-4fe9-b78c-1ff567ac2265';
const MOD_VERSION64 = '36028797018963968';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const modSource = path.join(packageRoot, 'mod', 'Mods', MOD_FOLDER);

const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
const larianDir = path.join(localAppData, 'Larian Studios', "Baldur's Gate 3");
const modsettingsPath = path.join(larianDir, 'PlayerProfiles', 'Public', 'modsettings.lsx');

function fail(message) {
    console.error(`\n  ${message}\n`);
    process.exit(1);
}

/** Steam records its library roots in libraryfolders.vdf; parse the paths out. */
function steamLibraries() {
    const roots = [
        'C:\\Program Files (x86)\\Steam',
        'C:\\Program Files\\Steam',
        path.join(homedir(), 'Steam'),
    ];
    const libraries = [...roots];

    for (const root of roots) {
        const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
        if (!existsSync(vdf)) continue;
        try {
            const text = readFileSync(vdf, 'utf8');
            for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
                libraries.push(match[1].replace(/\\\\/g, '\\'));
            }
        } catch {
            // Unreadable library file is not fatal; other candidates remain.
        }
    }
    return libraries;
}

function findGameDir() {
    const configured = process.env.BG3_GAME_DIR;
    if (configured) {
        if (!existsSync(path.join(configured, 'Data'))) {
            fail(`BG3_GAME_DIR is set to "${configured}" but there is no Data folder there.`);
        }
        return configured;
    }

    const candidates = [];
    for (const library of steamLibraries()) {
        candidates.push(path.join(library, 'steamapps', 'common', 'Baldurs Gate 3'));
    }
    candidates.push(
        'C:\\Program Files (x86)\\GOG Galaxy\\Games\\Baldurs Gate 3',
        'C:\\Program Files\\GOG Galaxy\\Games\\Baldurs Gate 3',
        'C:\\GOG Games\\Baldurs Gate 3',
        'C:\\Program Files (x86)\\Baldurs Gate 3',
        'C:\\Program Files\\Baldurs Gate 3',
    );

    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, 'Data'))) return candidate;
    }

    fail(
        'Could not find your Baldur\'s Gate 3 installation.\n' +
            '  Set BG3_GAME_DIR to the folder containing Data\\ and bin\\, for example:\n' +
            '    set BG3_GAME_DIR=D:\\Steam\\steamapps\\common\\Baldurs Gate 3\n\n' +
            '  Looked in:\n' +
            candidates.map((c) => `    ${c}`).join('\n'),
    );
}

function gameIsRunning() {
    if (process.platform !== 'win32') return false;
    try {
        const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq bg3*'], { encoding: 'utf8' });
        return /bg3(_dx11)?\.exe/i.test(output);
    } catch {
        return false;
    }
}

function backup(file) {
    // 14 chars = YYYYMMDDHHMMSS. Taking 15 would include the milliseconds dot,
    // and Windows silently strips trailing dots from filenames.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const target = `${file}.backup-${stamp}`;
    copyFileSync(file, target);
    return target;
}

const ENTRY = `            <node id="ModuleShortDesc">
              <attribute id="Folder" type="LSString" value="${MOD_FOLDER}" />
              <attribute id="MD5" type="LSString" value="" />
              <attribute id="Name" type="LSString" value="${MOD_NAME}" />
              <attribute id="PublishHandle" type="uint64" value="0" />
              <attribute id="UUID" type="guid" value="${MOD_UUID}" />
              <attribute id="Version64" type="int64" value="${MOD_VERSION64}" />
            </node>
`;

function updateModsettings({ remove }) {
    if (!existsSync(modsettingsPath)) {
        fail(
            `No modsettings.lsx at:\n    ${modsettingsPath}\n\n` +
                '  Launch Baldur\'s Gate 3 once and quit, then run this again.',
        );
    }

    const original = readFileSync(modsettingsPath, 'utf8');
    const present = original.includes(MOD_UUID);

    if (remove) {
        if (!present) return { changed: false, note: 'was not in the load order' };
        const pattern = new RegExp(`\\s*<node id="ModuleShortDesc">(?:(?!</node>)[\\s\\S])*?${MOD_UUID}[\\s\\S]*?</node>`, 'm');
        const updated = original.replace(pattern, '');
        if (updated === original) return { changed: false, note: 'entry found but could not be removed cleanly — edit by hand' };
        const backupPath = backup(modsettingsPath);
        writeFileSync(modsettingsPath, updated, 'utf8');
        return { changed: true, backupPath, note: 'removed from load order' };
    }

    if (present) return { changed: false, note: 'already in the load order' };

    // Append inside the Mods node's children, so it loads after everything
    // already listed.
    const modsIndex = original.indexOf('<node id="Mods">');
    if (modsIndex === -1) fail('modsettings.lsx has no <node id="Mods"> section — is it corrupt?');
    const closeIndex = original.indexOf('</children>', modsIndex);
    if (closeIndex === -1) fail('modsettings.lsx is malformed: no </children> after the Mods node.');

    const updated = original.slice(0, closeIndex) + ENTRY + original.slice(closeIndex);
    const backupPath = backup(modsettingsPath);
    writeFileSync(modsettingsPath, updated, 'utf8');
    return { changed: true, backupPath, note: 'added to load order' };
}

function main() {
    const uninstall = process.argv.includes('--uninstall');

    if (gameIsRunning()) {
        fail(
            'Baldur\'s Gate 3 is running. Quit it first.\n' +
                '  The game rewrites modsettings.lsx from memory when it exits, which would\n' +
                '  discard whatever this script writes now.',
        );
    }

    const gameDir = findGameDir();
    const target = path.join(gameDir, 'Data', 'Mods', MOD_FOLDER);

    console.log(`  game:  ${gameDir}`);
    console.log(`  mod:   ${target}`);

    if (uninstall) {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        const result = updateModsettings({ remove: true });
        console.log(`\n  Removed loose mod files.`);
        console.log(`  modsettings.lsx: ${result.note}`);
        if (result.backupPath) console.log(`  backup: ${result.backupPath}`);
        return;
    }

    if (!existsSync(modSource)) fail(`Mod source missing at ${modSource}`);

    mkdirSync(path.dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    cpSync(modSource, target, { recursive: true });

    const copied = readdirSync(target, { recursive: true }).length;
    const result = updateModsettings({ remove: false });

    console.log(`\n  Copied ${copied} entries.`);
    console.log(`  modsettings.lsx: ${result.note}`);
    if (result.backupPath) console.log(`  backup: ${result.backupPath}`);

    console.log(
        '\n  Next:\n' +
            '    1. Launch Baldur\'s Gate 3 and load a save\n' +
            '    2. Ask your agent to call bg3_bridge_status, or run:\n' +
            '         node scripts/check-bridge.mjs\n\n' +
            '  Editing the Lua under mod/ and re-running this script picks changes up on\n' +
            '  the next bg3_reload, with no game restart.\n',
    );
}

main();
