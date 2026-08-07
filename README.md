# BG3 Agent Bridge

An MCP server that gives an AI coding agent a **live feedback loop into a running Baldur's Gate 3 session**, through the [Script Extender](https://github.com/Norbyte/bg3se).

Editing BG3 mods with an agent today is blind: it writes Lua, you launch the game, you read the error, you paste it back. This closes that loop — the agent can reload scripts, inspect live entities, read stats, and tail the Script Extender log itself.

It is the same shape as Unity MCP, with one substitution that matters: **the Toolkit is not the editor being driven — the running game is.** Larian's Toolkit (`Glasses.exe`) accepts launch arguments and nothing else; it has no plugin API, no headless mode, and no IPC. The Script Extender is where BG3 actually exposes live reflection, so that is what this attaches to.

## What this is not

- **Not a replacement for [BG3 Modders Multitool](https://baldurs-gate-3.thunderstore.io/package/ShinyHobo/BG3_Modders_Multitool/).** Multitool handles unpacking, indexing, and searching game files, and does it well. This is the runtime half, not the static-file half.
- **Not a Toolkit automation layer.** Nothing here drives the level editor.
- **Not a way to edit your mod source.** Everything it changes is session-only. Your agent already has file tools for the source.

## How it works

The Script Extender explicitly has **no networking** — SE mods cannot open sockets or talk to external processes. It does have `Ext.IO.SaveFile` / `Ext.IO.LoadFile` and a per-tick event, so the transport is a file mailbox in the Script Extender data directory:

```
MCP server (Node)                       Companion mod (Lua, in-game)
       |                                             |
       |-- write request_server.json --------------->|  polled on Ext.Events.Tick
       |      {seq, op, params}                      |  dispatch -> pcall(handler)
       |<------------- write response_server.json ---|
       |               {seq, ok, result|error}       |
```

Writes are atomic (temp file plus rename) so neither side reads a half-written message, and a sequence cursor keeps a completed request from being replayed after a VM reset. `server` and `client` contexts get separate mailboxes.

## Requirements

- Windows, Baldur's Gate 3, and the [Script Extender](https://github.com/Norbyte/bg3se)
- **[Node.js](https://nodejs.org/) 20 or newer** — the server is a Node program, so this is the one hard prerequisite.

  Open PowerShell and run:

  ```bash
  winget install OpenJS.NodeJS.LTS
  ```

  `winget` ships with Windows 10 and 11. If it is missing, download the **LTS** installer from [nodejs.org](https://nodejs.org/) and click through it — the defaults are correct.

  **Then close that window and open a new one.** Installers only update `PATH` for terminals opened afterwards, so an existing window will keep insisting `node` is not recognised. Check in the new window:

  ```bash
  node --version
  ```

  Anything `v20` or higher is fine.

You do **not** need `divine.exe`, LSLib, or a mod manager to run the bridge. Those are only for building your own `.pak` later.

## Install

**1. Get the files**

Download `bg3-agent-bridge-v0.1.0.zip` from the [Releases page](https://github.com/MCW8/bg3-agent-bridge/releases) and extract it anywhere — your Documents folder is fine. It ships already built, so there is nothing to compile.

<details>
<summary>From source instead (needs git and npm)</summary>

```bash
git clone https://github.com/MCW8/bg3-agent-bridge
cd bg3-agent-bridge
npm install && npm run build
```

</details>

**2. Install the mod, with the game closed**

```bash
node scripts/install-dev.mjs
```

That finds your BG3 install, copies the companion mod into `Data\Mods\` as loose files, and adds it to `modsettings.lsx` — backing that file up first, and refusing to run while the game is open, because the game rewrites it from memory on exit.

No mod manager and no packing. Loose is the right mode for modding anyway: **a packed mod's Lua cannot be hot-reloaded**, since the pak is read once at startup, so `bg3_reload` would just re-read the same bytes. Loose files mean your edits apply on the next reload.

`node scripts/install-dev.mjs --uninstall` reverses it. Set `BG3_GAME_DIR` if your install is somewhere unusual.

**3. Ask your agent to connect itself**

That script finishes by printing a config block with your real install path already in it, like this:

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

**Copy it, paste it into a chat with your AI agent, and ask it to add this to its MCP config.** Most agents know where their own config lives, will create the file if it does not exist, and will validate the JSON afterwards. Then restart the agent.

That is genuinely the whole step — it is how this was first connected to Kimi Code, in one message. See [Connecting your AI agent](#connecting-your-ai-agent) if yours cannot edit its own config.

**4. Verify** — launch the game, load a save, and ask your agent to call `bg3_bridge_status`. Or, with no agent involved at all:

```bash
node scripts/check-bridge.mjs
```

That last one is the best first diagnostic: it talks to the game directly, so it separates "the bridge is broken" from "my agent is not wired up".

## Connecting your AI agent

**Simplest route: let the agent do it.** Open a terminal in the folder you extracted — the one containing `scripts` and `dist` — and run:

```bash
node scripts/configure-agent.mjs
```

That prints a config block with your actual install path already in it. Paste that into a chat with your agent and ask it to add the server to its own MCP config. Most agents know where their config lives, will create it if missing, and will validate it — that is how this was first set up under Kimi Code, and it took one message.

Then restart the agent.

<details>
<summary>Or have the script write it directly</summary>

Useful if your agent cannot edit its own config:

```bash
node scripts/configure-agent.mjs --list                 # known configs, and whether each exists
node scripts/configure-agent.mjs --write kimi           # Kimi Code
node scripts/configure-agent.mjs --write claude-desktop
node scripts/configure-agent.mjs --write cursor
node scripts/configure-agent.mjs --write project        # .mcp.json in the current folder
```

**Using an agent that is not listed?** Point it at the config file directly — nearly every client reads the same `mcpServers` key:

```bash
node scripts/configure-agent.mjs --path "C:/Users/you/.some-agent/mcp.json"
```

It backs the file up first, merges rather than overwrites — other servers and unrelated settings survive — creates the file if it does not exist yet, and is safe to re-run.

</details>

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

Some clients only create their config file after you configure something in the UI, so it may not exist on a fresh install. `--write` creates it.

Use `/` or escaped `\\` in paths. A single backslash is a JSON escape character and will break the file, usually without a useful error.

</details>

**Confirm it registered** before blaming the bridge — most clients list connected servers somewhere in their UI. You want `bg3-agent-bridge` with 14 tools named `bg3_*`. If they are absent, the problem is the config, not the game. **Restart the client after editing config**; almost none reload it live.

## Building your own mods

Only relevant once you are making mods rather than just running this. You need `divine.exe`, the LSLib CLI:

1. Download `ExportTool-vX.Y.Z.zip` from [LSLib releases](https://github.com/Norbyte/lslib/releases) and extract it anywhere
2. `set BG3_DIVINE_PATH=C:\path\to\Tools\divine.exe`

[BG3 Modders Multitool](https://github.com/ShinyHobo/BG3-Modders-Multitool) bundles divine, so point `BG3_DIVINE_PATH` at its `Tools` folder if you already use it. `npm run install-mod` searches `PATH` and the usual extract locations, and lists everywhere it looked if it comes up empty.

It is not vendored here deliberately: LSLib tracks game patches, so a bundled copy would go stale exactly when a new patch lands, and shipping someone else's binary would put its integrity on this repo rather than upstream.

The `examples/` directory has two worked mods — a spell and an item — each with build commands and the mistakes worth avoiding.

## Tools

| Tool | Purpose |
|---|---|
| `bg3_bridge_status` | Is the game running with the bridge loaded, and what does each context support |
| `bg3_list_mods` | What is actually mounted, in load order — check this first when a mod "isn't working" |
| `bg3_find_resource` | Search sounds, visuals, materials and effects by name to get their GUIDs |
| `bg3_find_template` | Search root templates — name to template id, stat entry and visual GUID |
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

`bg3_find_resource` searches the loaded resource banks directly, so you can go from a half-remembered name to a GUID without unpacking anything. Every string field is searchable, including `SourceFile`, so searching by `.bnk` or pak name works too.

```
bg3_find_resource type=Sound  query=thunderwave
  Spell_Cast_Damage_Thunder_Thunderwave_L1to3_01   bdf50f4b-d321-688e-5bfd-c0fe24dcc118

bg3_find_resource type=Visual query=barbarian
  slot=Body      HUM_M_ARM_Barbarian_A_Pants           62e808d4-ebf1-3311-20b3-192e2bd71e71
  slot=Footwear  GTY_M_ARM_BarbarianMagical_A_Footwear  25587081-9fd5-64dc-fdec-760a0dab50e5
```

Sounds carry a readable `SoundEvent`; visuals carry `Slot`, `Template` and `SkeletonResource`; `moddedOnly` narrows to what a mod added. Scans are whole-bank — roughly 160ms across 24k sounds and 740ms across 60k visuals, which is a brief but real hitch in the running game, so prefer a narrow `query`.

### Capturing engine sound requests (limited)

`Ext.Audio` is write-only, but the engine's `SoundRoutingSystem` exposes a queue of `SoundPostEventRequest`s, and that queue is readable from a tick handler. `bg3_capture_sounds` drains it every tick:

```
bg3_capture_sounds action=start        arm it
   ... do the thing in game ...
bg3_capture_sounds action=read         what was queued, with repeat counts
```

Entries carry the event name, subject entity, and type. Repeats on consecutive frames collapse into a `count`, and overflow is counted rather than dropped.

**Set your expectations low: this is not a general "what sound was that?" tool.** Testing against jumping and against repeated spell casts produced `Shake_Rumble_Start`/`_Stop` and nothing else — the rumble and screen-shake channel. The audio you actually hear, including the cast and impact sounds of a spell that visibly triggered these entries, never appeared in the queue. Most of BG3's audio evidently reaches Wwise by a path that does not pass through this system.

What it is genuinely good for is detecting **impact and shake moments** — landings, AOE impacts — with a per-event subject entity, which is a reliable hook even though it tells you nothing about the audio. Whether any other category of sound ever appears here is unproven; two tests both returned rumble only.

### Auditioning a sound

The search-then-play loop still matters for sounds you have a name for rather than an action to perform:

```
bg3_find_resource type=Sound query=thunderwave     -> SoundEvent name
bg3_play_sound    event=Spell_Cast_Damage_Thunder_Thunderwave_L1to3_01
bg3_play_sound    event=... target=<character UUID>   -- positional, at that character
bg3_play_sound    target=Global stop=true             -- if a looping event will not end
```

`target` takes a built-in sound object — `Global`, `Music`, `Ambient`, `HUD`, `Listener` — or an entity UUID to play positionally. Those names were found by probing, since the engine rejects unknown ones and exposes no enum to list them; other plausible names (`UI`, `Camera`, `Player`, `World`) are not valid. A misspelled event returns `posted: false` rather than raising, which is how you tell "Wwise does not know this event" from "the call failed".

**`posted: true` does not mean you heard anything.** Most game sounds are positional: fire one at a built-in object and it plays nowhere near the listener, returning success in silence. Prefer `target=<character UUID>`. When a built-in target is used the tool looks the event up and warns if its `MaxDistance` is short — `Action_Cast_Jump` at 50 is inaudible on `Global`, while the forge hammer at 120 carries fine.

Foley events add a second failure mode: many are gated on Wwise **switches** such as surface material or character size, and fired cold they resolve to little or nothing. A valid event that plays as a faint click is usually this rather than a wrong GUID. `Ext.Audio.SetSwitch` is the lever, and is not yet wrapped as a tool.

### What this means for audio mods

Sounds attached to a spell are exposed as stat fields and are straightforward to swap — `Projectile_Jump` carries `CastSound`, `PrepareSound` and `PrepareLoopSound`, so overriding one is a stat edit. Movement foley is not: `MOVEMENT.bnk` has 36 events and none of them is a landing, and no `ImpactSound` field exists on the jump spell. Layering a sound on top from Lua is easy; genuinely *replacing* engine-driven foley means rebuilding a soundbank, which is outside what this does.

**`bg3_play_sound` is a development tool, not a player-facing feature.** It fires when the tool is called from outside the game; nothing is bound to input and the person playing gets no control from it. Letting a player trigger sounds at will is a mod — the same `Ext.Audio.PostEvent` call, bound to a spell, item or console command.

## Finding things by the name you remember

Asset names are not the names players use. `bg3_find_template` therefore ignores spaces, underscores and case, and falls back to typo-tolerant matching when nothing matches literally:

```
"Blood of Lathander"   1 match, exact       UNI_CRE_HUM_Sun_Mace_BloodOfLathander
"Blood of Lathandar"   4 matches, fuzzy     the mace first, distance 1
"Sword of Justise"     1 match,  fuzzy      UNI_PLA_WPN_SwordOfJustice
"Grateaxe"            16 matches, fuzzy     every greataxe, distance 2
```

The fuzzy pass only runs when the literal one finds nothing, so the usual case stays at ~110ms and typos cost ~350ms. Every word of the query has to match something, which is what ranks sensibly: `"blood lathandar"` puts the mace above a Lathander portrait, because nothing in the portrait resembles "blood". A single vague word cannot do that — `"Lathandar"` alone returns 44 hits in arbitrary order.

Results carry the resolved `DisplayName`, which is usually the only practical way to tell `UNI_CRE_HUM_Sun_Mace_BloodOfLathander` from 173 other hits.

## Finding a visual effect you have seen but cannot name

Effects are the hardest thing to search for, because a status is almost never named after how it looks. Working backwards from the effect is what gets there. A real example — finding the green spectral look from Oskar's Beloved:

```
bg3_find_static_data type=MultiEffectInfo query=possess
  LOW_OSKARBELOVED_Possession_FX          3,847 scanned, 12ms

bg3_find_status_by_effect query=possess
  LOW_OSKARSBELOVED_POSSESSING_FX  [EFFECT]  -> LOW_OSKARBELOVED_Possession_FX
  LOW_GHOST_POSSESSED              [BOOST]   -> LOW_GHOST_POSSESSED_StatusEffect

bg3_preview_status action=apply status=LOW_OSKARSBELOVED_POSSESSING_FX
bg3_preview_status action=clear
```

**Nothing in `LOW_OSKARSBELOVED_POSSESSING_FX` says "green", "ghost" or "spectral".** No amount of name searching finds it from what it looks like. The route in is `MultiEffectInfo` → status → wear it, and the last step matters most: candidates are cheap to try, so guessing badly costs seconds.

Which terms you try is the skill. Searching "ghost" finds `GHOST_FX` — a different, bluer effect. Searching "possess" finds this one. Search the *situation* the effect belongs to (a quest name, a creature, a condition) as well as the appearance, since that is how Larian names things.

`bg3_find_static_data` covers roughly 130 types beyond effects: `VFX`, `Flag`, `Tag`, `Race`, `Progression`, `SpellList`, `ClassDescription`, `Feat`. An invalid type name returns the full list.

Check `statusType` before applying. `EFFECT` is purely cosmetic; `BOOST` changes gameplay and `POLYMORPHED` replaces the model.

## Looking at items and armour

Templates carry cross-references that resources do not, so one search yields the whole graph:

```
bg3_find_template query=ARM_Plate templateType=item
  ARM_Plate_Dwarven   id=b4c754d8-...  stats=ARM_Plate_Body  visual=fcaf0df1-...

bg3_preview_item action=apply template=b4c754d8-...   wear it
bg3_preview_item action=restore                        put the original back
```

**There is no in-place visual swap in BG3.** Writing an equipped item's `GameObjectVisual` changes the value and nothing renders differently; `Osi.AddCustomVisualOverride` exists and can be called, but has no visible effect on equipment. Shipped transmog mods work by *equipping a different item* — spawning the good-looking one, copying the original's stats onto it, and wearing that.

Its counterpart is spelled `Osi.RemoveCustomVisualOvirride` — Larian's typo, not a documentation error, and the misspelled name is the one bound at runtime.

`bg3_preview_item` does the light version of the same thing, since a preview does not have to stay playable. It spawns the template with `temporary=1`, equips it, moves the original to inventory, and restores on request. Two consequences worth knowing: the preview is a **real item with its own stats**, so previewing plate over leather genuinely changes armour class — don't do it mid-combat — and an un-restored preview leaves the original sitting in inventory.

Slot detection reads the item's `Equipable.Slot`, which reports `Breast`. `Osi.GetEquipmentSlotForItem` returns an enum index (`1`) that `GetEquippedItem` will not accept.

## On the reference dumps

Measured against SE v32, not assumed:

- **Existence data is trustworthy.** `pairs(Osi)` enumerates 1303 names; `Osi.lua` declares 983 and `Osi.Events.lua` 320, summing exactly, with nothing declared-but-absent and nothing runtime-but-undocumented. Those files were 16 months old and still correct.
- **Signatures are not.** `Ext.Vars.RegisterUserVariable` is declared as taking a name alone; calling it that way fails, because the options table is required. Regenerating does not help — `Ext.Types.GenerateIdeHelpers` produces the same wrong signature, since the generator cannot express optional parameters. Only calling a function settles its shape, which `bg3_eval` makes cheap.
- **`Ext.Osiris.RegisterListener` is missing** from generated helpers entirely, so LaughingLeader's separate file for it stays necessary.

`Ext.Types.GenerateIdeHelpers("Helpers.lua")` still earns its place for *coverage* — it writes a build-exact file to the Script Extender directory, roughly 950 lines larger than a three-month-old copy.

Checking whether an `Osi` function exists needs `type(Osi.X) ~= "nil"`. Entries are userdata (`OsiFunction(name)`), never Lua functions, so `type(Osi.X) == "function"` is false for every one of them — a check that will convince you a working function is missing.

## Known limits

**`bg3_eval` depends on a capability that is not guaranteed.** `load()` is not *documented* as exposed to mod scripts, though it was present on the build this was developed against. The mod probes at boot and reports through `bg3_bridge_status`, so if it is missing you get a clear message rather than a silent failure. Note that Script Extender's `load` takes an environment table as its second argument, not standard Lua's chunk-name string. The structured tools do not depend on any of this.

**Some objects cannot be serialized at all.** Large stat entries — spells especially — follow an inheritance chain deep enough to exceed the JSON serializer's recursion limit, and that limit *raises* rather than truncating, so a lower `depth` turns a large result into a hard error instead of a smaller one. `bg3_stats_get` on `Projectile_MagicMissile` fails this way; reading a single `attribute` from the same entry returns instantly. Prefer `attribute` and `component` over whole-object dumps.

**Round trips cost about a second.** The mod polls every 30 ticks. One poll costs Script Extender 7-9ms, enough that it is flagged as a slow event, so polling faster trades frame time for latency that agent workflows do not need.

**Three tiers of change, only one of which is fast.**

| Change | To apply it |
|---|---|
| Mod Lua | `bg3_reload` — about 1.5s |
| Packed data (stats, root templates, localization) | Repack and restart the game |
| Load order (`modsettings.lsx`, adding a pak) | Restart the game — **and** see the hazard below |

Reloading a *save* applies none of these; it re-reads the save, not the module list. Worse, the game rewrites `modsettings.lsx` on exit from its in-memory load order, so an entry added while the game was running can be silently discarded when you quit. Edit that file with the game closed, and use `bg3_list_mods` to confirm what actually mounted.

**Hot reload only covers Lua, and it is not per-context.** `bg3_reload` reinitialises the Lua VM, so edited scripts take effect immediately. Changes to packed data — stats, root templates, localization — still need a repack and a restart. `Ext.Debug.Reset()` restarts **both** the server and client VMs no matter which context asks, so all in-memory Lua state goes with it, including runtime edits made through `bg3_stats_set`. The `context` argument picks the transport, not the scope.

**`bg3_eval` does not run inside your mod's sandbox.** Chunks compile into the default global table, so `Ext`, `Osi`, and `Mods` are all reachable but a mod's own bare globals are not. Reach mod state through `Mods.<ModTable>` instead.

**The loop is slower than Unity's.** The game takes about a minute to boot and needs a loaded save. Keep one instance alive and iterate against it rather than restarting per change. The `client` context only answers once a save is loaded; `server` is the right default for almost everything.

**Script Extender's API moves with game patches.** Every capability is probed at runtime rather than assumed, but a large enough patch will still need updates here.

## Legal

This ships no Larian assets and no Toolkit code. Larian's [modding terms](https://baldursgate3.game/modding-terms/) grant a non-transferable licence to *use* the Toolkit and forbid redistributing it, so the companion mod is built from source on your machine against your own install. LSLib is MIT licensed. Do not commit extracted game data — `.gitignore` covers the obvious paths.

## Contributing

Adding an operation means two small edits: a handler in `mod/Mods/BG3AgentBridge/ScriptExtender/Lua/Bridge/Handlers.lua`, and a `defineTool` call in `src/index.ts`. The mailbox handles framing, ordering, errors, and timeouts.

MIT licensed.
