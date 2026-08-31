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
 * Usage:  bg3-bridge install [--uninstall]   (exe)
 *         node scripts/install-dev.mjs [--uninstall]   (Node)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { MOD_FOLDER, modsDir } from '../paths.js';
import { isCompiledExe, mcpServerEntry, packageRoot, ranDirectly } from '../runtime.js';

const MOD_NAME = 'BG3 Agent Bridge';
const MOD_UUID = 'b0636853-9a7e-4fe9-b78c-1ff567ac2265';
const MOD_VERSION64 = '36028797018963968';

const modSource = path.join(packageRoot(), 'mod', 'Mods', MOD_FOLDER);

/**
 * The prebuilt pak ships next to the executable in the release zip; under
 * Node it is built to the repo root by `bg3-bridge pack` (divine/LSLib).
 */
const pakSource = path.join(packageRoot(), `${MOD_FOLDER}.pak`);

const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
const larianDir = path.join(localAppData, 'Larian Studios', "Baldur's Gate 3");
const modsettingsPath = path.join(larianDir, 'PlayerProfiles', 'Public', 'modsettings.lsx');

// Throw rather than exit: the setup wizard calls installMod() and needs to
// present failures (game still running, etc.) and pause, which process.exit
// would skip. The CLI wrapper below turns a throw back into a clean exit.
function fail(message: string): never {
    throw new Error(message);
}

/** Steam records its library roots in libraryfolders.vdf; parse the paths out. */
function steamLibraries(): string[] {
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
                libraries.push(match[1]!.replace(/\\\\/g, '\\'));
            }
        } catch {
            // Unreadable library file is not fatal; other candidates remain.
        }
    }
    return libraries;
}

function findGameDir(): string {
    const configured = process.env.BG3_GAME_DIR;
    if (configured) {
        if (!existsSync(path.join(configured, 'Data'))) {
            fail(`BG3_GAME_DIR is set to "${configured}" but there is no Data folder there.`);
        }
        return configured;
    }

    const candidates: string[] = [];
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

    return fail(
        'Could not find your Baldur\'s Gate 3 installation.\n' +
            '  Set BG3_GAME_DIR to the folder containing Data\\ and bin\\, for example:\n' +
            '    set BG3_GAME_DIR=D:\\Steam\\steamapps\\common\\Baldurs Gate 3\n\n' +
            '  Looked in:\n' +
            candidates.map((c) => `    ${c}`).join('\n'),
    );
}

function gameIsRunning(): boolean {
    if (process.platform !== 'win32') return false;
    try {
        const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq bg3*'], { encoding: 'utf8' });
        return /bg3(_dx11)?\.exe/i.test(output);
    } catch {
        return false;
    }
}

function backup(file: string): string {
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

interface ModsettingsResult {
    changed: boolean;
    note: string;
    backupPath?: string;
}

function updateModsettings({ remove }: { remove: boolean }): ModsettingsResult {
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

/** Catch an old Node here, rather than as a confusing failure once the agent connects. */
function checkNodeVersion(): void {
    if (isCompiledExe()) return; // The exe carries its own runtime.
    const major = Number.parseInt(process.versions.node.split('.')[0]!, 10);
    if (Number.isFinite(major) && major < 20) {
        fail(
            `Node ${process.versions.node} is too old — this needs 20 or newer.\n\n` +
                '  Update with:  winget install OpenJS.NodeJS.LTS\n' +
                '  Then close this window and open a new one before retrying.',
        );
    }
}

export interface InstallResult {
    uninstall: boolean;
    flavor: 'pak' | 'loose';
    gameDir: string;
    target: string;
    copied: number | null;
    modsettingsNote: string;
    backupPath: string | null;
}

export function performInstall(opts: { uninstall?: boolean; flavor?: 'pak' | 'loose' } = {}): InstallResult {
    checkNodeVersion();
    const uninstall = opts.uninstall === true;
    const flavor = opts.flavor ?? 'pak';

    if (gameIsRunning()) {
        fail(
            'Baldur\'s Gate 3 is running. Quit it first.\n' +
                '  The game rewrites modsettings.lsx from memory when it exits, which would\n' +
                '  discard whatever this script writes now.',
        );
    }

    const gameDir = findGameDir();
    const looseTarget = path.join(gameDir, 'Data', 'Mods', MOD_FOLDER);
    const pakTarget = path.join(modsDir(), `${MOD_FOLDER}.pak`);

    if (uninstall) {
        // Both flavors: an install history can have left either (or both).
        if (existsSync(looseTarget)) rmSync(looseTarget, { recursive: true, force: true });
        if (existsSync(pakTarget)) rmSync(pakTarget, { force: true });
        const result = updateModsettings({ remove: true });
        return { uninstall: true, flavor, gameDir, target: pakTarget, copied: null, modsettingsNote: result.note, backupPath: result.backupPath ?? null };
    }

    if (flavor === 'pak' && !existsSync(pakSource)) {
        fail(
            `No prebuilt pak at:\n    ${pakSource}\n\n` +
                '  The release zip ships it next to bg3-bridge.exe. To rebuild it:\n' +
                '    bg3-bridge pack            (needs LSLib\\Divine; set BG3_DIVINE_PATH)\n' +
                '  Or install the loose development copy instead:\n' +
                '    bg3-bridge install --loose',
        );
    }

    const result = updateModsettings({ remove: false });

    if (flavor === 'pak') {
        // One flavor at a time: the game serves a pak over loose files, so a
        // leftover loose folder would be shadowed invisibly (and bg3_reload
        // would keep re-reading the pak's Lua, confusing the edit loop).
        if (existsSync(looseTarget)) rmSync(looseTarget, { recursive: true, force: true });
        copyFileSync(pakSource, pakTarget);
        return { uninstall: false, flavor, gameDir, target: pakTarget, copied: null, modsettingsNote: result.note, backupPath: result.backupPath ?? null };
    }

    // Loose (development) flavor: the mirror-image cutover, so a leftover pak
    // cannot win over the hot-reloadable loose files.
    if (existsSync(pakTarget)) rmSync(pakTarget, { force: true });
    if (!existsSync(modSource)) fail(`Mod source missing at ${modSource}`);
    mkdirSync(path.dirname(looseTarget), { recursive: true });
    rmSync(looseTarget, { recursive: true, force: true });
    cpSync(modSource, looseTarget, { recursive: true });
    const copied = readdirSync(looseTarget, { recursive: true }).length;
    return { uninstall: false, flavor, gameDir, target: looseTarget, copied, modsettingsNote: result.note, backupPath: result.backupPath ?? null };
}

/**
 * Read-only check of whether the mod is already installed, for the setup wizard
 * to decide between installing and offering to uninstall. Never throws — a game
 * it cannot find just reports not-installed. Either flavor counts: the wizard
 * manages the install whichever way a previous version put it there.
 */
export function installStatus(): { gameDir: string | null; installed: boolean } {
    let gameDir: string;
    try {
        gameDir = findGameDir();
    } catch {
        return { gameDir: null, installed: false };
    }
    return {
        gameDir,
        installed:
            existsSync(path.join(gameDir, 'Data', 'Mods', MOD_FOLDER)) ||
            existsSync(path.join(modsDir(), `${MOD_FOLDER}.pak`)),
    };
}
/** The `bg3-bridge install` command: install, then print the config to paste. */
export function installMod(args: string[]): void {
    const flavor = args.includes('--loose') ? 'loose' : 'pak';
    const r = performInstall({ uninstall: args.includes('--uninstall'), flavor });

    console.log(`  game:  ${r.gameDir}`);
    console.log(`  mod:   ${r.target}`);

    if (r.uninstall) {
        console.log('\n  Removed the companion mod (pak and loose files, whichever existed).');
        console.log(`  modsettings.lsx: ${r.modsettingsNote}`);
        if (r.backupPath !== null) console.log(`  backup: ${r.backupPath}`);
        return;
    }

    if (r.flavor === 'pak') {
        console.log(`\n  Installed ${path.basename(r.target)} into the game's Mods directory.`);
    } else {
        console.log(`\n  Copied ${r.copied} loose entries (dev mode: Lua edits hot-reload with bg3_reload).`);
    }
    console.log(`  modsettings.lsx: ${r.modsettingsNote}`);
    if (r.backupPath !== null) console.log(`  backup: ${r.backupPath}`);

    // Print the agent config with the real path already filled in — nobody
    // should have to work out where they extracted this. Once it is pasted, the
    // agent handles connecting and testing, so the rest lives in the README.
    console.log('\n  ─────────────────────────────────────────────────────────────────');
    console.log('   NEXT: copy everything between the lines and paste it to your AI');
    console.log('   agent, asking it to add this to its MCP config.');
    console.log('  ─────────────────────────────────────────────────────────────────\n');
    console.log(
        JSON.stringify({ mcpServers: { 'bg3-agent-bridge': mcpServerEntry() } }, null, 2)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
    );
    console.log('\n  ─────────────────────────────────────────────────────────────────\n');
    console.log('  Then paste that to your agent and it takes it from here. See the README for more.\n');
}

export function main(args: string[]): void {
    try {
        installMod(args);
    } catch (error) {
        console.error(`\n  ${(error as Error).message}\n`);
        process.exit(1);
    }
}

if (ranDirectly(import.meta.url)) main(process.argv.slice(2));
