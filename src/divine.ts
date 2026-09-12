import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Locating and driving divine.exe (the LSLib CLI).
 *
 * The bridge uses it for three things the game's Lua API cannot do: packing the
 * companion mod, ENUMERATING pak contents (Ext.IO exposes no directory
 * listing — probed), and extracting files out of paks without the game
 * running. Every caller degrades with instructions when divine is absent.
 *
 * Note the executable is `Divine.exe` in the LSLib release; Windows paths are
 * case-insensitive so either spelling resolves.
 */

/**
 * Places divine plausibly lives. LSLib ships as a zip with no installer, so
 * people extract it wherever they like — hence the spread of guesses, and why
 * BG3_DIVINE_PATH exists as the reliable answer.
 */
export function divineCandidates(): string[] {
    const roots = [
        'C:\\Program Files\\BG3 Modders Multitool',
        'C:\\Program Files (x86)\\BG3 Modders Multitool',
        'C:\\Program Files\\LSLib',
        'C:\\Program Files (x86)\\LSLib',
        'C:\\LSLib',
        'C:\\Divine',
        'C:\\Tools\\LSLib',
        'C:\\Modding\\BG3\\Tools',
        'D:\\BG3\\ExportTool',
        path.join(homedir(), 'Downloads', 'LSLib'),
        path.join(homedir(), 'Downloads', 'ExportTool'),
        path.join(homedir(), 'Documents', 'LSLib'),
        path.join(homedir(), 'LSLib'),
    ];

    const subdirs = ['', 'Tools', 'Packed', path.join('Tools', 'Packed')];
    const candidates: string[] = [];

    for (const root of roots) {
        for (const sub of subdirs) {
            candidates.push(path.join(root, sub, 'divine.exe'));
        }
    }
    return candidates;
}

let cachedDivine: string | null | undefined;

export function findDivine(): string | null {
    if (cachedDivine !== undefined) return cachedDivine;

    const configured = process.env.BG3_DIVINE_PATH;
    if (configured !== undefined && configured !== '') {
        cachedDivine = existsSync(configured) ? configured : null;
        return cachedDivine;
    }

    const onPath = spawnSync('where', ['divine.exe'], { encoding: 'utf8' });
    if (onPath.status === 0) {
        const first = onPath.stdout.split(/\r?\n/).find((line) => line.trim() !== '');
        if (first !== undefined) {
            cachedDivine = first.trim();
            return cachedDivine;
        }
    }

    cachedDivine = divineCandidates().find((candidate) => existsSync(candidate)) ?? null;
    return cachedDivine;
}

/** The message every divine-dependent tool shows when it cannot find one. */
export function divineMissingMessage(purpose: string): string {
    return (
        `Could not find divine.exe (the LSLib CLI), which ${purpose}.\n\n` +
        'Get LSLib and point the bridge at it:\n' +
        '  1. Download ExportTool-vX.Y.Z.zip from https://github.com/Norbyte/lslib/releases\n' +
        '  2. Extract it anywhere\n' +
        '  3. set BG3_DIVINE_PATH=C:\\path\\to\\Tools\\divine.exe\n\n' +
        'BG3 Modders Multitool bundles divine too — point BG3_DIVINE_PATH at its Tools folder. ' +
        `Searched PATH and: ${divineCandidates().slice(0, 6).join(', ')}, …`
    );
}

export interface DivineResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    status: number | null;
}

/** Run divine with a generous buffer — a pak listing is tens of megabytes of text. */
export function runDivine(args: string[], maxBufferMb = 256): DivineResult {
    const divine = findDivine();
    if (divine === null) return { ok: false, stdout: '', stderr: 'divine not found', status: null };

    const result = spawnSync(divine, args, {
        encoding: 'utf8',
        maxBuffer: maxBufferMb * 1024 * 1024,
    });
    return {
        ok: result.status === 0 && result.error === undefined,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error?.message ?? ''),
        status: result.status,
    };
}
