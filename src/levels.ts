import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Level names for teleporting, without unpacking anything.
 *
 * Field notes #6: the playable level name is the LEVEL FOLDER name
 * (Data/Editor/Mods/<Module>/Levels/<name>), not the region/trigger name,
 * and there is no Lua-side enumeration of it — Ext.IO exposes no directory
 * listing and no resource bank or Osiris DB carries levels (all probed).
 *
 * The authoritative source is the game's own Editor data: the stock install
 * ships every module's levels as loose directories under
 * <game>/Data/Editor/Mods/<Module>/Levels/ — verified against a live Steam
 * install, which yields the full level set (596 across 15 modules, including
 * the base-game and GustavDev content) with a plain directory walk. The
 * distribution paks use Larian's proprietary package format (not zip), so
 * they are deliberately not parsed; the loose Editor data is complete.
 */

export interface LevelEntry {
    level: string;
    module: string;
}

export interface LevelScan {
    gameDir: string;
    dataDir: string;
    levels: LevelEntry[];
    modulesScanned: number;
    errors: string[];
}

const PROCESS_QUERY_TIMEOUT_MS = 5000;

/**
 * Locate the game install. Order: BG3_GAME_DIR override, a running bg3
 * process (the bridge only matters while the game runs, so this is the
 * common case), the Steam registry + libraryfolders.vdf, then the default
 * install path. Cached for the process lifetime; `refresh` re-probes.
 */
let cachedGameDir: string | null | undefined;

export async function findGameDir(refresh = false): Promise<string | null> {
    if (!refresh && cachedGameDir !== undefined) return cachedGameDir;

    const override = process.env.BG3_GAME_DIR;
    if (override && existsSync(override)) {
        cachedGameDir = override;
        return cachedGameDir;
    }

    try {
        const { stdout } = await execFileAsync(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                '(Get-Process bg3_dx11, bg3 -ErrorAction SilentlyContinue | ' +
                    'Select-Object -First 1 -ExpandProperty Path)',
            ],
            { timeout: PROCESS_QUERY_TIMEOUT_MS },
        );
        const exePath = stdout.trim();
        if (exePath !== '') {
            // …\bin\bg3_dx11.exe → game root
            const gameDir = path.dirname(path.dirname(exePath));
            if (existsSync(path.join(gameDir, 'Data'))) {
                cachedGameDir = gameDir;
                return cachedGameDir;
            }
        }
    } catch {
        // Game not running or PowerShell unavailable: fall through.
    }

    try {
        const { stdout } = await execFileAsync(
            'reg',
            ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
            { timeout: PROCESS_QUERY_TIMEOUT_MS },
        );
        const steamMatch = /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout);
        if (steamMatch !== null) {
            const steamRoot = (steamMatch[1] ?? '').trim();
            const libraries = [steamRoot];
            try {
                const vdf = await readFile(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
                for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
                    libraries.push((match[1] ?? '').replace(/\\\\/g, '\\'));
                }
            } catch {
                // Only the root library then.
            }
            for (const library of libraries) {
                const candidate = path.join(library, 'steamapps', 'common', 'Baldurs Gate 3');
                if (existsSync(candidate)) {
                    cachedGameDir = candidate;
                    return cachedGameDir;
                }
            }
        }
    } catch {
        // reg missing or unreadable: fall through.
    }

    const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    for (const candidate of [
        path.join(programFiles, 'Steam', 'steamapps', 'common', 'Baldurs Gate 3'),
        'C:\\Program Files (x86)\\GOG Galaxy\\Games\\Baldurs Gate 3',
    ]) {
        if (existsSync(candidate)) {
            cachedGameDir = candidate;
            return cachedGameDir;
        }
    }

    cachedGameDir = null;
    return cachedGameDir;
}

const levelCache = new Map<string, LevelScan>();


/** Enumerate every level the install carries, from Data/Editor/Mods/<Module>/Levels/. */
export async function listLevels(gameDir: string, refresh = false): Promise<LevelScan> {
    if (!refresh) {
        const cached = levelCache.get(gameDir);
        if (cached !== undefined) return cached;
    }

    const dataDir = path.join(gameDir, 'Data');
    const editorMods = path.join(dataDir, 'Editor', 'Mods');
    const levels: LevelEntry[] = [];
    const errors: string[] = [];
    let modulesScanned = 0;

    if (!existsSync(editorMods)) {
        return {
            gameDir,
            dataDir,
            levels,
            modulesScanned: 0,
            errors: [
                `no Editor data at ${editorMods} — the install does not ship loose levels; ` +
                    'bg3_teleport still works but validates nothing, and Osi.GetRegion stays the reliable "where am I"',
            ],
        };
    }

    try {
        for (const module of await readdir(editorMods, { withFileTypes: true })) {
            if (!module.isDirectory()) continue;
            const levelsDir = path.join(editorMods, module.name, 'Levels');
            if (!existsSync(levelsDir)) continue;
            modulesScanned += 1;
            for (const level of await readdir(levelsDir, { withFileTypes: true })) {
                if (level.isDirectory()) {
                    levels.push({ level: level.name, module: module.name });
                }
            }
        }
    } catch (error) {
        errors.push(`loose scan failed: ${(error as Error).message}`);
    }

    levels.sort((a, b) => a.module.localeCompare(b.module) || a.level.localeCompare(b.level));
    const scan: LevelScan = { gameDir, dataDir, levels, modulesScanned, errors };
    levelCache.set(gameDir, scan);
    return scan;
}
