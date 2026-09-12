import { mkdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { bridgeDir } from './paths.js';
import { extractFile, searchVfs } from './vfs.js';

/**
 * Reverse lookup over the game's localization: text → handle.
 *
 * Ext.Loca only resolves handle → text, and its GetAllTranslatedStringKeys
 * returns keyed strings (<guid>_DisplayName), NOT the ~232k voiced-line
 * handles — a distinction that cost an asset-mining session real time. The
 * .loca binary itself carries both, so it is extracted once (from
 * Localization/English.pak) and parsed here, outside the game: no 8s context
 * timeout, no payload ceiling, and it works with the game closed.
 *
 * Format (verified against the shipped file, 232,878 entries):
 *   header : "LOCA" magic, u32 entryCount, u32 textsOffset
 *   entries: entryCount × 70 bytes — char[64] key, u16 version, u32 length
 *   texts  : at textsOffset, entryCount null-terminated strings in entry order
 */

export interface LocaEntry {
    handle: string;
    text: string;
}

export interface LocaIndex {
    file: string;
    entries: LocaEntry[];
    byHandle: Map<string, string>;
}

const ENTRY_BYTES = 70;
const KEY_BYTES = 64;

function parseLoca(buffer: Buffer): LocaEntry[] {
    if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'LOCA') {
        throw new Error('not a LOCA file (missing magic)');
    }
    const entryCount = buffer.readUInt32LE(4);
    const textsOffset = buffer.readUInt32LE(8);

    const entries: LocaEntry[] = [];
    let textCursor = textsOffset;
    for (let i = 0; i < entryCount; i += 1) {
        const base = 12 + i * ENTRY_BYTES;
        if (base + ENTRY_BYTES > buffer.length) break;

        const rawKey = buffer.toString('latin1', base, base + KEY_BYTES);
        const handle = rawKey.replace(/\0+$/, '');
        const length = buffer.readUInt32LE(base + KEY_BYTES + 2);

        // Texts are consecutive and length includes the terminating null.
        const end = Math.min(textCursor + Math.max(0, length - 1), buffer.length);
        entries.push({ handle, text: buffer.toString('utf8', textCursor, end) });
        textCursor += length;
    }
    return entries;
}

let cached: LocaIndex | undefined;

/**
 * Extract (once) and parse the English localization. The extracted copy lives
 * beside the mailbox so repeat runs skip divine entirely.
 */
export async function loadLocalization(options: {
    dataDir: string;
    modsDir: string;
    language?: string;
    refresh?: boolean;
}): Promise<LocaIndex> {
    if (cached !== undefined && options.refresh !== true) return cached;

    const language = options.language ?? 'English';
    const cacheDir = path.join(bridgeDir(), 'loca-cache');
    const localCopy = path.join(cacheDir, `${language.toLowerCase()}.loca`);
    await mkdir(cacheDir, { recursive: true });

    if (!existsSync(localCopy) || options.refresh === true) {
        const wanted = `Localization/${language}/${language.toLowerCase()}.loca`;
        const found = await searchVfs({
            query: wanted,
            regex: false,
            limit: 5,
            dataDir: options.dataDir,
            modsDir: options.modsDir,
            include: 'paks',
            refresh: false,
        });
        const exact = found.entries.find((entry) => entry.path.toLowerCase() === wanted.toLowerCase());
        if (exact === undefined) {
            throw new Error(
                `could not locate ${wanted} in any pak — is the ${language} localization installed? ` +
                    'bg3_vfs_list with query=".loca" shows what is there.',
            );
        }
        await extractFile(exact.path, localCopy, { dataDir: options.dataDir, modsDir: options.modsDir });
    }

    const buffer = await readFile(localCopy);
    const entries = parseLoca(buffer);
    const byHandle = new Map<string, string>();
    for (const entry of entries) byHandle.set(entry.handle.toLowerCase(), entry.text);

    cached = { file: localCopy, entries, byHandle };
    return cached;
}

export interface LocaSearchResult {
    matched: number;
    returned: number;
    totalEntries: number;
    source: string;
    matches: LocaEntry[];
}

export async function searchLocalization(options: {
    query: string;
    regex: boolean;
    limit: number;
    dataDir: string;
    modsDir: string;
    language?: string;
    refresh?: boolean;
}): Promise<LocaSearchResult> {
    const index = await loadLocalization(options);
    const matches: LocaEntry[] = [];
    let matched = 0;

    // A handle lookup is the common inverse case; answer it directly.
    const direct = index.byHandle.get(options.query.toLowerCase());
    if (direct !== undefined) {
        matched += 1;
        matches.push({ handle: options.query, text: direct });
    }

    const matcher = options.regex
        ? new RegExp(options.query, 'i')
        : { test: (value: string) => value.toLowerCase().includes(options.query.toLowerCase()) };

    for (const entry of index.entries) {
        if (!matcher.test(entry.text)) continue;
        matched += 1;
        if (matches.length < options.limit) matches.push(entry);
    }

    return {
        matched,
        returned: matches.length,
        totalEntries: index.entries.length,
        source: index.file,
        matches,
    };
}

/** Size of the extracted copy, for status reporting. */
export async function localizationCacheBytes(language = 'English'): Promise<number | null> {
    const file = path.join(bridgeDir(), 'loca-cache', `${language.toLowerCase()}.loca`);
    if (!existsSync(file)) return null;
    return (await stat(file)).size;
}
