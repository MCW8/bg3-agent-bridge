import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when running inside the compiled single-file executable (Bun
 * --compile): modules live in a virtual filesystem ($bunfs / ~BUN paths), and
 * the real artifacts — the mod/ folder and the exe itself — sit next to
 * process.execPath.
 */
export function isCompiledExe(): boolean {
    // Bun serves bundled modules from a virtual fs: $bunfs on POSIX, and on
    // Windows ~BUN — URL-encoded as %7EBUN in import.meta.url.
    const url = import.meta.url.toLowerCase();
    return url.includes('$bunfs') || url.includes('%7ebun') || url.includes('~bun');
}

/**
 * Root that mod/ and dist/ are relative to: the repo (or extracted release
 * zip) under Node, the folder containing the exe in compiled mode.
 */
export function packageRoot(): string {
    if (isCompiledExe()) return path.dirname(process.execPath);
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The mcpServers entry that connects an agent to this install. Compiled mode
 * is the whole point of the exe: a single command, no node, no args.
 */
export function mcpServerEntry(): { command: string; args?: string[] } {
    if (isCompiledExe()) {
        return { command: process.execPath.replace(/\\/g, '/') };
    }
    return { command: 'node', args: [path.join(packageRoot(), 'dist', 'index.js').replace(/\\/g, '/')] };
}

/**
 * How the user invokes a subcommand in the current mode, for help text:
 * "bg3-bridge install" from the exe, "node scripts/install-dev.mjs" under Node.
 */
export function invocation(sub: 'install' | 'configure' | 'check' | 'pack'): string {
    if (isCompiledExe()) return `bg3-bridge ${sub}`;
    const script = { install: 'install-dev', configure: 'configure-agent', check: 'check-bridge', pack: null }[sub];
    if (script === null) return 'npm run install-mod';
    return `node scripts/${script}.mjs`;
}

/**
 * Direct-run guard shared by every CLI module: true when the file was executed
 * itself (node dist/cli/x.js) rather than imported by the exe dispatcher or a
 * scripts/*.mjs wrapper. Case-insensitive because Windows argv casing varies.
 */
export function ranDirectly(moduleUrl: string): boolean {
    // Inside the compiled exe every module's import.meta.url IS the exe's own
    // URL, so the comparison below would be true for all of them and each
    // would auto-run on import. The dispatcher is the only entry there.
    if (isCompiledExe()) return false;
    const invokedAs = process.argv[1];
    if (invokedAs === undefined) return false;
    return path.resolve(invokedAs).toLowerCase() === fileURLToPath(moduleUrl).toLowerCase();
}
