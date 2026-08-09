#!/usr/bin/env node
/**
 * Builds the release zip a modder downloads: bg3-bridge.exe plus the files
 * that must sit next to it.
 *
 *   bg3-agent-bridge-vX.Y.Z.zip
 *   ├── bg3-bridge.exe    MCP server + install/configure/check/pack
 *   ├── mod/              companion mod source (install copies it loose)
 *   ├── README.md
 *   └── LICENSE
 *
 * The exe looks for mod/ relative to itself, so the zip layout is not
 * cosmetic — flattening it breaks `bg3-bridge install`.
 *
 * Zipped with the tar.exe that ships with Windows 10+ (bsdtar; -a picks the
 * format from the extension), so there is nothing to install here either.
 *
 * Usage:  npm run release
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: root });
    if (result.error !== undefined) {
        console.error(`\n  Failed to run ${command}: ${result.error.message}\n`);
        process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. The exe (build-exe.mjs checks for tools/bun.exe and says what to do).
run(process.execPath, [path.join(root, 'scripts', 'build-exe.mjs')]);

// 2. Stage the exact zip layout.
const staging = path.join(root, 'dist', 'release-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

copyFileSync(path.join(root, 'dist', 'bg3-bridge.exe'), path.join(staging, 'bg3-bridge.exe'));
cpSync(path.join(root, 'mod'), path.join(staging, 'mod'), { recursive: true });
copyFileSync(path.join(root, 'README.md'), path.join(staging, 'README.md'));
copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));

// 3. Zip it. Zip targets live directly in dist/, next to the exe.
const zip = path.join(root, 'dist', `bg3-agent-bridge-v${version}.zip`);
rmSync(zip, { force: true });
run('tar', ['-a', '-c', '-f', zip, '-C', staging, '.']);

if (!existsSync(zip)) {
    console.error(`\n  tar reported success but ${zip} is missing.\n`);
    process.exit(1);
}

rmSync(staging, { recursive: true, force: true });

const mb = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`\n  ${zip}  (${mb} MB)`);
console.log('  Upload this to the GitHub release — the README points modders at it.\n');
