#!/usr/bin/env node
/**
 * Builds the release zip a modder downloads: bg3-bridge.exe plus the files
 * that must sit next to it.
 *
 *   bg3-agent-bridge-vX.Y.Z.zip
 *   ├── bg3-bridge.exe        MCP server + install/configure/check/pack
 *   ├── BG3AgentBridge.pak    the companion mod, packed (install copies it)
 *   ├── mod/                  companion mod source (dev / --loose installs)
 *   ├── ReferenceLua/         SE-generated API signatures (arity lookups)
 *   ├── README.md
 *   └── LICENSE
 *
 * The exe looks for mod/, BG3AgentBridge.pak and ReferenceLua/ relative to
 * itself, so the zip layout is not cosmetic — flattening it breaks
 * `bg3-bridge install`.
 *
 * Zipped with the tar.exe that ships with Windows 10+ (bsdtar; -a picks the
 * format from the extension), so there is nothing to install here either.
 *
 * Usage:  npm run release
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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

// 2. Build the companion mod's pak with the freshly built exe (`pack` needs
//    LSLib/Divine — set BG3_DIVINE_PATH, e.g. D:\BG3\ExportTool\Tools). The
//    pak ships in the zip next to the exe so end users never need divine.
//    The exe resolves mod/ relative to itself, so mirror the zip layout into
//    dist/ before invoking it.
cpSync(path.join(root, 'mod'), path.join(root, 'dist', 'mod'), { recursive: true });
const exe = path.join(root, 'dist', 'bg3-bridge.exe');
run(exe, ['pack', '--force']);
const pak = path.join(root, 'dist', 'BG3AgentBridge.pak');
if (!existsSync(pak)) {
    console.error('\n  divine reported success but BG3AgentBridge.pak is missing.\n');
    process.exit(1);
}

// 3. Stage the exact zip layout.
const staging = path.join(root, 'dist', 'release-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

copyFileSync(path.join(root, 'dist', 'bg3-bridge.exe'), path.join(staging, 'bg3-bridge.exe'));
copyFileSync(pak, path.join(staging, 'BG3AgentBridge.pak'));
cpSync(path.join(root, 'mod'), path.join(staging, 'mod'), { recursive: true });
// The Osiris reference signatures: bg3_osiris_functions action=signature reads
// them from here, so a release without them loses the arity lookups (it still
// degrades with instructions instead of failing).
if (existsSync(path.join(root, 'ReferenceLua'))) {
    cpSync(path.join(root, 'ReferenceLua'), path.join(staging, 'ReferenceLua'), { recursive: true });
}
copyFileSync(path.join(root, 'README.md'), path.join(staging, 'README.md'));
copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));

// 4. Zip it. Zip targets live directly in dist/, next to the exe. Entries are
// passed by name rather than as "." so members do not carry a ./ prefix.
const zip = path.join(root, 'dist', `bg3-agent-bridge-v${version}.zip`);
rmSync(zip, { force: true });
run('tar', ['-a', '-c', '-f', zip, '-C', staging, ...readdirSync(staging)]);

if (!existsSync(zip)) {
    console.error(`\n  tar reported success but ${zip} is missing.\n`);
    process.exit(1);
}

rmSync(staging, { recursive: true, force: true });

const mb = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`\n  ${zip}  (${mb} MB)`);
console.log('  Upload this to the GitHub release — the README points modders at it.\n');
