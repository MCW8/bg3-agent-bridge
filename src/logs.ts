import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { logDirectories } from './paths.js';

/** Cap on how much of a log file is read per call, to stay cheap on long sessions. */
const READ_CAP_BYTES = 512 * 1024;

/**
 * Script Extender writes one log per channel per game session, named
 * "<Channel> Runtime <YYYY-MM-DD> <HH-MM-SS>.log". The channel prefix is the
 * stable way to pick the log you mean: Lua output and script errors land in
 * Extender, story/rule traffic in Osiris.
 */
export type LogType = 'extender' | 'osiris';

const LOG_TYPE_PREFIX: Record<LogType, string> = {
    extender: 'extender',
    osiris: 'osiris',
};

/** Two logs started this close together belong to the same game session. */
const SESSION_WINDOW_MS = 120_000;

export interface LogFile {
    file: string;
    modifiedMs: number;
}

/** Which channel a log file belongs to, from its name; null when neither matches. */
export function logTypeOf(file: string): LogType | null {
    const name = path.basename(file).toLowerCase();
    if (name.startsWith(LOG_TYPE_PREFIX.extender)) return 'extender';
    if (name.startsWith(LOG_TYPE_PREFIX.osiris)) return 'osiris';
    return null;
}

/** Start timestamp parsed from the canonical log name, or null for free-form names. */
function startedMs(file: string): number | null {
    const match = /(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})\.log$/i.exec(path.basename(file));
    if (match === null) return null;
    const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`);
    return Number.isNaN(parsed) ? null : parsed;
}

/** Every log file across all known directories, newest first. */
export async function listLogFiles(limit?: number): Promise<LogFile[]> {
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

    found.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return limit === undefined ? found : found.slice(0, limit);
}

export interface LogSession {
    /** When the session's first log started; falls back to file mtime. */
    startedMs: number;
    files: { file: string; type: LogType | null; modifiedMs: number }[];
}

/**
 * Group log files into game sessions. Each launch writes an Extender and an
 * Osiris log whose start timestamps differ by a few seconds, so files within
 * SESSION_WINDOW_MS of a session's first file join it. Newest session first.
 */
export async function listLogSessions(limit: number): Promise<LogSession[]> {
    const files = await listLogFiles();

    const sessions: LogSession[] = [];
    for (const entry of files) {
        const started = startedMs(entry.file) ?? entry.modifiedMs;
        const session = sessions.find((candidate) => Math.abs(candidate.startedMs - started) <= SESSION_WINDOW_MS);
        const file = { file: entry.file, type: logTypeOf(entry.file), modifiedMs: entry.modifiedMs };
        if (session === undefined) {
            sessions.push({ startedMs: started, files: [file] });
        } else {
            session.files.push(file);
            session.startedMs = Math.min(session.startedMs, started);
        }
    }

    sessions.sort((a, b) => b.startedMs - a.startedMs);
    return sessions.slice(0, limit);
}

/** Read a slice of a file, clamped to READ_CAP_BYTES, returning where the slice ended. */
async function readSlice(file: string, startByte: number): Promise<{ text: string; endByte: number; size: number }> {
    const handle = await open(file, 'r');
    try {
        const { size } = await handle.stat();
        const start = Math.max(0, Math.min(startByte, size));
        const length = Math.min(size - start, READ_CAP_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return { text: buffer.toString('utf8'), endByte: start + length, size };
    } finally {
        await handle.close();
    }
}

export interface TailOptions {
    lines?: number;
    filter?: string;
    file?: string;
    namePattern?: string;
    /** Channel to read when no explicit file is given. Overrides namePattern when both are set. */
    logType?: LogType;
    /** Read from the start of the file instead of the end. */
    head?: boolean;
    /**
     * Byte offset returned by a previous call. Follow mode: return only lines
     * appended since then. If the file shrank (rotation/truncation), reading
     * restarts at the top and `truncated` comes back true.
     */
    cursor?: number;
}

export interface TailResult {
    file: string | null;
    matched: number;
    lines: string[];
    /** Byte offset to pass back as `cursor` on the next call to follow this file. */
    cursor?: number;
    /** True when a follow read found the file shorter than the cursor (rotated or truncated). */
    truncated?: boolean;
    /** True when the read hit READ_CAP_BYTES and earlier content was skipped. */
    capped?: boolean;
}

/**
 * Tail the newest log, or a named one. `filter` is a regular expression, which
 * is the practical way to pull one mod's output out of a shared log.
 */
export async function tailLog(options: TailOptions = {}): Promise<TailResult> {
    const lineLimit = options.lines ?? 100;

    let target = options.file;
    if (target === undefined) {
        let candidates = await listLogFiles();

        // Script Extender writes several logs concurrently. "Newest" is often an
        // Osiris runtime log while Lua output and script errors are in the
        // Extender runtime log, so callers need a way to say which they mean.
        // logType is the structured form; namePattern stays for odd file names.
        if (options.logType !== undefined) {
            const narrowed = candidates.filter((entry) => logTypeOf(entry.file) === options.logType);
            if (narrowed.length > 0) candidates = narrowed;
        } else if (options.namePattern !== undefined && options.namePattern !== '') {
            const wanted = options.namePattern.toLowerCase();
            const narrowed = candidates.filter((entry) => path.basename(entry.file).toLowerCase().includes(wanted));
            if (narrowed.length > 0) candidates = narrowed;
        }

        target = candidates[0]?.file;
    }

    if (target === undefined) {
        return { file: null, matched: 0, lines: [] };
    }

    let slice: { text: string; endByte: number; size: number };
    let truncated = false;
    if (options.cursor !== undefined) {
        slice = await readSlice(target, options.cursor);
        if (options.cursor > slice.size) {
            // The file shrank under the cursor — a rotation or truncation.
            // Silently resuming mid-file would lose lines without a trace.
            truncated = true;
            slice = await readSlice(target, 0);
        }
    } else if (options.head === true) {
        slice = await readSlice(target, 0);
    } else {
        const { size } = await stat(target);
        slice = await readSlice(target, Math.max(0, size - READ_CAP_BYTES));
    }

    let lines = slice.text.split(/\r?\n/);

    // A partial-line edge: tail reads clip the first line mid-way, head and
    // capped follow reads clip the last (the writer was mid-line at read time).
    const startedMidFile = options.cursor !== undefined && !truncated ? options.cursor > 0 : options.head !== true;
    if (startedMidFile && lines.length > 1) lines = lines.slice(1);
    const capped = slice.endByte < slice.size;
    if ((options.head === true || capped) && lines.length > 1) lines = lines.slice(0, -1);

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

    const kept = options.head === true ? lines.slice(0, lineLimit) : lines.slice(-lineLimit);

    return {
        file: target,
        matched,
        lines: kept,
        cursor: slice.endByte,
        ...(truncated ? { truncated } : {}),
        ...(capped ? { capped } : {}),
    };
}
