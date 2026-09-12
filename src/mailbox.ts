import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { bridgeDir, mailboxPaths } from './paths.js';

export type BridgeContext = 'server' | 'client';

export interface BridgeCapabilities {
    eval: boolean;
    entity: boolean;
    stats: boolean;
    reset: boolean;
    json: boolean;
}

export interface HelloInfo {
    context: BridgeContext;
    protocol: number;
    capabilities: BridgeCapabilities;
    resumedAtSeq?: number;
    pollIntervalTicks?: number;
}

interface RawResponse {
    seq?: number;
    ok?: boolean;
    context?: string;
    protocol?: number;
    result?: unknown;
    error?: string;
}

// Explicit names: minification mangles constructor.name, and these labels are
// shown to users diagnosing a dead bridge.
export class BridgeTimeoutError extends Error {
    override readonly name = 'BridgeTimeoutError';
}
export class BridgeCallError extends Error {
    override readonly name = 'BridgeCallError';
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_POLL_MS = 100;

/**
 * Sequence numbers must rise across process restarts, because the mod seeds
 * its cursor from whatever request file is already on disk. Wall-clock ms does
 * that; the counter only guarantees two calls in the same millisecond differ.
 */
let lastIssuedSeq = 0;
function nextSeq(): number {
    lastIssuedSeq = Math.max(Date.now(), lastIssuedSeq + 1);
    return lastIssuedSeq;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson<T>(file: string): Promise<T | null> {
    try {
        const raw = await readFile(file, 'utf8');
        if (raw.trim() === '') return null;
        return JSON.parse(raw) as T;
    } catch {
        // Missing file, or a torn read while the other side writes. Both are
        // ordinary polling states, not errors.
        return null;
    }
}

/**
 * Write via temp file plus rename so the mod can never parse a half-written
 * request. Node's rename overwrites an existing destination on Windows.
 */
async function writeAtomic(file: string, contents: string): Promise<void> {
    const temp = `${file}.tmp`;
    await writeFile(temp, contents, 'utf8');
    await rename(temp, file);
}

/** Handshake written by the mod at bootstrap. Null means the bridge is not running. */
export async function readHello(context: BridgeContext): Promise<HelloInfo | null> {
    return readJson<HelloInfo>(mailboxPaths(context).hello);
}

export interface CallOptions {
    timeoutMs?: number;
    pollMs?: number;
}

/**
 * Round-trip one operation through the mailbox. Resolves with the handler's
 * result, throws BridgeCallError if the handler raised, or BridgeTimeoutError
 * if the game never answered.
 */
export async function callBridge<T = unknown>(
    context: BridgeContext,
    op: string,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const paths = mailboxPaths(context);
    const seq = nextSeq();

    await mkdir(bridgeDir(), { recursive: true });
    await writeAtomic(paths.request, JSON.stringify({ seq, op, params }));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const response = await readJson<RawResponse>(paths.response);

        // Responses to earlier calls linger in the same file; only our own
        // sequence number ends the wait.
        if (response !== null && response.seq === seq) {
            if (response.ok === true) {
                return response.result as T;
            }
            throw new BridgeCallError(response.error ?? `bridge op '${op}' failed without a message`);
        }

        await sleep(pollMs);
    }

    // Three very different situations produce "no answer", and conflating them
    // sent a prior session chasing a timeout that was really a closed game.
    // Cheap to tell apart, and only on the failure path: is the process there,
    // and did the mod ever hand us a handshake?
    const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq bg3*.exe'], { encoding: 'utf8' });
    const gameRunning = running.status === 0 && /bg3/i.test(running.stdout);
    const booted = (await readJson<unknown>(paths.hello)) !== null;

    if (!gameRunning) {
        throw new BridgeTimeoutError(
            `Baldur's Gate 3 is not running, so the ${context} context cannot answer (waited ${timeoutMs}ms). ` +
                `Launch the game and load a save.`,
        );
    }
    if (!booted) {
        throw new BridgeTimeoutError(
            `The game is running but the ${context} context never booted the bridge (no handshake file after ${timeoutMs}ms). ` +
                `Check the mod is installed and enabled — bg3-bridge install — and that a save is loaded (the client context ` +
                `only answers after a save loads).`,
        );
    }
    throw new BridgeTimeoutError(
        `The ${context} context is up but did not answer within ${timeoutMs}ms. ` +
            `Heavy work (large scans, thousands of file probes) legitimately exceeds the default budget — raise timeoutMs, ` +
            `or split the work and cache state in eval globals between calls.`,
    );
}

/** True when the bridge answers a ping inside a short budget. */
export async function isAlive(context: BridgeContext, timeoutMs = 2000): Promise<boolean> {
    try {
        await callBridge(context, 'ping', {}, { timeoutMs });
        return true;
    } catch {
        return false;
    }
}
