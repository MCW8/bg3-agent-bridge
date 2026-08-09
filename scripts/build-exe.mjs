#!/usr/bin/env node
/**
 * Builds dist/bg3-bridge.exe: the MCP server plus install/configure/check/pack
 * subcommands as one Bun-compiled binary, so modders never install Node.
 *
 * Bun is a build-time-only tool. It is not vendored (tools/ is gitignored) and
 * not needed by anyone who only downloads the release zip.
 *
 * Usage:  npm run build:exe
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bun = path.join(root, 'tools', 'bun.exe');

if (!existsSync(bun)) {
    console.error(
        '\n  tools/bun.exe not found. Download bun-windows-x64.zip from\n' +
            '  https://github.com/oven-sh/bun/releases and drop bun.exe into tools/.\n',
    );
    process.exit(1);
}

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

mkdirSync(path.join(root, 'dist'), { recursive: true });

// --define bakes the package version into the binary: under Node the server
// reads package.json from disk, but no package.json sits next to the exe.
const result = spawnSync(
    bun,
    [
        'build',
        '--compile',
        '--minify',
        '--target=bun-windows-x64',
        '--define',
        `BG3_BUILD_VERSION:"${version}"`,
        path.join(root, 'src', 'cli', 'main.ts'),
        '--outfile',
        path.join(root, 'dist', 'bg3-bridge.exe'),
    ],
    { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
