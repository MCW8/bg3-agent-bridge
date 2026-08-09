# Changelog

Notable changes to the bridge, newest first. Earlier history is in the git log; tracking starts with the first public release.

## [0.2.0] — Unreleased

First public release. Versions below the entries are commit dates, not separate releases.

### Added — 2026-08-08

- **Single-file exe distribution.** `bg3-bridge.exe` is the MCP server and every maintenance command (`install`, `configure`, `check`, `pack`); modders no longer install Node.js. MCP config shrinks to a single `command` with no args.
- `npm run build:exe` — Bun-compiled binary with the package version baked in via `--define`. Bun is build-time-only (`tools/bun.exe`, gitignored).
- `npm run release` — builds the exe and assembles `dist/bg3-agent-bridge-vX.Y.Z.zip` (exe + `mod/` + README + LICENSE) using the `tar.exe` that ships with Windows 10+.

### Changed — 2026-08-08

- CLI logic moved to `src/cli/`, shared by the exe dispatcher and the Node wrappers in `scripts/` — one implementation, both entry points. The Node flow (`node scripts/*.mjs`, `node dist/index.js`) still works unchanged for source users.
- README setup flow rewritten for the exe and condensed overall (~27% less prose): deduplicated the install/connect steps, fixed the release zip name (v0.1.0 → v0.2.0), tool count (14 → 18), and example count (two → three).

### Fixed — 2026-08-08

- Exe detection: Bun URL-encodes `~BUN` as `%7EBUN` in `import.meta.url`, so the first check never matched.
- Direct-run guards: inside a Bun-compiled exe every module's `import.meta.url` is the exe's own URL, which made each CLI module auto-run on import. Guards now return false in exe mode; the dispatcher is the only entry.
- Bridge error classes carry explicit `name`s; minification had mangled `constructor.name` into noise in diagnostics.

### Added — earlier in 0.2.0

- `bg3_find_stat` with display-name search by default, static data search, effect reverse lookup, status and item previews, fuzzy template search, sound capture and auditioning.
- Dev installer that works without a dev toolchain; generated MCP config block instead of hand-typed paths; client config writer with `--write`/`--path`.
- Examples: Starfall spell, Fancy Armor, Dancing Hold.
- Prominent security note: the bridge executes arbitrary Lua in the live game; uninstall when done.
- `RequiredVersion` set to the version actually developed against (SE applies old-version compatibility semantics to lower numbers).
