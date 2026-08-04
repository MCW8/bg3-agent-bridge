import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Folder name of the companion mod; also the mailbox subdirectory name. */
export const MOD_FOLDER = 'BG3AgentBridge';

const LARIAN_SUBPATH = path.join('Larian Studios', "Baldur's Gate 3");

function localAppData(): string {
    return process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
}

/**
 * Root of the Script Extender data directory. This is where Ext.IO.SaveFile
 * resolves unqualified paths, so it is the shared ground between the two
 * halves of the bridge.
 */
export function scriptExtenderDir(): string {
    const override = process.env.BG3_SE_DIR;
    if (override) return override;
    return path.join(localAppData(), LARIAN_SUBPATH, 'Script Extender');
}

/** Directory the companion mod reads requests from and writes responses to. */
export function bridgeDir(): string {
    return path.join(scriptExtenderDir(), MOD_FOLDER);
}

export interface MailboxPaths {
    request: string;
    response: string;
    hello: string;
}

export function mailboxPaths(context: 'server' | 'client'): MailboxPaths {
    const dir = bridgeDir();
    return {
        request: path.join(dir, `request_${context}.json`),
        response: path.join(dir, `response_${context}.json`),
        hello: path.join(dir, `hello_${context}.json`),
    };
}

/**
 * Candidate log directories, newest-wins when searched. Script Extender has
 * used more than one name across versions and Osiris logs land somewhere else
 * again, so all of them are probed rather than assuming one layout.
 */
export function logDirectories(): string[] {
    const override = process.env.BG3_LOG_DIR;
    if (override) return [override];

    const larianLocal = path.join(localAppData(), LARIAN_SUBPATH);
    const documents = path.join(homedir(), 'Documents');

    return [
        path.join(larianLocal, 'Script Extender Logs'),
        path.join(larianLocal, 'Extender Logs'),
        path.join(documents, 'OsirisLogs'),
    ].filter((dir) => existsSync(dir));
}

/**
 * Where unpacked mods live. Used by the installer to place the companion mod
 * without repacking it.
 */
export function modsDir(): string {
    const override = process.env.BG3_MODS_DIR;
    if (override) return override;
    return path.join(localAppData(), LARIAN_SUBPATH, 'Mods');
}
