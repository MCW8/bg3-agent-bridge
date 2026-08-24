# Changelog

Notable changes to the bridge, newest first. Earlier history is in the git log; tracking starts with the first public release.

## [0.2.0] — Unreleased

First public release. Versions below the entries are commit dates, not separate releases.

### Added — 2026-08-24

- `bg3_resolve_character` — resolves any character reference (bare UUID, prefixed template-name form, or display name) to a stable identity: bare uuid, prefixed form, display name, whether it is the player-created Tav (`AvatarComponent`, stable across control hand-offs and death), whether it is host-controlled now, HP, and dead/downed state. `action=party` lists the party the same way; `action=host` resolves the control-holder. Addresses the identity minefield where `GetHostCharacter()` returns a bare UUID and follows control while Osiris events deliver prefixed forms that fail bare-string equality.
- `bg3_life` — damage/heal/setHp/fullHeal/kill/down/resurrect for a character, reporting before/after HP and dead/downed state after a settle window, plus the `method` used and a faithfulness `caveat`. HP is set via `Osi.SetHitpoints` (verified present against the live game), falling back to a `HealthComponent.Hp` write + replicate when unavailable; the settle read surfaces an ineffective queued call as `after != target` rather than a false success. Setting HP is still not a damage/attack event, so combat and death triggers can differ from a real hit (a raw write to 0 can leave a "limbo death" inside a suppressed a scene-manager mod scene); `down` applies DOWNED, `resurrect` uses `Osi.Resurrect` when present. Backs the death/downing testing the field notes call out.
- `bg3_osiris_functions` — `action=list` enumerates the live `Osi` table (`pairs(Osi)`, ~1303 names on SE v32) filtered by substring; `action=probe` calls specific names with zero arguments inside pcall and classifies SE's error text to report existence without triggering mutating calls. Confirms existence, not arity.
- `bg3_vfs_probe` — reads a path through the game VFS (`Ext.IO.LoadFile`) and reports the byte length served, the decisive test for whether the live copy is the pak or a loose file when both exist.

### Changed — 2026-08-24

- `bg3_reload` now waits for the reload to complete by default and confirms it without depending on Script Extender logging: it records the handshake file's timestamp, triggers the reset, waits for `Bridge.Start` to rewrite that handshake (the definitive "VM rebooted" signal), then pings the fresh VM and returns `{reloaded, rebooted, responsive, durationMs, capabilities}`. A Lua syntax error in a reloaded script stops `Bridge.Start`, so the handshake never advances and it correctly reports `reloaded:false`. `wait=false` restores fire-and-forget. (Replaces the initial log-marker approach, which reported false negatives when runtime file-logging was disabled.)

### Added — 2026-08-12

- `bg3_trace_events` — captures the ordered Osiris story-event stream (`>>> event Name(args)` lines) from the Osiris Runtime log: `start` marks a position, `read` returns events since, filtered by an event-name regex and/or an entity substring (a bare UUID matches its prefixed template-name form in event arguments). Log lines carry no timestamps, so the stream is ordered but not timed.
- `bg3_schema` — component/resource field introspection read from live instances: `action=components` lists an entity's components as the union of `GetAllComponents()` and `GetAllComponentNames()` with an `accessible` flag per row (the two listings disagree, and a listed name is no guarantee property access works — `e.StatusManager` raises where `e.StatusContainer` succeeds); `action=fields` dumps a component's field names, value types and scalar previews; `action=resource` samples a resource bank the same way (loaded entries only).
- `bg3_eval` — captures `print`/`Ext.Utils.Print` output emitted during the call (and during timers it scheduled, up to a `captureMs` window) and returns it as `prints`; `modContext` runs the chunk with another mod's `PersistentVars`/`ModuleUUID` swapped in; `pollUntil` re-evaluates a Lua predicate until truthy or `timeoutMs` and reports the outcome as `polled`. Deferred replies ride a new asynchronous path in the mailbox protocol (`Bridge.DEFERRED`/`Bridge.Respond`), backward-compatible with synchronous handlers.
- `bg3_read_log` — `logType` (`extender`/`osiris`) picks the channel by filename prefix instead of substring guesswork, `head` reads from the top, and `cursor` follow mode returns only lines appended since the previous call, flagging log rotation instead of silently resuming.
- `bg3_list_logs` — groups files into game sessions (each launch writes an Extender and an Osiris log seconds apart) and defaults to the newest 10.

### Fixed — 2026-08-12

- `bg3_spawn_character` with a template but no explicit `action` no longer lists instead of spawning: `action` now defaults to `spawn` when `template` is given, `list` otherwise. Previously a template-only call returned `{count: 0, spawned: []}` with nothing spawned and no error.

### Added — 2026-08-08

- `bg3_animation` — auditions animations on a character (`find`/`play`/`loop`), swaps the whole locomotion set (`animset`), and overrides the idle via a live-edited `StillAnimationType` on a clean carrier status, all restored by `clear`. `animset` writes a status `DynamicAnimationTag` pointing at an `AnimationSetPriority` entry (reusing a clean existing carrier when one carries the tag), replacing idle, walk and run with free movement — the mechanism animation-replacement mods use, mapped from the On All Fours Toggle mod (toggleable passive → hidden status → animation-set tag). Other probed facts: `PlayAnimation` wants the bare AnimationShortName GUID (the `GUID(name)` display form is a silent no-op); `PlayLoopingAnimation`'s true signature is 8 arguments with the animation in position 3 (arities 2-6 all fail), looping animations continuously and holding statue poses, ended by `Osi.StopAnimation(character, 1)` — the channel number, not a name (the bogus-name cancel in the Emotes mod is only a pose interrupt); looping signature credit: Emotes mod (claravel). The status `AnimationLoop` field is ignored on BOOST statuses, and pak path-shadowing a base idle GR2 does not override it (tested), so single-animation idle replacement is limited to the still-animation enum. Resolves each animation's natural length from the Animation bank where the GR2 path carries the short name.
- `bg3_spawn_character` — spawns an NPC from a character template UUID beside the host character (or a `near` anchor, or exact `x`/`y`/`z`), tracks what it spawned, and removes them with `despawn`/`clear`. Wraps the `Osi.CreateAt` arity trap (exactly 7 arguments, fifth is `temporary`, and overload errors never say so).
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
