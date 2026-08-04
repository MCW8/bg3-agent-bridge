import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { logDirectories } from './paths.js';

/** Cap on how much of a log file is read from the end, to stay cheap on long sessions. */
const TAIL_BYTES = 512 * 1024;

export interface LogFile {
    file: string;
    modifiedMs: number;
}

/** Every log file across all known directories, newest first. */
export async function listLogFiles(): Promise<LogFile[]> {
    const found: LogFile[] = [];

    for (const dir of logDirectories()) {
        let entries: string[];
        try {
            entries = await readdir(dir);
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!/\.(log|txt)$/i.test(entry)) continue;
            const file = path.join(dir, entry);
            try {
                const info = await stat(file);
                if (info.isFile()) {
                    found.push({ file, modifiedMs: info.mtimeMs });
                }
            } catch {
                // Raced with a rotation; skip it.
            }
        }
    }

    return found.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/** Read the trailing slice of a file without pulling the whole thing into memory. */
async function readTail(file: string): Promise<string> {
    const handle = await open(file, 'r');
    try {
        const { size } = await handle.stat();
        const length = Math.min(size, TAIL_BYTES);
        const start = size - length;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return buffer.toString('utf8');
    } finally {
        await handle.close();
    }
}

export interface TailOptions {
    lines?: number;
    filter?: string;
    file?: string;
}

export interface TailResult {
    file: string | null;
    matched: number;
    lines: string[];
}

/**
 * Tail the newest log, or a named one. `filter` is a regular expression, which
 * is the practical way to pull one mod's output out of a shared log.
 */
export async function tailLog(options: TailOptions = {}): Promise<TailResult> {
    const lineLimit = options.lines ?? 100;

    let target = options.file;
    if (target === undefined) {
        const candidates = await listLogFiles();
        target = candidates[0]?.file;
    }

    if (target === undefined) {
        return { file: null, matched: 0, lines: [] };
    }

    const contents = await readTail(target);
    let lines = contents.split(/\r?\n/);

    // A truncated read almost always clips the first line mid-way.
    if (lines.length > 1) lines = lines.slice(1);

    if (options.filter !== undefined && options.filter !== '') {
        let pattern: RegExp;
        try {
            pattern = new RegExp(options.filter, 'i');
        } catch (error) {
            throw new Error(`filter is not a valid regular expression: ${(error as Error).message}`);
        }
        lines = lines.filter((line) => pattern.test(line));
    }

    lines = lines.filter((line) => line.trim() !== '');
    const matched = lines.length;

    return { file: target, matched, lines: lines.slice(-lineLimit) };
}
