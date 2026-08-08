# BG3 Agent Bridge

An MCP server that gives an AI coding agent a **live feedback loop into a running Baldur's Gate 3 session**, through the [Script Extender](https://github.com/Norbyte/bg3se).

Editing BG3 mods with an agent today is blind: it writes Lua, you launch the game, you read the error, you paste it back. This closes that loop — the agent can reload scripts, inspect live entities, read stats, and tail the Script Extender log itself.

Why the Script Extender and not Larian's Toolkit? The Toolkit (`Glasses.exe`) has no plugin API, no headless mode, and no IPC. The Script Extender is where BG3 exposes live reflection.

**What this is not:**

- Not a replacement for [BG3 Modders Multitool](https://baldurs-gate-3.thunderstore.io/package/ShinyHobo/BG3_Modders_Multitool/), which unpacks, indexes, and searches game files. This is the runtime half, not the static-file half.
- Not a Toolkit automation layer.
- Not a source editor. Everything it changes is session-only; your agent already has file tools for the source.

## How it works

The Script Extender has **no networking** — SE mods cannot open sockets. It does have `Ext.IO.SaveFile` / `Ext.IO.LoadFile` and a per-tick event, so the transport is a file mailbox in the Script Extender data directory:

```
MCP server (Node)                       Companion mod (Lua, in-game)
       |                                             |
       |-- write request_server.json --------------->|  polled on Ext.Events.Tick
       |      {seq, op, params}                      |  dispatch -> pcall(handler)
       |<------------- write response_server.json ---|
       |               {seq, ok, result|error}       |
```

Writes are atomic (temp file plus rename), and a sequence cursor prevents replay after a VM reset. `server` and `client` contexts get separate mailboxes.

## Read this before installing

**This is a development tool, and it executes arbitrary Lua inside your game.**

That is the whole point — `bg3_eval` runs whatever it is given in the live session. But it means:

- The bridge reads commands from a **plain file in your Script Extender folder** — anything that can write there can run Lua in your game. There is no authentication; a file mailbox cannot have any.
- Lua under the Script Extender can read and write files, so this is not sandboxed to the game.
- Whatever agent you connect can do all of this without asking first.

Fine while you are actively modding — the only situation it is built for. Bad to leave installed and forgotten.

**Uninstall it when you are done:**

```bash
node scripts/install-dev.mjs --uninstall
```

Then remove the server from your agent's MCP config. `bg3_bridge_status` reports whether it is still live.

## Requirements

- Windows, Baldur's Gate 3, and the [Script Extender](https://github.com/Norbyte/bg3se) **v32 or newer**. SE updates itself by default; older versions simply refuse to load the mod (`RequiredVersion`).
- **[Node.js](https://nodejs.org/) 20 or newer** — the one hard prerequisite:

  ```bash
  winget install OpenJS.NodeJS.LTS
  ```

  `winget` ships with Windows 10 and 11; if it is missing, use the **LTS** installer from [nodejs.org](https://nodejs.org/). **Then open a new terminal** — installers only update `PATH` for windows opened afterwards. Verify with `node --version`; anything `v20+` is fine.

You do **not** need `divine.exe`, LSLib, or a mod manager to run the bridge. Those are only for building your own `.pak` later.

## Install

**1. Get the files.** Download `bg3-agent-bridge-v0.2.0.zip` from the [Releases page](https://github.com/MCW8/bg3-agent-bridge/releases) and extract it anywhere. It ships already built.

<details>
<summary>From source instead (needs git and npm)</summary>

```bash
git clone https://github.com/MCW8/bg3-agent-bridge
cd bg3-agent-bridge
npm install && npm run build
```

</details>

**2. Install the mod, with the game closed:**

```bash
node scripts/install-dev.mjs
```

Finds your BG3 install, copies the companion mod into `Data\Mods\` as loose files, and adds it to `modsettings.lsx` (backed up first; refuses to run while the game is open, because the game rewrites that file from memory on exit). `BG3_GAME_DIR` overrides the install search; `--uninstall` reverses it.

Loose files rather than a packed `.pak`, deliberately: a pak is read once at startup, so **packed Lua cannot be hot-reloaded**. Loose files apply on the next `bg3_reload`.

**3. Connect your agent:**

```bash
node scripts/configure-agent.mjs
```

Prints an MCP config block with your real install path already in it. **Paste it into a chat with your AI agent and ask it to add the server to its MCP config**, then restart the agent. If yours cannot edit its own config, see [Connecting your AI agent](#connecting-your-ai-agent).

**4. Verify.** Launch the game, load a save, and ask your agent to call `bg3_bridge_status`. Or, with no agent involved:

```bash
node scripts/check-bridge.mjs
```

That last one is the best first diagnostic: it talks to the game directly, so it separates "the bridge is broken" from "my agent is not wired up".

## Connecting your AI agent

If the agent cannot edit its own config, the script can write it directly:

```bash
node scripts/configure-agent.mjs --list                 # known configs, and whether each exists
node scripts/configure-agent.mjs --write kimi           # Kimi Code
node scripts/configure-agent.mjs --write claude-desktop
node scripts/configure-agent.mjs --write cursor
node scripts/configure-agent.mjs --write project        # .mcp.json in the current folder
node scripts/configure-agent.mjs --path "C:/Users/you/.some-agent/mcp.json"   # anything else
```

It backs the file up first, merges rather than overwrites, creates the file if missing, and is safe to re-run.

<details>
<summary>Doing it by hand</summary>

Every MCP client reads the same shape; they differ only in where it lives.

```json
{
  "mcpServers": {
    "bg3-agent-bridge": {
      "command": "node",
      "args": ["C:/Users/you/bg3-agent-bridge/dist/index.js"]
    }
  }
}
```

| Client | Where that goes |
|---|---|
| **Claude Code** | `claude mcp add bg3-agent-bridge -- node C:/path/to/dist/index.js`, or `.mcp.json` in the project root |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Kimi Code** | `%USERPROFILE%\.kimi-code\mcp.json` |
| **Cursor** | `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` globally |
| **Anything else** | Search its docs for `mcpServers` — that key is the common denominator |

Some clients only create their config after you configure something in the UI, so it may not exist on a fresh install — `--write` creates it.

Use `/` or escaped `\\` in paths. A single backslash is a JSON escape character and will break the file, usually without a useful error.

</details>

**Confirm it registered** before blaming the bridge — most clients list connected servers in their UI. You want `bg3-agent-bridge` with 18 tools named `bg3_*`; if absent, the problem is the config, not the game. **Restart the client after editing config** — almost none reload it live.

## Building your own mods

Only relevant once you are making mods rather than just running this. Packing needs `divine.exe`, the LSLib CLI:

1. Download `ExportTool-vX.Y.Z.zip` from [LSLib releases](https://github.com/Norbyte/lslib/releases) and extract it anywhere
2. `set BG3_DIVINE_PATH=C:\path\to\Tools\divine.exe`

[BG3 Modders Multitool](https://github.com/ShinyHobo/BG3-Modders-Multitool) bundles divine — point `BG3_DIVINE_PATH` at its `Tools` folder if you use it. `npm run install-mod` packs the companion mod, searching `PATH` and the usual extract locations.

Not vendored, deliberately: LSLib tracks game patches, so a bundled copy goes stale exactly when a patch lands, and shipping someone else's binary puts its integrity on this repo rather than upstream.

The `examples/` directory has three worked mods — a spell, an item, and a status composition — each with build commands and the mistakes worth avoiding.

## Tools

| Tool | Purpose |
|---|---|
| `bg3_bridge_status` | Is the game running with the bridge loaded, and what does each context support |
| `bg3_list_mods` | What is actually mounted, in load order — check this first when a mod "isn't working" |
| `bg3_find_resource` | Search sounds, visuals, materials and effects by name to get their GUIDs |
| `bg3_find_template` | Search root templates — name to template id, stat entry and visual GUID |
| `bg3_find_stat` | Search statuses, spells, armour and weapons by internal **or** in-game name |
| `bg3_find_static_data` | Search ~130 static data types — effects, flags, tags, races, spell lists |
| `bg3_find_status_by_effect` | Reverse lookup: which statuses apply a given visual effect |
| `bg3_preview_item` | Temporarily wear an item to see how it looks, then restore |
| `bg3_preview_status` | Apply a status to see its effect, then clear it |
| `bg3_play_sound` | Fire a sound event to audition it, globally or at a character |
| `bg3_capture_sounds` | Record which sound events the game actually fires — "what sound was that?" |
| `bg3_eval` | Run a Lua chunk in the live game and get its return values |
| `bg3_reload` | Hot-reload the Lua VM via `Ext.Debug.Reset()` |
| `bg3_entity_inspect` | List an entity's components, or dump one by name |
| `bg3_stats_get` | Read a stat entry or a single attribute |
| `bg3_stats_set` | Write one stat attribute and sync it to clients |
| `bg3_read_log` | Tail the newest Script Extender / Osiris log, with regex filtering |
| `bg3_list_logs` | List available log files, newest first |

Environment overrides: `BG3_SE_DIR`, `BG3_LOG_DIR`, `BG3_MODS_DIR`, `BG3_DIVINE_PATH`.

## Finding asset GUIDs

`bg3_find_resource` searches the loaded resource banks directly — half-remembered name to GUID, no unpacking. Every string field is searchable, including `SourceFile`, so searching by `.bnk` or pak name works too.

```
bg3_find_resource type=Sound  query=thunderwave
  Spell_Cast_Damage_Thunder_Thunderwave_L1to3_01   bdf50f4b-d321-688e-5bfd-c0fe24dcc118

bg3_find_resource type=Visual query=barbarian
  slot=Body      HUM_M_ARM_Barbarian_A_Pants           62e808d4-ebf1-3311-20b3-192e2bd71e71
  slot=Footwear  GTY_M_ARM_BarbarianMagical_A_Footwear  25587081-9fd5-64dc-fdec-760a0dab50e5
```

Sounds carry a readable `SoundEvent`; visuals carry `Slot`, `Template`, `SkeletonResource`; `moddedOnly` narrows to modded entries. Scans are whole-bank (~160ms over 24k sounds, ~740ms over 60k visuals — a brief but real hitch in the running game), so prefer a narrow `query`.

### Capturing engine sound requests (limited)

`Ext.Audio` is write-only, but the engine's `SoundRoutingSystem` exposes a queue of `SoundPostEventRequest`s, readable from a tick handler. `bg3_capture_sounds` drains it every tick:

```
bg3_capture_sounds action=start        arm it
   ... do the thing in game ...
bg3_capture_sounds action=read         what was queued, with repeat counts
```

**Set your expectations low.** Testing against jumping and repeated spell casts produced `Shake_Rumble_Start`/`_Stop` and nothing else — the rumble and screen-shake channel; the audio you actually hear never appeared. What it is good for is detecting **impact and shake moments** with a per-event subject entity — a reliable hook that tells you nothing about the audio.

### Auditioning a sound

For sounds you have a name for:

```
bg3_find_resource type=Sound query=thunderwave     -> SoundEvent name
bg3_play_sound    event=Spell_Cast_Damage_Thunder_Thunderwave_L1to3_01
bg3_play_sound    event=... target=<character UUID>   -- positional, at that character
bg3_play_sound    target=Global stop=true             -- if a looping event will not end
```

`target` takes a built-in sound object — `Global`, `Music`, `Ambient`, `HUD`, `Listener` — or an entity UUID. (Found by probing; plausible names like `UI` or `Player` are not valid.) A misspelled event returns `posted: false` rather than raising.

**`posted: true` does not mean you heard anything.** Most game sounds are positional: fired at a built-in object they play nowhere near the listener. Prefer `target=<character UUID>`; with a built-in target the tool warns if the event's `MaxDistance` is short. Many foley events are also gated on Wwise **switches** (surface material, character size) and fired cold resolve to a faint click or nothing — `Ext.Audio.SetSwitch` is the lever, not yet wrapped as a tool.

### What this means for audio mods

Sounds attached to a spell are stat fields and easy to swap — `Projectile_Jump` carries `CastSound`, `PrepareSound`, `PrepareLoopSound`. Movement foley is not: `MOVEMENT.bnk` has 36 events, none a landing, and the jump spell has no `ImpactSound` field. Layering a sound on top from Lua is easy; *replacing* engine-driven foley means rebuilding a soundbank — outside what this does.

**`bg3_play_sound` is a development tool, not a player-facing feature.** Nothing is bound to input. Letting a player trigger sounds is a mod — the same `Ext.Audio.PostEvent` call, bound to a spell, item or console command.

## Finding things by the name you remember

Asset names are not the names players use. `bg3_find_template` ignores spaces, underscores and case, and falls back to typo-tolerant matching when nothing matches literally:

```
"Blood of Lathander"   1 match, exact       UNI_CRE_HUM_Sun_Mace_BloodOfLathander
"Blood of Lathandar"   4 matches, fuzzy     the mace first, distance 1
"Sword of Justise"     1 match,  fuzzy      UNI_PLA_WPN_SwordOfJustice
"Grateaxe"            16 matches, fuzzy     every greataxe, distance 2
```

The fuzzy pass only runs when the literal one finds nothing (~110ms usual, ~350ms with typos). Every query word must match something, which is what ranks sensibly: `"blood lathandar"` puts the mace above a Lathander portrait, because nothing in the portrait resembles "blood". `"Lathandar"` alone returns 44 hits in arbitrary order. Results carry the resolved `DisplayName`, usually the only way to tell one of 173 hits from another.

**Searches match display names as well as internal ones, by default.** The status players see as *Marked for Negation* is internally `OBLITERATIONORB` — the two share not one word, so no name search reaches it otherwise. Resolving display names across all 32k templates costs ~31ms, not worth optimising away.

`bg3_find_stat` is the one to reach for when you remember the in-game name — it also resolves the visual effect, so finding a status and learning what it looks like is one call:

```
bg3_find_stat type=StatusData query="Marked for Negation"
  OBLITERATIONORB   "Marked for Negation"
  StatusEffectName: END_ORB_OF_OBLITERATION_PLATFORM_WARNING_StatusEffect
```

## Finding a visual effect you have seen but cannot name

A status is almost never named after how it looks, so work backwards from the effect. A real example — the green spectral look from Oskar's Beloved:

```
bg3_find_static_data type=MultiEffectInfo query=possess
  LOW_OSKARBELOVED_Possession_FX          3,847 scanned, 12ms

bg3_find_status_by_effect query=possess
  LOW_OSKARSBELOVED_POSSESSING_FX  [EFFECT]  -> LOW_OSKARBELOVED_Possession_FX
  LOW_GHOST_POSSESSED              [BOOST]   -> LOW_GHOST_POSSESSED_StatusEffect

bg3_preview_status action=apply status=LOW_OSKARSBELOVED_POSSESSING_FX
bg3_preview_status action=clear
```

**Nothing in `LOW_OSKARSBELOVED_POSSESSING_FX` says "green", "ghost" or "spectral".** The route in is `MultiEffectInfo` → status → wear it. The last step matters most: candidates are cheap to try, so guessing badly costs seconds.

Which terms you try is the skill: "ghost" finds `GHOST_FX`, a different, bluer effect. Search the *situation* the effect belongs to (quest, creature, condition) as well as the appearance — that is how Larian names things.

`bg3_find_static_data` covers ~130 types beyond effects: `VFX`, `Flag`, `Tag`, `Race`, `Progression`, `SpellList`, `ClassDescription`, `Feat`. An invalid type name returns the full list.

Check `statusType` before applying. `EFFECT` is purely cosmetic; `BOOST` changes gameplay and `POLYMORPHED` replaces the model.

## Looking at items and armour

Templates carry cross-references that resources do not, so one search yields the whole graph:

```
bg3_find_template query=ARM_Plate templateType=item
  ARM_Plate_Dwarven   id=b4c754d8-...  stats=ARM_Plate_Body  visual=fcaf0df1-...

bg3_preview_item action=apply template=b4c754d8-...   wear it
bg3_preview_item action=restore                        put the original back
```

**There is no in-place visual swap in BG3.** Writing an equipped item's `GameObjectVisual` changes the value and nothing renders differently; `Osi.AddCustomVisualOverride` exists but has no visible effect on equipment. Shipped transmog mods *equip a different item* — spawn the good-looking one, copy the original's stats onto it, wear that. (The counterpart is spelled `Osi.RemoveCustomVisualOvirride` — Larian's typo, and the misspelled name is the one bound at runtime.)

`bg3_preview_item` does the light version: spawns the template with `temporary=1`, equips it, moves the original to inventory, restores on request. The preview is a **real item with its own stats** — previewing plate over leather genuinely changes armour class, so not mid-combat — and an un-restored preview leaves the original in inventory.

Slot detection reads `Equipable.Slot`, which reports `Breast`; `Osi.GetEquipmentSlotForItem` returns an enum index (`1`) that `GetEquippedItem` will not accept.

## A note on RequiredVersion

`ScriptExtender/Config.json` declares `"RequiredVersion": 32`, and that number does more than gate loading. From the Script Extender docs:

> use the version number of the Script Extender you used for developing the mod **since the behavior of new features and backwards compatibility functions depends on this version number**

A low number is not the cautious choice it looks like — it asks the extender to run your mod under old-version compatibility behaviour. This started life at `7`, copied from a working mod without checking, so a v32 runtime was applying v7 semantics to everything here. The installed build reports its API version as the file version of `BG3ScriptExtender.dll` in `%LOCALAPPDATA%\BG3ScriptExtender\`; set `RequiredVersion` to what you actually developed and tested against.

## On the reference dumps

Measured against SE v32, not assumed:

- **Existence data is trustworthy.** `pairs(Osi)` enumerates 1303 names; `Osi.lua` declares 983 and `Osi.Events.lua` 320, summing exactly, nothing declared-but-absent or runtime-but-undocumented — in files 16 months old.
- **Signatures are not.** `Ext.Vars.RegisterUserVariable` is declared as taking a name alone; calling it that way fails — the options table is required. Regenerating does not help: the generator cannot express optional parameters. Only calling a function settles its shape, which `bg3_eval` makes cheap.
- **`Ext.Osiris.RegisterListener` is missing** from generated helpers entirely, so LaughingLeader's separate file for it stays necessary.

`GenerateIdeHelpers("Helpers.lua")` still earns its place for *coverage*: a build-exact file, roughly 950 lines larger than a three-month-old copy.

Checking whether an `Osi` function exists needs `type(Osi.X) ~= "nil"` — entries are userdata, never Lua functions, so `type(Osi.X) == "function"` is false for every one of them: a check that will convince you a working function is missing.

## Known limits

**`bg3_eval` depends on a capability that is not guaranteed.** `load()` is not *documented* as exposed to mod scripts. The mod probes at boot and reports through `bg3_bridge_status`, so a missing `load` is a clear message, not a silent failure. SE's `load` takes an environment table as its second argument, not a chunk-name string. The structured tools do not depend on any of this.

**Some objects cannot be serialized.** Large stat entries follow an inheritance chain deep enough to exceed the JSON recursion limit, and that limit *raises* rather than truncating — a lower `depth` turns a large result into a hard error. `bg3_stats_get` on `Projectile_MagicMissile` fails this way; a single `attribute` from the same entry returns instantly. Prefer `attribute` and `component` over whole-object dumps.

**Round trips cost about a second.** The mod polls every 30 ticks; one poll already costs SE 7-9ms, flagged as a slow event. Polling faster trades frame time for latency agents do not need.

**Three tiers of change, only one of which is fast.**

| Change | To apply it |
|---|---|
| Mod Lua | `bg3_reload` — about 1.5s |
| Packed data (stats, root templates, localization) | Repack and restart the game |
| Load order (`modsettings.lsx`, adding a pak) | Restart the game — **and** see the hazard below |

Reloading a *save* applies none of these — it re-reads the save, not the module list. Worse, the game rewrites `modsettings.lsx` on exit from its in-memory load order, silently discarding entries added while it was running. Edit that file with the game closed, and confirm what mounted with `bg3_list_mods`.

**Hot reload is not per-context.** `Ext.Debug.Reset()` restarts **both** server and client VMs whichever context asks — all in-memory Lua state goes with it, including `bg3_stats_set` edits. The `context` argument picks the transport, not the scope.

**`bg3_eval` does not run inside your mod's sandbox.** Chunks compile into the default global table: `Ext`, `Osi`, `Mods` are reachable, your mod's bare globals are not. Reach mod state through `Mods.<ModTable>`.

**The loop is slower than Unity's.** The game boots in about a minute and needs a loaded save — keep one instance alive and iterate against it. `client` only answers once a save is loaded; `server` is the right default for almost everything.

**Script Extender's API moves with game patches.** Every capability is probed at runtime rather than assumed, but a large enough patch will still need updates here.

## Legal

Ships no Larian assets and no Toolkit code. Larian's [modding terms](https://baldursgate3.game/modding-terms/) forbid redistributing the Toolkit, so the companion mod is built from source on your machine against your own install. LSLib is MIT licensed. Do not commit extracted game data — `.gitignore` covers the obvious paths.

## Contributing

Adding an operation is two small edits: a handler in `mod/Mods/BG3AgentBridge/ScriptExtender/Lua/Bridge/Handlers.lua`, and a `defineTool` call in `src/index.ts`. The mailbox handles framing, ordering, errors, and timeouts.

MIT licensed.
