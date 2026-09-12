# BG3 Agent Bridge
aka the Crown of Karsus

A MCP server that gives whichever Coding AI you use (Claude, GLM, DeepSeek, OpenAI, Kimi, etc.) a **live feedback loop into a running Baldur's Gate 3 session**, through the [Script Extender](https://github.com/Norbyte/bg3se). Much like the Crown of Karsus, this gives your big brain AI immense power to see inside the actual game as it runs.

I've done most of my BG3 modding with the help of AI. The tedious nature writing code, launching the game, testing the code, pasting errors back into the AI, relaunching the game with the fixes, and so on is what this MCP server aims to fix. With this active, your AI can actually see the events and logs from your running game. It can reload scripts to test them without restarting the game (or even a needing to reload a save), inspect live entities, read stats, and manipulate the game (spawning NPCs, casting spells, reviving characters, reset hostility, teleporting, and most everything you as a player can do and more).

I wanted to let my AI see into Larian's Toolkit, but the Toolkit has no plugin API, no headless mode, and no IPC. Nordbyte's Script Extender makes this bridge possible with the game itself.

**What this is not:**

- Not a replacement for [BG3 Modders Multitool](https://baldurs-gate-3.thunderstore.io/package/ShinyHobo/BG3_Modders_Multitool/), which is sadly been hidden on github. Fortunately the core piece of multitool is still included in [Nordbyte's LSLib](https://github.com/Norbyte/lslib/), which you can let your AI agent know about to help you pack your mod when it's ready.
- Not a Toolkit automation layer.
- Not a one-step tool. Don't expect to ask you AI to make you an awesome BG3 mod (make no mistakes) and expect it do it all for you.
- Not a visual modding tool. The agent can't see the actual game visuals. I've had some success swapping icons and other visual elements, but you (the human) need to play an active role in confirming the visuals and describing what you see.

## Quick start

**You need:** Windows, Baldur's Gate 3, [Script Extender](https://github.com/Norbyte/bg3se), and an AI coding harness (created and tested initially through Claude Code and Kimi Code Harnesses - used primarily with [oh my pi](https://github.com/can1357/oh-my-pi)).

1. **Download and extract** `bg3-agent-bridge-v0.6.0.zip` from the [Releases page](https://github.com/MCW8/bg3-agent-bridge/releases) into a folder you'll keep (for example `C:\Tools\bg3-agent-bridge`).
2. **Close Baldur's Gate 3, then double-click `bg3-bridge.exe`.** It installs the packed companion mod and prints a short MCP config block — copy it.
3. **Paste that block to your AI agent** and ask it to add the server to its MCP config, then **restart the agent**. Launch BG3, load a save, and ask *"Is the BG3 bridge connected?"* — the agent takes it from there.

<details>
<summary>Prefer the command line? The same steps by hand.</summary>

In the extracted folder, with BG3 closed:

```
.\bg3-bridge install                          # install the companion mod
.\bg3-bridge configure --write claude-desktop # or cursor, kimi, claude-code, project
.\bg3-bridge check                            # run with the game open and a save loaded
```

Full client list and manual config live under [Connecting your AI agent](#connecting-your-ai-agent).

</details>

**Caution:** this lets your AI agent run code inside your live game. That is the point, but only install it while you are actively modding, and [uninstall when you are done](#read-this-before-installing).

### Give it a Test Drive

Some examples of things to ask to try it out:
- "Is the BG3 bridge connected? What can you do with it?"
- "Find a Flaming Fist guard template and spawn one next to me."
- "Spawn a hostile goblin with 1000 HP and start combat with my party."
- "I'm looking for a vfx that looks shiny like the frog has in Act 1."
- "What's the best way to get started making a mod with the agent bridge?"
- "I have made this mod but I'm running into issues, can you review the code and test it out with the bridge?"
- "Teleport my party to act II and give us the pixie blessing."

See the [Tools](#tools) table for the list, or [TOOLS.md](TOOLS.md) for recipes and traps.

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

Writes are small (temp file plus rename), and a sequence cursor prevents replay after a VM reset. `server` and `client` contexts get separate mailboxes.

## Read this before installing
**This is a development tool, and it executes arbitrary Lua inside your game.**

That is the whole point of what makes it so powerful — it runs whatever code directly in the live session which means:
- The bridge reads commands from a **plain file in your Script Extender folder** — anything that can write there can run Lua in your game. There is no authentication; a file mailbox cannot have any.
- Lua under the Script Extender can read and write files, so this is NOT sandboxed to the game.
- Whatever agent you connect can do all of this without asking first. I have forgotten to give context before and the agent went off and made changes that broke my save. Be careful and make backups! Do NOT use this on a save file you want to keep!

The bridge will run constantly once installed, even when BG3 and your coding harness are closed. Fine while you are actively modding, and not CPU intensive to leave it ready in the background. Best practice is to double-click the exe again and select "Uninstall" to ensure it isn't running anymore.

**Uninstall it when you are done** — double-click `bg3-bridge.exe` again (with the game closed) and choose **Uninstall**, or from a terminal:

```bash
.\bg3-bridge uninstall
```

Then remove the server from your agent's MCP config. `bg3_bridge_status` reports whether it is still live.

## Requirements

- Windows, Baldur's Gate 3, and the [Script Extender](https://github.com/Norbyte/bg3se) **v32 or newer**. SE updates itself by default; older versions simply refuse to load the mod (`RequiredVersion`). Bring you AI coding harness of choice.

The bridge was created and tested initially through Claude Code and Kimi Code Harnesses - in most cases I now use it with [oh my pi](https://github.com/can1357/oh-my-pi)). The release ships as a single `bg3-bridge.exe`.

You do not need `divine.exe`, LSLib, or a mod manager to run the bridge, although those are standard modding tools that will benefit you as well.

## Install
The fastest path is the [Quick start](#quick-start): double-click `bg3-bridge.exe` for a guided setup that does all of the below in a few seconds. The manual steps here are the same actions, broken out — useful for scripting, headless setups, or when something needs adjusting.

<details>
<summary>Manual Install Steps (needs git, Node 20+, and npm)</summary>
**1. Get the files.** Download `bg3-agent-bridge-v0.6.0.zip` from the [Releases page](https://github.com/MCW8/bg3-agent-bridge/releases) and extract it anywhere - I highly recommend choosing a dedicated easy-to-remember folder instead of running it from the Downloads folder. The zip is `bg3-bridge.exe` and the companion mod as `BG3AgentBridge.pak`.
       
```bash
git clone https://github.com/MCW8/bg3-agent-bridge
cd bg3-agent-bridge
npm install && npm run build
```

Then run the following commands (if not installing with the exe): `node scripts/install-dev.mjs`, `node scripts/configure-agent.mjs`, `node scripts/check-bridge.mjs`.

**2. Install the mod, with the game closed.** In the folder you extracted:

```bash
.\bg3-bridge install
```

Finds your BG3 install, copies `BG3AgentBridge.pak` into your `Mods` directory (`%LOCALAPPDATA%\Larian Studios\Baldur's Gate 3\Mods\` — the same place mod managers put paks), and adds it to `modsettings.lsx` (backed up first; refuses to run while the game is open, because the game rewrites that file from memory on exit). `BG3_GAME_DIR` overrides the install search; `--uninstall` reverses it. Re-running the exe and choosing "Reinstall / update" after downloading a newer version does the same thing, guided.

**Development flavor.** `.\bg3-bridge install --loose` copies the mod source into `Data\Mods\` as loose files instead. That is the right shape while working on the bridge itself: a pak is read once at startup, so **packed Lua cannot be hot-reloaded**, while loose files apply on the next `bg3_reload`. Installing either flavor removes the other — the game serves a pak over loose files, and a leftover would silently shadow your edits.

**3. Connect your agent:**

```bash
.\bg3-bridge configure
```

Prints an MCP config block with your real install path already in it. **Paste it into a chat with your AI agent and ask it to add the server to its MCP config**, then restart the agent. If yours cannot edit its own config, see [Connecting your AI agent](#connecting-your-ai-agent).

**4. Verify.** Launch the game, load a save, and ask your agent to call `bg3_bridge_status`. Or, with no agent involved:

```bash
.\bg3-bridge check
```

That last one is the best first diagnostic: it talks to the game directly, so it separates "the bridge is broken" from "my agent is not wired up".

## Connecting your AI agent

If the agent cannot edit its own config, the exe can write it directly:

```bash
.\bg3-bridge configure --list                 # known configs, and whether each exists
.\bg3-bridge configure --write kimi           # Kimi Code
.\bg3-bridge configure --write claude-desktop
.\bg3-bridge configure --write cursor
.\bg3-bridge configure --write project        # .mcp.json in the current folder
.\bg3-bridge configure --path "C:/Users/you/.some-agent/mcp.json"   # anything else
```

It backs the file up first, merges rather than overwrites, creates the file if missing, and is safe to re-run.

<details>
<summary>Doing it by hand</summary>

Every MCP client reads the same shape; they differ only in where it lives.

```json
{
  "mcpServers": {
    "bg3-agent-bridge": {
      "command": "C:/Users/you/bg3-agent-bridge/bg3-bridge.exe"
    }
  }
}
```

| Client | Where that goes |
|---|---|
| **Claude Code** | `claude mcp add bg3-agent-bridge -- C:/path/to/bg3-bridge.exe`, or `.mcp.json` in the project root |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Kimi Code** | `%USERPROFILE%\.kimi-code\mcp.json` |
| **Cursor** | `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` globally |
| **Anything else** | Search its docs for `mcpServers` — that key is the common denominator |

Some clients only create their config after you configure something in the UI, so it may not exist on a fresh install — `--write` creates it.

Use `/` or escaped `\\` in paths. A single backslash is a JSON escape character and will break the file, usually without a useful error.

</details>

**Confirm it registered** before blaming the bridge — most clients list connected servers in their UI. You want `bg3-agent-bridge` with tools named `bg3_*`; if absent, the problem is the config, not the game. **Restart the client after editing config** — almost none reload it live.
</details>

## Packing Mods

This tool does not pack mods. However, your AI Agent can help pack mods through Powershell scripting and `divine.exe` from [LSLib releases](https://github.com/Norbyte/lslib/releases).

## Tools
Tools are still in active development, these are essentially shortcuts for your AI agent to understand how BG3 works and avoid wasting time/tokens on reinventing the wheel. You don't need to ask for a specific tool, your agent will use these when needed:
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
| `bg3_spawn_character` | Spawn an NPC from a character template, then despawn or clear |
| `bg3_resolve_character` | Resolve any UUID/name form to a stable identity (bare uuid, prefixed, Tav/avatar, HP, dead/downed), or list the party |
| `bg3_life` | Damage, heal, setHp, fullHeal, kill, down or resurrect a character, reporting before/after and faithfulness caveats |
| `bg3_animation` | Audition any animation, swap locomotion sets (idle+walk+run), or override the idle |
| `bg3_play_sound` | Fire a sound event to audition it, globally or at a character |
| `bg3_capture_sounds` | Record which sound events the game actually fires — "what sound was that?" |
| `bg3_eval` | Run a Lua chunk in the live game — captures prints, plain globals persist across calls (plus a `Bridge.Scratch` table and `Bridge.Osi`/`Try`/`Fields`/`Call`/`EntityFromHandle`/`Inspect` helpers), can borrow a mod's context, and can poll until a condition holds |
| `bg3_reload` | Hot-reload the Lua VM via `Ext.Debug.Reset()` — waits for the fresh handshake + ping and reports the outcome by default |
| `bg3_osiris_functions` | List the Osi function table by name filter, or probe specific names for existence |
| `bg3_vfs_probe` | Read a path through the game VFS and report the byte length served — tells pak vs loose apart |
| `bg3_entity_inspect` | List an entity's components, or dump one by name |
| `bg3_schema` | Field names and types of a component or resource, and which components on an entity are actually reachable |
| `bg3_stats_get` | Read a stat entry or a single attribute |
| `bg3_stats_set` | Write one stat attribute and sync it to clients |
| `bg3_read_log` | Read the Extender or Osiris log — pick the channel, regex-filter, or follow only new lines via cursor |
| `bg3_list_logs` | List log files grouped by game session, newest first |
| `bg3_trace_events` | Capture the ordered stream of Osiris story events, filtered by name and/or entity |
| `bg3_play_effect` | Play a visual effect by name or GUID — resolves the GUID `Osi.PlayEffect` silently demands and auto-picks looping vs one-shot |
| `bg3_stop_effect` | Stop looping effects the bridge started, by handle or character |
| `bg3_effects_near` | List placed/active effects around a character or position, nearest first (client-side truth — the server sees none) |
| `bg3_teleport` | Move the party to a level, validating the name against the real level list and confirming the region actually changed |
| `bg3_list_levels` | Every playable level name, per module, from the game's own Editor data — the names `GetRegion` and teleport use |

Environment overrides: `BG3_SE_DIR`, `BG3_LOG_DIR`, `BG3_MODS_DIR`, `BG3_GAME_DIR`, `BG3_DIVINE_PATH`.

More detail — which search hits which data layer, recipes, and the traps each tool wraps — lives in [TOOLS.md](TOOLS.md). You do not need it to use the bridge.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Windows protected your PC" / SmartScreen blocks the exe | It's an unsigned indie binary. Click **More info -> Run anyway**. (Prefer not to? Run it from a terminal instead, or build from source.) |
| Double-click flashes and closes instantly | The guided setup pauses on "Press Enter to close", so this is rare — if it happens, open a terminal in the folder and run `.\bg3-bridge setup` to see the error. |
| Agent lists no `bg3_*` tools | The config was not picked up. Re-run `.\bg3-bridge configure --write <client>`, then **fully restart** the agent app — almost none reload config live. The client's server list should show `bg3-agent-bridge` with 27 `bg3_*` tools. |
| `bg3_bridge_status` says both contexts offline | BG3 is not running, or no save is loaded. Launch the game and load a save — the bridge only answers in-game, and the `client` context in particular responds only after a save loads. |
| `.\bg3-bridge install` finds no game / fails | Close BG3 first (it rewrites `modsettings.lsx` from memory on exit). If your install is not found, set `BG3_GAME_DIR` to your Baldur's Gate 3 folder and re-run. |
| Installed, but the game ignores the mod | If a packed `Mods\...pak` for it also exists, the game serves the pak and ignores loose files — remove the pak. Make sure "BG3 Agent Bridge" is enabled in your mod manager / load order. `bg3_vfs_probe` shows which copy is live. |
| Edited Lua, but nothing changed | Ask the agent to run `bg3_reload` (loose Lua hot-reloads). Packed data — stats, templates, textures — needs a full game restart, not a reload. |
| Config path "breaks the file" | Use forward slashes `/` or escaped `\\` in JSON paths; a single `\` is an escape character. `configure --write` handles this for you. |
| Done modding | Double-click `bg3-bridge.exe` and choose **Uninstall** (or `.\bg3-bridge uninstall`), then remove the server from your agent's MCP config. |

## Legal

Ships no Larian assets and no Toolkit code. Larian's [modding terms](https://baldursgate3.game/modding-terms/) forbid redistributing the Toolkit, so the companion mod is built from source on your machine against your own install. LSLib is MIT licensed. Do not commit extracted game data — `.gitignore` covers the obvious paths.

## Contributing

Adding an operation is two small edits: a handler in `mod/Mods/BG3AgentBridge/ScriptExtender/Lua/Bridge/Handlers.lua`, and a `defineTool` call in `src/index.ts`. The mailbox handles framing, ordering, errors, and timeouts.

CLI commands live in `src/cli/`, shared by the Node wrappers in `scripts/` and the compiled exe (`src/cli/main.ts` dispatches). `npm run build:exe` rebuilds `dist/bg3-bridge.exe`; it needs `tools/bun.exe` from [Bun releases](https://github.com/oven-sh/bun/releases), which is gitignored and build-time-only. `npm run release` builds the exe and assembles `dist/bg3-agent-bridge-vX.Y.Z.zip` (exe + `mod/` + README + TOOLS.md + LICENSE), ready to attach to a GitHub release.

MIT licensed. See [CHANGELOG.md](CHANGELOG.md) for what changed when.
