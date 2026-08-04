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
- Node.js 20+
- `divine.exe` from [LSLib](https://github.com/Norbyte/lslib) (only to pack the companion mod)

## Install

**1. Build the server**

```bash
npm install && npm run build
```

**2. Pack and place the companion mod**

```bash
npm run install-mod
```

This packs `mod/` into `BG3AgentBridge.pak` in your BG3 `Mods` directory. It deliberately **does not edit `modsettings.lsx`** — rewriting a load order in place is the easiest way to break an install, so enable "BG3 Agent Bridge" in your own mod manager and export the order as usual.

Set `BG3_DIVINE_PATH` if `divine.exe` is not on your `PATH`.

<details>
<summary><strong>Testing without packing (no divine required)</strong></summary>

The engine loads loose module folders out of the game's own `Data\Mods\` directory — that is where Larian's `GustavDev` and `SharedDev` live. For development you can skip `divine` entirely:

1. Copy `mod\Mods\BG3AgentBridge` to `<BG3 install>\Data\Mods\BG3AgentBridge`
2. Add a `ModuleShortDesc` entry for it to `modsettings.lsx` (back that file up first)

Edits to the Lua then apply on the next `bg3_reload` with no repack step at all. Pack to a `.pak` when you are ready to distribute.

</details>

**3. Point your MCP client at it**

```json
{
  "mcpServers": {
    "bg3-agent-bridge": {
      "command": "node",
      "args": ["D:/path/to/BG3ToolKitMCP/dist/index.js"]
    }
  }
}
```

**4. Verify** — launch the game, load a save, then call `bg3_bridge_status`.

## Tools

| Tool | Purpose |
|---|---|
| `bg3_bridge_status` | Is the game running with the bridge loaded, and what does each context support |
| `bg3_eval` | Run a Lua chunk in the live game and get its return values |
| `bg3_reload` | Hot-reload the Lua VM via `Ext.Debug.Reset()` |
| `bg3_entity_inspect` | List an entity's components, or dump one by name |
| `bg3_stats_get` | Read a stat entry or a single attribute |
| `bg3_stats_set` | Write one stat attribute and sync it to clients |
| `bg3_read_log` | Tail the newest Script Extender / Osiris log, with regex filtering |
| `bg3_list_logs` | List available log files, newest first |

Environment overrides: `BG3_SE_DIR`, `BG3_LOG_DIR`, `BG3_MODS_DIR`, `BG3_DIVINE_PATH`.

## Known limits

**`bg3_eval` depends on a capability that is not guaranteed.** `load()` is not *documented* as exposed to mod scripts, though it was present on the build this was developed against. The mod probes at boot and reports through `bg3_bridge_status`, so if it is missing you get a clear message rather than a silent failure. Note that Script Extender's `load` takes an environment table as its second argument, not standard Lua's chunk-name string. The structured tools do not depend on any of this.

**Some objects cannot be serialized at all.** Large stat entries — spells especially — follow an inheritance chain deep enough to exceed the JSON serializer's recursion limit, and that limit *raises* rather than truncating, so a lower `depth` turns a large result into a hard error instead of a smaller one. `bg3_stats_get` on `Projectile_MagicMissile` fails this way; reading a single `attribute` from the same entry returns instantly. Prefer `attribute` and `component` over whole-object dumps.

**Round trips cost about a second.** The mod polls every 30 ticks. One poll costs Script Extender 7-9ms, enough that it is flagged as a slow event, so polling faster trades frame time for latency that agent workflows do not need.

**Hot reload only covers Lua.** `bg3_reload` reinitialises the Lua VM, so edited scripts take effect immediately. Changes to packed data — stats, root templates, localization — still need a repack and a restart.

**The loop is slower than Unity's.** The game takes about a minute to boot and needs a loaded save. Keep one instance alive and iterate against it rather than restarting per change. The `client` context only answers once a save is loaded; `server` is the right default for almost everything.

**Script Extender's API moves with game patches.** Every capability is probed at runtime rather than assumed, but a large enough patch will still need updates here.

## Legal

This ships no Larian assets and no Toolkit code. Larian's [modding terms](https://baldursgate3.game/modding-terms/) grant a non-transferable licence to *use* the Toolkit and forbid redistributing it, so the companion mod is built from source on your machine against your own install. LSLib is MIT licensed. Do not commit extracted game data — `.gitignore` covers the obvious paths.

## Contributing

Adding an operation means two small edits: a handler in `mod/Mods/BG3AgentBridge/ScriptExtender/Lua/Bridge/Handlers.lua`, and a `defineTool` call in `src/index.ts`. The mailbox handles framing, ordering, errors, and timeouts.

MIT licensed.
