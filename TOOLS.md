# Tool recipes

Detailed walkthroughs for the tools listed in [README.md](README.md#tools). You do not need this file to *use* the bridge — talk to your agent in plain English and it picks the right tool. This is the extra map: which layer of BG3 data each search hits, the recipes, and the traps the tools wrap.

Probed engine behaviour (arity traps, silent no-ops, identity, VFS) also lives in [FIELD_NOTES.md](FIELD_NOTES.md).

## Which tool for which layer

BG3 splits its data three ways, and the search tools mirror it. **Resources** (`bg3_find_resource`) are the raw asset bank — sounds, visuals, effects, animations — and give you the GUIDs the engine calls take. **Templates** (`bg3_find_template`) are world objects — items, characters, props — and carry cross-references (stat entry, visual GUID, parent template) one layer up. **Stats and static data** (`bg3_find_stat`, `bg3_find_static_data`) are the behavioural layer — statuses, spells, passives, MultiEffectInfo — and are what your mod's `Stats/` files edit. Work "what did I see → what is it called → what do I reference" in that order; `bg3_find_status_by_effect` jumps from an effect straight to the statuses that apply it. Runtime state (entities, components, live positions) is not any of these layers — that is `bg3_resolve_character`, `bg3_entity_inspect` and `bg3_schema`.

## Reading logs and tracing events
It is highly recommended to enable all logging options in the [Mod Manager's](https://github.com/LaughingLeader/BG3ModManager) Script Extender settings, this will help your agent see more and troubleshoot.
The log is the feedback channel for everything Lua and Osiris do, and it is split across channels: your mod's `print`/`Ext.Utils.Print` output and script errors land in the **Extender** log, story/rule traffic in the **Osiris** log. "Newest log overall" is usually the noisy Osiris one, so say which you mean:

```
bg3_read_log logType=extender filter="MyMod|error"     your mod's output and failures
bg3_read_log logType=extender                          returns a cursor — pass it back
bg3_read_log logType=extender cursor=96648             only lines appended since (follow mode)
```

Follow mode is the read-eval loop that used to require shell `tail`/`grep`: schedule diagnostic prints with `bg3_eval` (which also captures prints emitted during the call itself), then follow the extender log by cursor.

To see **what actually fired and in what order** — the core of most Osiris debugging — trace story events:

```
bg3_trace_events action=start                          mark the position
  … act in game, or via other bridge tools …
bg3_trace_events action=read events="Status(Applied|Removed)" entity=64de046b-...
```

Event names come from the `>>> event Name(args)` lines in the Osiris Runtime log, so this needs Script Extender's Osiris logging enabled; lines carry no timestamps, so the stream is ordered but not timed. A bare UUID matches its prefixed template-name form (`S_Player_Laezel_58a6...`) inside event arguments.

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

## Spawning NPCs

`bg3_find_template` with `templateType=character` turns a name into a template UUID, then `bg3_spawn_character` places it — beside the host character by default, beside another character with `near`, or at exact `x`/`y`/`z`:

```
bg3_find_template query="Flaming Fist" templateType=character   pick a template Id
bg3_spawn_character template=3423bf45-...                       spawn it 2m from you (action defaults to spawn when a template is given)
bg3_spawn_character action=list                                 what is tracked, still on stage?
bg3_spawn_character action=clear                                remove them all
```

**The trap this wraps is `Osi.CreateAt`'s arity.** It takes exactly 7 arguments — `(templateId, x, y, z, temporary, playSpawn, customName)` — and every shorter form fails with "No function named 'CreateAt' exists that can be called with N parameters", which never says the wanted count. The fifth argument is `temporary`, not `playSpawn` — a character meant to persist passes 0, while `bg3_preview_item` passes 1 so the engine treats its gear as disposable.

A spawn is written into the save, so the tool tracks what it created: `despawn` removes one (`Osi.SetOnStage(id, 0)` offloads rather than destroys, and `Osi.IsOnStage` is the check that matters — the entity id stays valid off-stage), `clear` removes all. A `bg3_reload` wipes the tracking list while the characters persist, so clear *before* reloading.

## Auditioning animations and overriding the idle

`bg3_animation` covers three jobs: `action=find` resolves a name ("flying kiss") to its `AnimationShortName` GUID, `action=play`/`loop` fires it on a character, and `action=idle` replaces the idle animation with a still-animation state:

```
bg3_animation action=find query="flying kiss"        name → GUID
bg3_animation action=play animation="flying kiss"    one-shot on the host character
bg3_animation action=idle stillType=Dazed            idle becomes the drunk sway
bg3_animation action=clear                           restore everything
```

**`Osi.PlayAnimation` resolves only the bare GUID.** The reference form the game displays everywhere else — `5f127742-79d4-4590-839f-6eb5ae45930d(REAC_Magic_External_Combat_01)` — is a silent no-op when passed to `PlayAnimation`; the `(name)` suffix must be stripped (the tool does this for you). **`Osi.PlayLoopingAnimation` looks dead but isn't**: arities 2-6 all fail with "No function named", and the true signature is **eight arguments** with the animation reference in position 3 — `PlayLoopingAnimation(character, "", guid, "", "", "", "", "")`. It loops `Looping=false` animations continuously and holds statue poses indefinitely; movement is blocked while one runs, and crouching breaks it one-way. End one with `Osi.StopAnimation(character, 1)` — the second argument is the animation channel, a number, which is why passing an animation name errors with "Number expected for argument 3". (The bogus-name `PlayLoopingAnimation` the Emotes mod fires in one ping handler is a pose interrupt, not a general cancel — tried as one, the loop kept running.) The looping-call signature comes from the source of the [Emotes mod](https://www.nexusmods.com/baldursgate3/mods/4744) by claravel — `action=loop`/`stop` wrap exactly these calls.

**The strongest override is `action=animset`.** A status's `DynamicAnimationTag` field, pointing at an `AnimationSetPriority` entry (~100 registered sets: `Zombie`, `on_all_fours`, `Bladesong`, crowd sits and staggers), swaps the character's *entire locomotion set* — idle, walk and run — through the same channel RAGE uses, so movement is never blocked. When a clean status already carries the tag it is used directly; otherwise the tool live-edits the tag onto the carrier and restores it on `clear`. This is how animation-replacement mods actually work: the On All Fours Toggle mod ships no animation data at all — a toggleable passive applies a hidden status whose tag selects the base game's own quadruped set. Custom sets need a pak registering an `AnimationSetPriority` (name + GUID + priority) plus the GR2s; custom *animations* need only the FFMegaPosePack recipe — GR2 files plus name+UUID rows in `Animation/ShortNames.lsx` make them callable by `play`/`loop` immediately.

**The persistent idle override is a status trick.** Idle ("still") animations are selected by a status's `StillAnimationType` enum — about 29 states (`Dazed`, `Dancing`, `Feared`, `Laughing`, …), `action=list` shows them with the statuses that carry each. `action=idle` live-edits the field on a *clean carrier* — a status with no Boosts and no RemoveEvents, so the override brings no mechanics — and applies it; it re-asserts every time the character stops moving (DRUNK proves the pattern in vanilla). Two traps: PERFORM_* statuses are performance *sessions* that movement cancels, not idle overrides; and a still type with no art for the character's race freezes them mid-pose instead of falling back — audition on the target character.

**There is no way to make an arbitrary *animation* the idle — but `animset` covers registered *sets*.** The status `AnimationLoop` field (Hold Person's freeze) is ignored on BOOST-type statuses — probed with a correctly formatted reference, nothing played — so single-animation idle replacement is limited to the `StillAnimationType` enum. And the packed-data route is narrower than it looks: shipping a GR2 at the base idle's exact virtual path (`<RIG>_ST_IDLE_Still_Peace_01.GR2`) in a mod pak does **not** shadow it — tested with a mounted pak (loadIndex 19, last in order); the engine kept the base resource (`IsModded=false`, base duration). What mods do instead is register an `AnimationSetPriority` and switch to it with a status tag — see above — which replaces idle *and* walk with no movement penalty.

**Photo-mode poses cannot be frozen at an arbitrary frame outside photo mode.** A pose is not a resource — it is a Timing marker inside a parent animation (`PhotoModeEmotePose` maps pose → `AnimationShortName` + frame point), and holding one at mid-animation needs the animation graph paused, which nothing exposes: `Osi.Freeze` is a story-event control lock, not an animation hold; the `AnimationWaterfall` components carry no speed/pause field; and the Animation resource's `Offset` is live-writable but setting it past 0 silences playback rather than seeking. What works live is `action=loop` on the pose's parent animation (e.g. `PM_PowerRangers_01` = "Fighting Crime"): for statue-style parents the engine loop simply *holds the pose*, which is how the Emotes mod's pose spells work.

**A held pose still fails as an idle replacement.** The loop blocks movement input outright, so a movement watcher cannot see motion to cancel on; the only release is crouching (sneak breaks the loop one-way), and a stop-watcher can re-apply the pose after — tried exactly this, and it works mechanically but means crouching before *every* walk, which is too much friction for an idle. It is a workable *mechanic* though: a character forced into a looped pose the player must crouch out of each time (exhaustion, curses, possession) is achievable with a dozen lines of Lua.

Everything `bg3_animation` changes is session-only by design: runtime stat edits and applied statuses die with a `bg3_reload` or save reload, and `action=clear` restores the carrier's original `StillAnimationType` immediately.

## Character identity, and testing death and downing

BG3 character identity is a minefield, so resolve it rather than guess. `Osi.GetHostCharacter()` returns a **bare** UUID and follows *control* — it moves to a companion when the avatar is downed and does not revert on resurrect — while Osiris events deliver **prefixed** template-name forms (`Elves_Female_High_Player_<uuid>`) that fail bare-string equality. `bg3_resolve_character` takes any of those forms (or a display name) and returns the bare uuid, the prefixed form, the display name, whether the entity is the player-created Tav (the `AvatarComponent`, stable across control and death), whether it is host-controlled right now, HP, and dead/downed state:

```
bg3_resolve_character                       resolve the host character
bg3_resolve_character action=party          every party member with life state
bg3_resolve_character id="Shadowheart"      resolve by display name
```

`bg3_life` drives health and life state for testing. `damage`/`heal`/`setHp`/`fullHeal`/`kill` set HP via `Osi.SetHitpoints` (verified present against the live game — enumerate with `bg3_osiris_functions query="hitpoint"`), falling back to a `HealthComponent.Hp` write + replicate when it is unavailable, and every action reports before/after HP plus dead/downed state after a short settle window (so an ineffective queued call surfaces as `after != target`, not a false success). Setting HP is still **not** a damage/attack event — no attacker, damage type or hit reaction — so combat and death triggers can differ from a real hit (a raw write to 0 in particular can leave a "limbo death" inside a scene that a cutscene/scene-manager mod has suppressed). Each mutating action therefore carries a `caveat` and a `method`, and you should validate real death logic with an in-game hit. `down` applies the DOWNED status; `resurrect` uses `Osi.Resurrect` when present:

```
bg3_life                                     read HP + dead/downed for the host
bg3_life action=kill character=<uuid>        zero HP, then report the settled state
bg3_life action=down character=<uuid>        apply DOWNED
```

## Confirming a reload, and pak vs loose

`bg3_reload` now waits by default and confirms the reload without depending on logging: it records the handshake file's timestamp, triggers `Ext.Debug.Reset()`, waits for `Bridge.Start` to rewrite that handshake (the definitive "VM rebooted" signal), then pings the fresh VM and returns `{reloaded, rebooted, responsive, durationMs, capabilities}`. A Lua syntax error in a reloaded script stops `Bridge.Start`, so the handshake never advances and this correctly reports `reloaded:false`. Pass `wait=false` for fire-and-forget.

When a `.pak` and loose files both exist, the game binds the module to its **pak** — "loose overrides pak" does *not* hold, and a new loose file is invisible until restart because the VFS loose index is built at boot (Lua hot-reload is the exception). `bg3_vfs_probe` reads a path through the game VFS and reports the byte length served, the decisive tell for which physical copy is live:

```
bg3_vfs_probe path="Mods/BG3AgentBridge/ScriptExtender/Lua/BootstrapServer.lua"
```

## Discovering Osiris functions

Osiris function names are guessable and wrong as often as not. `bg3_osiris_functions` enumerates the live `Osi` table (`action=list`, ~1303 names on SE v32) filtered by substring, and probes specific names for existence (`action=probe`) — SE's own error text distinguishes a known name at the wrong arity from one that does not exist. It confirms existence, not the correct arity; only a real call settles a signature (`bg3_eval` makes that cheap):

```
bg3_osiris_functions query="damage"                          every Osi name containing "damage"
bg3_osiris_functions action=probe names=["ApplyDamage","Die","Resurrect"]
```

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

The files this section discusses ship in `ReferenceLua/` next to the executable: the three BG3ModdingTools-generated files (MIT, attributed in `ReferenceLua/`), which `bg3_osiris_functions action=signature` parses, plus an `ExtIdeHelpers_v32.lua` generated by SE on this machine for `Ext.*` coverage. See `ReferenceLua/README.md` for provenance and refresh instructions.

The engine behaviours these tools wrap — arity traps, silent no-ops, identity shifts, binary layouts — are collected in [FIELD_NOTES.md](FIELD_NOTES.md), probed against the live game across several agent-driven sessions.

## Known limits

**`bg3_eval` depends on a capability that is not guaranteed.** `load()` is not *documented* as exposed to mod scripts. The mod probes at boot and reports through `bg3_bridge_status`, so a missing `load` is a clear message, not a silent failure. SE's `load` takes an environment table as its second argument, not a chunk-name string. The structured tools do not depend on any of this.

**Some objects cannot be serialized.** Large stat entries follow an inheritance chain deep enough to exceed the JSON recursion limit, and that limit *raises* rather than truncating — a lower `depth` turns a large result into a hard error. `bg3_stats_get` on `Projectile_MagicMissile` fails this way; a single `attribute` from the same entry returns instantly. Prefer `attribute` and `component` over whole-object dumps.

**Pak-defined resources that have not loaded cannot be enumerated.** `Ext.Resource.GetAll`/`Get` see only resources the game has already loaded, and SE exposes no force-load and no reader for pak resource *definitions*, so `bg3_find_resource` is loaded-only by necessity. Templates and static data are the exception — those banks are fully enumerable, so `bg3_find_template` and `bg3_find_static_data` reach pak-defined entries.

**Round trips cost about a second.** The mod polls every 30 ticks; one poll already costs SE 7-9ms, flagged as a slow event. Polling faster trades frame time for latency agents do not need.

**Three tiers of change, only one of which is fast.**

| Change | To apply it |
|---|---|
| Mod Lua | `bg3_reload` — about 1.5s |
| Packed data (stats, root templates, localization) | Repack and restart the game |
| Load order (`modsettings.lsx`, adding a pak) | Restart the game — **and** see the hazard below |

Reloading a *save* applies none of these — it re-reads the save, not the module list. Worse, the game rewrites `modsettings.lsx` on exit from its in-memory load order, silently discarding entries added while it was running. Edit that file with the game closed, and confirm what mounted with `bg3_list_mods`.

**Hot reload is not per-context.** `Ext.Debug.Reset()` restarts **both** server and client VMs whichever context asks — all in-memory Lua state goes with it, including `bg3_stats_set` edits. The `context` argument picks the transport, not the scope.

**`bg3_eval` does not run inside your mod's sandbox.** Chunks compile into the default global table: `Ext`, `Osi`, `Mods` are reachable, your mod's bare globals are not — `PersistentVars` in particular is the bridge mod's (nil), since SE scopes it per mod. Reach mod state through `Mods.<ModTable>.PersistentVars`, or pass `modContext="<ModFolder>"` to run the chunk with that mod's `PersistentVars`/`ModuleUUID` swapped in.

**The loop is slower than Unity's.** The game boots in about a minute and needs a loaded save — keep one instance alive and iterate against it. `client` only answers once a save is loaded; `server` is the right default for almost everything.

**Script Extender's API moves with game patches.** Every capability is probed at runtime rather than assumed, but a large enough patch will still need updates here.

**Story flags: the arity trap.** Runtime flag names are `<StaticName>_<ResourceUUID>` (e.g. `LOW_HouseOfHope_State_GaveBodyToIncubus_54fb1ca4-…` — the static entry's `Name` plus its `Guid`; `bg3_flag action=find` resolves them). `GetFlag` is 2-arity `(flag, objectGuid)`, and object-bound flags return NO ROW for the zero-GUID query — "no row" and "unset" both read as 0. `SetFlag`/`ClearFlag` want exactly 4 arguments: `(flag, objectGuid, dialogInstance, sendFlagSetEventIfChanged)` — the 2-arity overload BINDS and silently no-ops (no FlagSet event, readback unchanged), which reads exactly like "flags are read-only from Lua". The object must be a real character: the host works even for global-ish debug flags, the zero-GUID object does nothing. With that recipe flags set fine — including Larian's own debug jump-start chain (`DBG_Act3_Setup_Good/Neutral/Evil`, `Debug_Teleport_Act3Start`, `END_General_Debug_GoToAct3`, found via `bg3_find_static_data type=Flag query=act3`): setting them made the story set `Act3_Visited` itself, spawn setup actors, and a House-of-Hope teleport then landed in a real, rendering level. Two caveats from the same test: the default entry point can be hostile (the character dropped straight into a chasm — anchor afterwards), and mid-load position reads can be stale (the party briefly looked "teleported back"). `bg3_flag` handles the arity, the name form and the readback verification; a raw `Osi.SetFlag(flag, char, 0, 1)` from eval works too.

**Osiris signatures live in ReferenceLua/.** The Script Extender's generated `Osi.lua` (plus `Osi.Events.lua`, `ExtIdeHelpers.lua`) lists every function's declared parameters and overload arities — the answer to "how many arguments does X take" that probing alone took a session to discover (`SetFlag`'s 4th argument is `sendFlagSetEventIfChanged`). Keep the folder next to `bg3-bridge.exe` (repo root when running from source); `bg3_osiris_functions action=signature names=["SetFlag"]` reads it, and works with the game closed. Without it, the action explains where to put the files. Signatures are the map, not a guarantee — the SE proxy can still reject or silently no-op an overload form, so confirm critical calls with a probe or a real invocation.

