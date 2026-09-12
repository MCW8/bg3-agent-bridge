import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { findDivine, runDivine } from './divine.js';
import { bridgeDir } from './paths.js';

/**
 * Filesystem enumeration for the game's data — the single biggest gap an
 * asset-mining session hit: there is NO way to list a directory from inside
 * the game (Ext.IO exposes SaveFile/LoadFile/GetPathOverride/AddPathOverride
 * and nothing else, probed), so every path had to be guessed.
 *
 * Answered outside the game instead. Each pak is listed once with divine
 * (~1.5s for the largest) into a cache file keyed by name/size/mtime; loose
 * files under Data/ are walked into their own cache. Both survive process
 * restarts, so only the first query pays. Works with the game closed.
 *
 * Paks live in two places that matter and one that is easy to miss: the Data/
 * root, the user's Mods/ folder, and Data/<subdir>/ — Localization/ holds
 * English.pak, Voice.pak and VoiceMeta.pak, which is exactly where voice and
 * localization mining has to look.
 */

export interface VfsEntry {
    path: string;
    size: number;
    /** "loose" or the pak file name that carries it. */
    source: string;
}

export interface VfsSearchResult {
    matched: number;
    returned: number;
    entries: VfsEntry[];
    indexedPaks: number;
    builtIndexes: number;
    looseFiles: number;
    elapsedMs: number;
    errors: string[];
}

export interface VfsSearchOptions {
    query: string;
    regex: boolean;
    limit: number;
    dataDir: string;
    modsDir: string;
    /** Restrict to paks whose file name contains this, e.g. "Voice" or "Gustav". */
    pak?: string;
    /** Skip loose files, or skip paks, when only one side is interesting. */
    include?: 'all' | 'paks' | 'loose';
    refresh: boolean;
}

/** Loose files change whenever a mod is installed; a day is a sane staleness bound. */
const LOOSE_TTL_MS = 24 * 60 * 60 * 1000;

function indexDir(): string {
    return path.join(bridgeDir(), 'vfs-index');
}

/** Every pak the game can load: Data/, one level of Data subdirectories, and the user's Mods/. */
async function packageFiles(dataDir: string, modsDir: string, errors: string[]): Promise<string[]> {
    const paks: string[] = [];
    const roots = [dataDir, modsDir];

    try {
        for (const entry of await readdir(dataDir, { withFileTypes: true })) {
            if (entry.isDirectory()) roots.push(path.join(dataDir, entry.name));
        }
    } catch (error) {
        errors.push(`cannot list ${dataDir}: ${(error as Error).message}`);
    }

    for (const dir of roots) {
        if (!existsSync(dir)) continue;
        try {
            for (const entry of await readdir(dir)) {
                if (entry.toLowerCase().endsWith('.pak')) paks.push(path.join(dir, entry));
            }
        } catch (error) {
            errors.push(`cannot list ${dir}: ${(error as Error).message}`);
        }
    }
    return paks;
}

async function ensurePakIndex(pakPath: string): Promise<{ cacheFile: string; built: boolean } | null> {
    const info = await stat(pakPath);
    const key = `${path.basename(pakPath)}.${info.size}.${Math.floor(info.mtimeMs)}.idx`;
    const cacheFile = path.join(indexDir(), key);
    if (existsSync(cacheFile)) return { cacheFile, built: false };

    const result = runDivine(['-g', 'bg3', '-a', 'list-package', '-s', pakPath]);
    if (!result.ok) return null;

    await mkdir(indexDir(), { recursive: true });
    await writeFile(cacheFile, result.stdout, 'utf8');
    return { cacheFile, built: true };
}

async function walkLoose(root: string, prefix: string, out: string[], limit: number): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (out.length >= limit) return;
        const child = path.join(root, entry.name);
        const vfsPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
            await walkLoose(child, vfsPath, out, limit);
            continue;
        }
        try {
            out.push(`${vfsPath}\t${(await stat(child)).size}`);
        } catch {
            // Vanished between readdir and stat; skip.
        }
    }
}

/** Loose index, cached to disk: the walk is ~128k stat calls on a modded install. */
async function ensureLooseIndex(dataDir: string, refresh: boolean): Promise<{ lines: string[]; built: boolean }> {
    const cacheFile = path.join(indexDir(), 'loose.idx');
    if (!refresh && existsSync(cacheFile)) {
        const info = await stat(cacheFile);
        if (Date.now() - info.mtimeMs < LOOSE_TTL_MS) {
            const text = await readFile(cacheFile, 'utf8');
            return { lines: text.split(/\r?\n/).filter((line) => line !== ''), built: false };
        }
    }

    const lines: string[] = [];
    for (const sub of ['Editor', 'Mods', 'Public', 'Localization', 'Generated', 'Scripts', 'Projects']) {
        const root = path.join(dataDir, sub);
        if (existsSync(root)) await walkLoose(root, sub, lines, 400_000);
    }
    await mkdir(indexDir(), { recursive: true });
    await writeFile(cacheFile, lines.join('\n'), 'utf8');
    return { lines, built: true };
}

export async function searchVfs(options: VfsSearchOptions): Promise<VfsSearchResult> {
    const started = Date.now();
    const errors: string[] = [];
    const entries: VfsEntry[] = [];
    const include = options.include ?? 'all';
    let matched = 0;
    let builtIndexes = 0;

    const matcher = options.regex
        ? new RegExp(options.query, 'i')
        : { test: (value: string) => value.toLowerCase().includes(options.query.toLowerCase()) };

    let looseFiles = 0;
    if (include !== 'paks') {
        const loose = await ensureLooseIndex(options.dataDir, options.refresh);
        if (loose.built) builtIndexes += 1;
        looseFiles = loose.lines.length;
        for (const line of loose.lines) {
            const tab = line.lastIndexOf('\t');
            const entryPath = tab === -1 ? line : line.slice(0, tab);
            if (!matcher.test(entryPath)) continue;
            matched += 1;
            if (entries.length >= options.limit) continue;
            const size = tab === -1 ? 0 : Number.parseInt(line.slice(tab + 1), 10);
            entries.push({ path: entryPath, size: Number.isFinite(size) ? size : 0, source: 'loose' });
        }
    }

    let indexedPaks = 0;
    if (include !== 'loose') {
        for (const pakPath of await packageFiles(options.dataDir, options.modsDir, errors)) {
            const name = path.basename(pakPath);
            if (options.pak !== undefined && options.pak !== '' && !name.toLowerCase().includes(options.pak.toLowerCase())) {
                continue;
            }
            let index;
            try {
                index = await ensurePakIndex(pakPath);
            } catch (error) {
                errors.push(`${name}: ${(error as Error).message}`);
                continue;
            }
            if (index === null) {
                errors.push(`${name}: divine could not list it`);
                continue;
            }
            indexedPaks += 1;
            if (index.built) builtIndexes += 1;

            // Index lines are "path\tsize\t…"; match on the path column.
            const text = await readFile(index.cacheFile, 'utf8');
            for (const line of text.split(/\r?\n/)) {
                if (line === '') continue;
                const tab = line.indexOf('\t');
                const entryPath = tab === -1 ? line : line.slice(0, tab);
                if (!matcher.test(entryPath)) continue;
                matched += 1;
                if (entries.length >= options.limit) continue;
                const size = tab === -1 ? 0 : Number.parseInt(line.slice(tab + 1), 10);
                entries.push({ path: entryPath, size: Number.isFinite(size) ? size : 0, source: name });
            }
        }
    }

    return {
        matched,
        returned: entries.length,
        entries,
        indexedPaks,
        builtIndexes,
        looseFiles,
        elapsedMs: Date.now() - started,
        errors,
    };
}

/**
 * Copy a file out of the game data to `destination`. Loose wins, matching how
 * the game resolves a path; otherwise the pak that carries it is extracted
 * with divine. Returns what served the file.
 */
export async function extractFile(
    vfsPath: string,
    destination: string,
    options: { dataDir: string; modsDir: string },
): Promise<{ source: string; bytes: number }> {
    const loosePath = path.join(options.dataDir, vfsPath.replace(/\//g, path.sep));
    await mkdir(path.dirname(destination), { recursive: true });

    if (existsSync(loosePath)) {
        await writeFile(destination, await readFile(loosePath));
        return { source: 'loose', bytes: (await stat(destination)).size };
    }

    if (findDivine() === null) throw new Error('divine not found');

    const found = await searchVfs({
        query: vfsPath,
        regex: false,
        limit: 8,
        dataDir: options.dataDir,
        modsDir: options.modsDir,
        include: 'paks',
        refresh: false,
    });
    const hit = found.entries.find((entry) => entry.path.toLowerCase() === vfsPath.toLowerCase());
    if (hit === undefined) throw new Error(`no pak or loose file carries ${vfsPath}`);

    const roots = [options.dataDir, options.modsDir, ...(await readdir(options.dataDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(options.dataDir, entry.name))];
    const pakPath = roots.map((dir) => path.join(dir, hit.source)).find((candidate) => existsSync(candidate));
    if (pakPath === undefined) throw new Error(`indexed in ${hit.source} but that pak is gone`);

    const result = runDivine([
        '-g',
        'bg3',
        '-a',
        'extract-single-file',
        '-s',
        pakPath,
        '-f',
        hit.path,
        '-d',
        destination,
    ]);
    if (!result.ok || !existsSync(destination)) {
        throw new Error(`divine could not extract ${vfsPath} from ${hit.source}: ${result.stderr.trim()}`);
    }
    return { source: hit.source, bytes: (await stat(destination)).size };
}
