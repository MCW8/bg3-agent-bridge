# Field Notes

Findings from agent-driven sessions against a live Baldur's Gate 3 — a long mod
debugging/refactor session, an effect-hunting and teleporting session, and an
asset/localization mining session. Everything here was observed in-game through the
bridge (Script Extender v29-v32), not read from documentation. It is kept because each
line cost real time to discover, and because most of it is the kind of relationship
knowledge — *this overrides that, that is suppressed by this, this identity shifts* —
that no reference dump carries.

Where a finding has since been wrapped or fixed by a tool, the tool is named. The
sessions themselves are described generically; only the engine behaviour is interesting.

---

## Osiris: arity traps and silent no-ops

The single most expensive class of bug. Osiris calls are queued story calls behind a
lazy proxy: a wrong argument count usually errors, but a *wrong overload* frequently
binds, returns success, and does nothing.

| Call | Real shape | Trap |
|---|---|---|
| `Osi.CreateAt` | exactly 7: `(template, x, y, z, temporary, playSpawn, customName)` | every shorter form fails with "No function named 'CreateAt' exists that can be called with N parameters", which never says the wanted count; the 5th argument is `temporary`, not `playSpawn` |
| `Osi.SetFlag` / `Osi.ClearFlag` | exactly 4: `(flag, object, dialogInstance, sendFlagSetEventIfChanged)` | the 2-arity overload **binds and silently no-ops** — no `FlagSet` event, readback unchanged. Reads exactly like "flags are read-only from Lua" |
| `Osi.GetFlag` | 2: `(flag, object)` | object-bound flags return NO ROW for a zero-GUID query, and "no row" reads identically to "unset" (0) |
| `Osi.TeleportPartiesToLevelWithMovie` | 3: `(levelName, event, movie)` | empty strings are fine for the last two; wrong counts error, wrong *level name* succeeds and strands the party |
| `Osi.TogglePassive` | 2: `(character, passive)` | the 3-param call errors |
| `Osi.PlayAnimation` | bare `AnimationShortName` GUID | the display form `<guid>(NAME)` is a silent no-op |
| `Osi.PlayLoopingAnimation` | 8 args, animation reference in position 3 | arities 2-6 all fail with "No function named", so the function looks dead |
| `Osi.ApplyDamage` | accepted 3 params without error | produced no observable damage; the 2-param form raised an arity error. There is no working generic damage verb |
| `PlayExternalSound` | 4 args `(soundObject, eventName, path, codec)` | `soundObject` must be a built-in name such as `Global`; a character UUID yields `Unknown built-in sound object name: <garbage bytes>` |
| `Osi.RemoveCustomVisualOvirride` | spelled with Larian's typo | the misspelled name is the one bound at runtime |

Absent entirely (probed, not assumed): `Osi.Damage`, `Osi.Die`, `Osi.SetHitpoints` on
older builds, `Osi.GetHostLevel`, `Osi.GetCurrentLevel`, `Ext.Entity.GetLevel`,
`Ext.Utils.Base64Encode`. `Osi.SetHitpoints` and `Osi.Resurrect` *are* present on SE v32.

Three rules fall out of the table:

- **`pcall` success proves nothing.** `pcall(Osi.Fn, ...)` routinely returns `ok=true`
  with a `nil` result while the game state is untouched — a bad level name, a wrong
  UUID, a no-op overload all look like success. Always verify post-state
  (`GetHitpoints`, `IsDead`, `GetRegion`, a flag readback), never the return path.
  `bg3_eval`'s `Bridge.Osi(name, ...)` now returns `{exists, ok, err, result}`, which
  separates the three outcomes `pcall` collapses into one.
- **`type(Osi.X) == "function"` is false for every Osi entry.** They are userdata behind
  a proxy that resolves lazily, so a type check will convince you a working function is
  missing. Use `type(Osi.X) ~= "nil"` — and note the proxy returns a placeholder for
  missing names whose comparison to `nil` itself *raises*, so existence is best
  classified from a guarded call's error text ("attempt to call a nil value" = missing,
  any other error = exists but failed). `bg3_osiris_functions action=probe` does this.
- **Signatures were documented all along.** The Script Extender's generated
  `Osi.lua` / `Osi.Events.lua` carry every declared parameter and overload arity;
  `bg3_osiris_functions action=signature` parses them (983 functions, 320 events) and
  works with the game closed. Signatures are a map, not a guarantee — the proxy can
  still reject or silently no-op an overload form — but reading one beats a session of
  guessing. Existence data proved exactly trustworthy against `pairs(Osi)`; declared
  signatures did not (optional parameters are inexpressible in the generator's output).

Osiris calls are also **forbidden during `Ext.Events.SessionLoaded`** dispatch
("Attempted to call Osiris function in restricted context"). Defer with
`Ext.Timer.WaitFor`, or do Osiris-dependent init on the `LevelGameplayStarted` listener.

### Event names and arities

| Event | Shape | Note |
|---|---|---|
| `Equipped` / `Unequipped` | `(item, character)` | not `ItemEquipped`; item comes first. Wrong name or order = a handler that never meaningfully fires |
| `AttackedBy` | arity 7 | |
| `DialogStarted` | arity 4 `(dialog, instanceId, speaker1, speaker2)` | |
| `DialogEnded` | arity 2 | |
| `FlagSet` | arity 3 | a 4-arity listener hears nothing |

Registering listeners on every `LevelGameplayStarted` without unregistering the previous
ones produces **duplicate handlers** across level transitions; track subscription ids.

Seeing *what actually fired and in what order* was the fastest path to truth in every
hard diagnosis — originally by grepping `>>> event Name(args)` lines out of the Osiris
Runtime log around a UUID, now `bg3_trace_events`. Those log lines carry no timestamps,
so the stream is ordered but not timed, and a bare UUID matches its prefixed
template-name form inside event arguments.

---

## Identity and entities

- **Two UUID string forms, and they are not interchangeable.**
  `Osi.GetHostCharacter()` returns a **bare** UUID; `DB_Players`, `DB_Origins` and all
  Osiris events deliver **prefixed** template-name forms
  (`Elves_Female_High_Player_<uuid>`, `S_Player_Laezel_<uuid>`). Osiris string equality
  fails across forms, so a handler that stores the host and compares it against an
  event's character argument silently never matches. `Ext.Entity.Get` accepts either.
  `bg3_resolve_character` normalises all of it.
- **`GetHostCharacter()` follows control, not the avatar.** When the avatar is downed or
  killed the engine hands control to a companion, `GetHostCharacter()` returns that
  companion, and it does **not** revert after resurrection. For a stable "who is the
  player character" identity, key on the `AvatarComponent` (`eoc::user::AvatarComponent`
  / `eoc::tag::AvatarComponent`), which stays on the player-created character regardless
  of control or death; companions have neither. `bg3_resolve_character action=host`
  reports control-holder and avatar separately whenever they differ.
- **Iterating entities:** `Ext.Entity.GetAllEntitiesWithComponent('ServerCharacter')`
  yields entity objects on which `Ext.Entity.HandleToUuid(e.Handle)` fails; `e.Uuid.EntityUuid`
  works. Reliable identity primitives when everything else is uncertain: `Osi.Exists`,
  `Osi.GetName`, and `entity.ServerCharacter.Template.Name`.
- **Handle strings do not round-trip.** `tostring(entity)` prints
  `Entity (02000001000034ae)`, but `Ext.Entity.Get` rejects that string ("not a valid
  GUID value"), `HandleToUuid` wants the C++ handle object, and `Ext.Types.Construct`
  refuses `EntityHandle` ("non-object type"). Originally this forced inline inspection
  during the same iteration — a two-phase "list then inspect" workflow simply breaks for
  handle-only entities such as placed effects. `bg3_entity_inspect` and
  `Bridge.EntityFromHandle` now accept both the full and bare 16-hex forms, resolving
  through a `GetAllEntities` scan (159 k entities client-side, cheap). A character
  spawned in the current tick may not be scannable until the next one.
- **Component and field names are guessed wrong constantly**, and each miss only
  surfaces at runtime: `resource::VisualResource::Name` and `AnimationResource::Name` do
  not exist (use `.SourceFile`); `HealthComponent.TempHp` is really `.TemporaryHp` /
  `.MaxTemporaryHp`; `e.StatusManager` raises where `e.StatusContainer` (`eoc::status::ContainerComponent`,
  field `Statuses`) succeeds. Worse, `e:GetAllComponents()` and `e:GetAllComponentNames()`
  **disagree** — the former missed `AvatarComponent`, the latter listed it — and a
  listed name is no guarantee property access works. `bg3_schema` returns the union with
  an `accessible` flag per row, plus field names, types and scalar previews.
- **Whole-component dumps exceed the JSON recursion limit** ("Recursion depth exceeded
  while stringifying JSON"), and the limit *raises* rather than truncating, so a lower
  depth turns a large result into a hard error rather than a partial one. Prefer a single
  attribute or component; `bg3_eval` now re-encodes unencodable results as depth-capped
  `Bridge.Inspect` snapshots with a `degraded` flag.

---

## Spawning

`Osi.CreateAt` needs a **root template** UUID. Given a story character-*instance* UUID —
the form `DB_Players` and Osiris events hand you — it returns success and spawns
nothing. `Ext.Template.GetRootTemplate` and `GetTemplate` both return `nil` for an
instance UUID, which is a usable "this is not spawnable" signal; `bg3_spawn_character`
validates this up front, names which case failed, and reports `confirmed` — whether a
live entity actually exists at the returned id.

Bulk spawning is not free: a 21-spawn burst plus a full animations-table scan left the
**server context unresponsive** for a while, and a smaller burst briefly froze the game.
Spawns are now spaced ~300 ms apart at the tool layer.

A spawn is written into the save, so cleanup matters: `Osi.SetOnStage(id, 0)` offloads
rather than destroys (the entity id stays valid off-stage, and `Osi.IsOnStage` is the
check that matters), and a `bg3_reload` wipes the tool's tracking list while the
characters persist — clear *before* reloading, or you orphan immortal test NPCs.

---

## Effects

- **`Osi.PlayEffect` takes the Effect resource's GUID and silently no-ops on the effect
  *name*.** This cost real time before anyone noticed the name was simply being dropped.
  `bg3_play_effect` resolves a name against the Effect bank first and refuses to fire on
  an unresolved name.
- **`Osi.PlayLoopEffect` returns a handle only for looping effects**; non-looping
  ("Overlay"-type) resources return a `nil` handle and must go through `PlayEffect`. The
  resource's `Looping` flag is the thing to read before choosing — `bg3_play_effect` now
  picks automatically and tracks looping handles for `bg3_stop_effect`. `StopEffect` does
  not exist; `StopLoopEffect` does. Bind bone `Dummy_Root` worked for body FX on every
  race tried.
- **Placed effect entities are only enumerable from the client context.**
  `Ext.Entity.GetAllEntitiesWithComponent("Effect")` plus `e.Effect.EffectName` finds
  them client-side; the server context sees *none* of them at the same spot (only
  inventory items), so an agent defaulting to server will confidently conclude "there is
  no effect here". This is exactly the wrong conclusion one session reached before
  switching contexts. `bg3_effects_near` always runs client-side.
- Working backwards from an appearance you cannot name goes
  **`MultiEffectInfo` → status → wear it**: a status is almost never named after how it
  looks, and candidates are cheap to try (`bg3_find_status_by_effect`,
  `bg3_preview_status`).

---

## Audio

- `Ext.Audio` is write-only. The engine's `SoundRoutingSystem` exposes a queue of
  `SoundPostEventRequest`s readable from a tick handler (`bg3_capture_sounds`), but
  expectations should stay low: testing against jumping and repeated spell casts
  produced only `Shake_Rumble_Start`/`_Stop`. It is an impact/shake detector, not an
  audio observer.
- **`posted: true` does not mean anything was audible.** Most game sounds are
  positional; fired at a built-in sound object they play nowhere near the listener. Many
  foley events are additionally gated on Wwise **switches** (surface material, character
  size) and resolve cold to a faint click or silence. A point-and-click reaction bark
  event posted and loaded successfully while producing no sound at all for the user.
- There is no way to play a specific numeric source `.wem` through a normal sound event —
  switch containers pick a variation. `PlayExternalSound` is the external-source path
  (see the arity table); `AudioCodec.Vorbis = 4`, learned by iterating `Ext.Enums.AudioCodec`
  by hand.
- **Error messages that reveal expected types are a discovery tool.** `Param 4: expected
  integer, string or enum label of type 'AudioCodec'` is how `PlayExternalSound`'s
  signature got reverse-engineered without documentation.
- Sounds attached to a spell are stat fields and trivially swappable
  (`CastSound`, `PrepareSound`, `PrepareLoopSound`). Engine-driven movement foley is not:
  layering a sound from Lua is easy, *replacing* foley means rebuilding a soundbank.

---

## Animation

- **There is no single "idle" slot.** The engine cycles roughly 17 idle slot GUIDs
  (still-peace variants, combat stills, random flavours, a neutral transition) and
  resolves them inside about 36 weapon-state subset buckets. Overriding one slot in one
  bucket falls back to vanilla within ~2 seconds; a real idle replacement must cover
  every slot in every bucket.
- An override is an **`AnimationSet` resource** (shipped empty in the pak, filled at
  runtime by cloning a well-formed donor `AnimationDesc` and pointing its `.ID` at your
  clip) plus an **`AnimationSetPriority`** entry, where a higher integer wins.
- **Attachment is runtime-only** and goes through a community animation-framework mod's
  template override API (`Mods.BG3AF.TemplateAnimationSetOverride.Get(uuid):AddSet(...)`),
  which also **replicates to clients** — a raw server-side component write renders
  nothing. Because attachment is runtime-only, `StatusApplied` does not re-fire after a
  save load; re-attach on `LevelGameplayStarted` for anyone still carrying the marker.
- **A `DynamicAnimationTag` alone does nothing.** It only prioritises sets already
  attached.
- **A mod's internal animation "name GUID" is not the engine `Animation` resource GUID.**
  The real, loadable GR2-backed resource is found through its `SourceFile` path, not the
  mod's own id.
- The practical, session-only levers are wrapped by `bg3_animation`: play/loop by name,
  swap the whole locomotion set through a status's `DynamicAnimationTag`, or replace the
  idle by live-editing `StillAnimationType` on a clean carrier status. A still type with
  no art for the character's race freezes them mid-pose instead of falling back, so
  audition on the actual target.

---

## Statuses and the death pipeline

- `StatusType "BOOST"` with `RemoveConditions "EMPTY"` is a pure timer that never
  auto-removes — Lua-managed by design. `StackId` plus `StackType "Overwrite"` gives a
  single instance whose duration refreshes on re-apply. Useful `StatusPropertyFlags`:
  `LoseControl` (the actual difference between "incapacitated" and "controllable"),
  `IgnoreResting`, `DisableCombatlog`, `DisablePortraitIndicator`, `DisableOverhead`,
  `ApplyToDead`.
- **Engine saving throws race scripted ones.** With `RemoveEvents "OnTurn"` plus
  `RemoveConditions "SavingThrow(...)"`, the engine removes the status on a successful
  save *before* the Osiris save-result event fires, so a `StatusRemoved` handler cannot
  distinguish "saved" from "expired". The robust shape is to strip every engine save
  condition and roll saves in Lua at known lifetime boundaries, setting a flag before
  manual removal.
- `GetStatusCurrentLifetime` returns one value per 6 s turn in combat but counts down in
  **real seconds out of combat** — timers behave differently in and out of encounters.
- **`DownedStatus(<status>,<priority>)` as a boost intercepts NPC death.** A status with
  `Boosts "DownedStatus(KNOCKED_OUT,5)"` makes the bearer drop to `KNOCKED_OUT` at 0 HP
  instead of dying, and it works on NPCs, who normally have no downed state. Verified: a
  spawned creature survived a lethal Magic Missile and ended at `dead=0, hp=0,
  KNOCKED_OUT`. Same family as Death Ward / Relentless Endurance
  (`DownedStatus(DEATH_WARD_DOWNED,10)`).
- Normal flow at 0 HP is `DOWNED` → death saving throws → `DYING` → `Died`, and statuses
  without `ApplyToDead` are stripped when the character goes down. The **vanilla
  incapacitation rule also strips mod statuses on downing** — observed removing a custom
  status — and it can fire *before* your own handler, reordering cleanup assumptions.
- **An HP write is not combat damage.** Writing `Health.Hp = 0` plus
  `Replicate("Health")` produces a health-change event the engine processes once any
  suppressors clear; a real combat kill produces no further event, so the engine never
  retries the downing on its own. A test harness that zeroes HP will therefore *not*
  reproduce the real failure mode — a genuine trap, and one that nearly sent a session
  down the wrong path. `bg3_life` wraps damage/heal/setHp/kill/down/resurrect, prefers
  `Osi.SetHitpoints`, reports before/after across a settle window (so an ineffective
  queued call surfaces as `after != target`), and carries an explicit faithfulness
  caveat per action. Validate real death logic with a real hit.
- **Scene-manager and cutscene mods can suppress the death pipeline entirely.** With a
  disable-AI status plus `SetCanJoinCombat(0)` applied, a killing blow leaves the
  character at 0 HP standing, with no `DOWNED`/`DYING`/`Died` and no event at all — and
  Death Ward never triggers, for the same reason. `Osi.ApplyStatus(char, "DOWNED", ...)`
  only sticks once the scene is gone and the suppressing status is absent; applied
  earlier it is rejected (`StatusAttemptFailed(DOWNED)` in the log) or clobbered by an
  **asynchronous** entity reset. Poll and retry until it lands.
- **`SetDetached(1)` makes an entity untargetable**, and it is far more reliable than
  resistance or invulnerability: the engine's AoE/splash/hit sweep skips detached
  entities entirely, so they take no hits and play no stagger reaction. An entity reset
  restores `SetDetached(0)`.
- **`DetachFromPartyGroup` makes a party member uncontrollable**, and an entity reset
  restores statuses, boosts, detach and combat state but does **not** call
  `AttachToPartyGroup` — that is on you. `AttachToPartyGroup` is a no-op at
  `SessionLoaded` (the party-group system is not live yet); defer ~1500 ms after level
  load.

---

## Visuals

- **A `CharacterVisual` is a shared C++ template reference.** Editing its `Body` or
  `Footwear` slot `VisualResource` changes **every NPC** using that template (template
  bleed). `Osi.Unequip` changes the stat/inventory item but not the visual.
- Per-entity appearance is the **CCA** layer (`CharacterCreationAppearance.Visuals`),
  stacked on top. After changing either, `entity:Replicate("CharacterCreationAppearance")`
  and `entity:Replicate("GameObjectVisual")`.
- **There is no in-place visual swap.** Writing an equipped item's `GameObjectVisual`
  changes the value and renders nothing; `Osi.AddCustomVisualOverride` has no visible
  effect on equipment. Transmog mods equip a *different item* — spawn the good-looking
  one, copy the original's stats onto it, wear that (`bg3_preview_item` does the light
  version, and the preview is a real item with real stats, so previewing plate over
  leather genuinely changes armour class).
- Larian child NPCs are reliably detected by `_CHD_` in the Head-slot visual
  `SourceFile`. The `CHILD` tag is not reliable.

---

## Levels, regions and teleporting

The biggest sharp edge of any session, and the one that actually stranded a player.

- **Level name is not region name is not trigger name.** The playable level name is the
  **folder name** under `Data/Editor/Mods/<Module>/Levels/<name>` — loose in a stock
  install, verified complete at 596 levels across 15 modules. Teleporting to a
  region/trigger name instead returns `ok=true` and drops the party into an unloaded
  blue void.
- **`Osi.GetRegion(host)` is the only reliable "where am I".** `Osi.GetHostLevel`,
  `Osi.GetCurrentLevel` and `Ext.Entity.GetLevel` are all absent (probed). `GetRegion`
  returns exactly the level-folder name.
- **Loads are asynchronous.** `TeleportPartiesToLevelWithMovie` returns immediately while
  the level streams in over ~15-25 s, so only a *polled region change* is an honest
  success. `bg3_teleport` validates the name against the real level list, calls the
  3-argument form, and confirms arrival by polling `GetRegion`; `bg3_list_levels`
  enumerates the names.
- **Geometry can load without the story having populated it.** Teleporting far outside a
  save's story progress renders as an empty world; running the base game's own debug
  jump-start flag chain first made the same level load for real. Two measurement lessons
  came with that: a nearby-character count is *informational*, not a hollowness verdict
  (level entry areas are legitimately quiet while streets a minute's walk away are
  full), and the arrival point is the level's **default entry**, not a story-safe spawn —
  one test dropped the character straight into a chasm. Anchor to a known
  character/position afterwards when a level has scripted entry flow. A single position
  read taken mid-load also made one teleport look like it had bounced; it had not.

---

## Story flags

Dialog-granted story flags are what a lot of mods key off, and they were the single most
misleading surface probed — the arity trap above made them look read-only from Lua.
A modder's working console call is what disproved that conclusion.

- Runtime flag names are `<StaticName>_<ResourceUUID>`, while the static data only
  carries the short form. Object-bound flags return **no row** for a zero-GUID `GetFlag`,
  and no row is indistinguishable from unset.
- The object argument must be a **real character**. The host works even for global-ish
  debug flags; the zero-GUID object does nothing.
- `bg3_flag` accepts either name form, resolves short → runtime against the ~26 k flag
  declarations, and verifies set/clear by readback rather than trusting the call —
  reporting honestly when the silently-no-opping form is hit.

---

## Mod loading, contexts and persistence

- **When a pak and loose files both exist, the game binds the module to the pak.** Proven
  by served content length through `Ext.IO.LoadFile`: loose files were only served after
  the pak was removed. "Loose overrides pak" does not hold for BG3 modules.
  `bg3_vfs_probe` reports the byte length actually served, which settles it.
- **The VFS loose-file index is built at boot.** A loose file created while the game runs
  is invisible to `Ext.IO.LoadFile` until restart. Lua is the exception — an SE reset
  re-reads script files straight from disk.
- The game's `Data/` scanner **ignores junctions inside `Data/`**. Junctions pointing
  from elsewhere *into* Data content are fine, because the target is a real directory.
- **Paks are locked while the game runs** (memory-mapped): copying over a deployed `.pak`
  fails with os error 32. Any deploy automation must wait for the game to exit, and any
  change to packed data — stats, root templates, animation sets, textures, localization —
  needs a full restart, not a reload.
- **`meta.lsx` dependency parsing is strict.** `Ext.Mod.GetMod(uuid).Dependencies` only
  populates when `<node id="Dependencies">` is a *sibling* of `ModuleInfo` (a direct
  child of `root/children`; nested inside `ModuleInfo/children` is silently ignored) and
  each `ModuleShortDesc` carries full attributes (Name / Folder / UUID / Version64 / MD5).
  Bare-UUID entries do not register.
- **Runtime-created passives cannot be granted.** `Ext.Stats.Create` passives register in
  the stats DB but not in the Osiris passive table: `Osi.AddPassive` reports success while
  `Osi.HasPassive` stays 0 forever. Static passives (`.txt` under
  `Public/.../Stats/Generated/Data/`, loaded at ModuleLoad) grant fine. Probed against a
  known static passive versus a runtime one.
- **`StatsFunctors` fields reject direct assignment.** `item.ToggleOnFunctors = "..."`
  fails silently apart from a log line (`Inappropriate type: StatsFunctors`); use
  `item:SetRawAttribute("ToggleOnFunctors", "...")`.
- `Osi.AddPassive` is asynchronous — the passive appears next tick, so poll `HasPassive`
  before concluding failure (though polling never satisfies for a runtime passive).
- **`PersistentVars` is per-mod** and SE swaps the global during event dispatch, so a
  chunk evaluated in the bridge's own context sees `nil`. Reach another mod's state
  through `Mods.<Folder>.PersistentVars` / its exposed API, or pass
  `modContext="<ModFolder>"` to `bg3_eval` to run with that mod's
  `PersistentVars`/`ModuleUUID` swapped in. `Ext.Timer.WaitFor` callbacks run in the
  *registering* mod's context.
- Mod-variable persistence that actually survives a save/reload:
  `Ext.Vars.RegisterModVariable(uuid, name, {Server=true, Client=true, SyncToClient=true})`
  on both contexts, writes via `Ext.Vars.GetModVariables(uuid)[name] = v`, then
  `Ext.Vars.SyncModVariables(uuid)`. The variables live in the savegame, so loading an
  older save reverts them by design.
- **A VM reset is not a session load.** `bg3_reload` restarts both Lua VMs and re-reads
  loose scripts (an edit → reset → live change round-trip measured ~113 ms for a
  bootstrap file), but it does **not** re-fire the game's session-loaded events, and it
  clears every global. Hot reload is also not per-context: the reset restarts server and
  client whichever context asks.
- `Ext.Resource.Get` / `GetAll` see only **loaded** resources — pak-defined entries load
  on demand and return `nil` until something pulls them in. There is no force-load and no
  reader for pak resource definitions, so resource search is loaded-only by necessity.
  Templates and static data are the exception: those banks are fully enumerable.

---

## Asset and localization mining

`bg3_eval` plus `Ext.IO` is a surprisingly complete data-mining rig: `Ext.IO.LoadFile`
reads straight through the VFS *into packed paks* without the user unpacking anything,
`Ext.IO.SaveFile` writes into the Script Extender directory, and `string.pack`/`string.unpack`
(Lua 5.4) make binary parsing feasible entirely in-VM. That combination is what made a
30 MB localization file, 25 character voicebanks and embedded bark audio reachable from
an agent session.

The gap that cost the most: **there is no directory or glob enumeration.** `Ext.IO`
exposes no listing, so every path is guesswork — voicebank names, the localization path
(five candidates probed before one hit), bark audio paths. Verified layouts, kept because
rediscovering them is pure probing:

| Artifact | Layout |
|---|---|
| Localization `.loca` | magic `LOCA`; 232,878 entries in the shipped English file; **70-byte entry records** (64-byte key + `u16` version + `u32` length); texts begin at the header's `TextsOffset` |
| Voicebank `.lsf` | magic `LSOF` v7, uncompressed; per-line values blob lays out `<handle>\0 VORBIS\0 <float32 duration> <priority>\0 v<code>_<handle>.wem\0` |
| Voice line audio | `Mods/<Module>/Localization/<Language>/Soundbanks/v<speakerCode>_<handle>.wem` |
| Reaction bark audio | `Public/Shared/Assets/Sound/<numericId>.wem` |
| Voice static data | `Ext.StaticData.GetAll('Voice')` returns 36 entries |

Related traps:

- **`Ext.Utils.Base64Encode` is absent** (probed). Binary has to be hex-encoded, which
  doubles size and collides with the response ceiling, so in-VM parsing usually beats
  moving bytes out.
- **`Ext.Loca` is handle → text only.** `Ext.Loca.GetAllTranslatedStringKeys` is
  misleadingly named: it returns roughly 11 k *keyed* strings like `<guid>_DisplayName`,
  not the 232 k voiced-line handles. Reverse text → handle search means scanning the
  `.loca` yourself.
- **Dialog and timeline resources are metadata-only.** `resource::DialogResource::Nodes`
  does not exist; `Timeline`/`TimelineScene` expose `DialogResourceId`, `SourceFile` and
  little else. Per-speaker line sets had to be derived from voicebank binaries instead.
- `bg3_vfs_probe` reads the whole file to report its length, so it is a truth oracle for
  pak-vs-loose, not a cheap `stat` for existence sweeps over thousands of paths.

---

## Agent-workflow ergonomics

What makes or breaks an agent session, mostly independent of the engine:

- **`bg3_eval` is the workhorse** — roughly 90 % of the value in a mining session came
  from raw Lua. The specialized tools are ergonomics on top of it; the primitive is what
  unlocks anything genuinely new.
- **Plain globals persist across eval calls within a VM session.** Caching a 30 MB
  localization blob, a handle list and parsed entries in globals is what made paginated
  results possible at all. (An earlier note claimed the opposite; that was a stale mod
  install, corrected by probe.) `Bridge.Scratch` is the explicit namespace, cleared by
  `bg3_reload` like every other global.
- **Response payloads have a ceiling around 32 KB.** Probing `string.rep('x', N)`:
  10,000 and 30,000 returned intact, 60,000 came back as a 170-byte stub. Before the
  fix, an oversized result truncated to invalid JSON mid-object (a parse failure at
  character 20414) rather than reporting itself — the worst kind of failure. Paginate
  deliberately, and treat a suspiciously short reply as truncation.
- **The client context has an 8 s timeout.** A cold full-text scan over 232,878
  localization entries died with "No response from the client context within 8000ms";
  existence sweeps over thousands of files flirt with the same ceiling. Slice long work
  into sub-8 s chunks and cache across calls in globals.
- **Distinguish "no game" from "too slow".** The client context only answers once a save
  is loaded, and `bg3_bridge_status` correctly reports server-offline / client-pending —
  treat that as a first-class state and gate eval calls on it. A heavy burst can also
  make the server context unresponsive for a while; back off rather than retry harder.
- **One throwing expression used to abort a whole cell**, discarding every other field of
  a multi-field return. `Bridge.Fields{...}` returns best-effort per-field results and
  names the field that threw.
- **Diagnostics belong in the log, and the log has channels.** A mod's `print` /
  `Ext.Utils.Print` output and script errors land in the **Extender** log; story traffic
  in the **Osiris** log, which is also the noisy one that "newest log" picks by default.
  Reading logs used to mean shelling out to `tail`/`grep`; `bg3_read_log` takes
  `logType`, a filter regex, and a `cursor` that returns only lines appended since the
  last call. `bg3_eval` also captures prints emitted during the call itself.
- **Beware overlapping scheduled timers across eval calls.** Back-to-back evals each
  scheduling `Ext.Timer.WaitFor` chains interleaved and corrupted shared state, producing
  readings that looked like real bugs. Serialize, or tag scheduled work.
- **Round trips cost about a second** (the mod polls every 30 ticks), so batch probes
  into one chunk rather than chaining a dozen calls.
- **Drive a mod's own configuration, not injected state.** Injecting a status to buy time
  collided with the mod's own teardown and produced a phantom "leftover status" bug that
  did not exist. Prefer setting config and letting real logic run.
- **Exercise the real flow.** A whole class of bug — a state-gated handler orphaning a
  re-targeted character — only appeared when the mod's own logic drove the sequence under
  stress. Synthetic "set the state, call the function" tests hid it.
- **Keep a human in the loop for visual truth.** The bridge cannot see the screen, and
  animation, pose and limbo states often differ *only* visually. Confirm game-visible or
  destructive actions with the user, and prefer a save reload over manual state cleanup —
  manual cleanup consistently spawned more troubleshooting than it saved.

---

## What works well

Worth preserving, because each of these carried a session:

- **`bg3_find_resource`** — half-remembered name to GUID across the loaded banks, with
  `EffectName`/`Guid`/`Looping`/`Duration`/`SourceFile` in the result. Central to every
  effect hunt, and an invalid `type` helpfully returns the list of valid banks.
- **The three-layer search split** — resources (raw assets and their GUIDs) → templates
  (world objects and their cross-references) → stats and static data (behaviour) — maps
  cleanly onto "what did I see → what is it called → what do I reference", with
  `bg3_find_status_by_effect` as the shortcut from appearance to status.
- **`Ext.IO.LoadFile` through the VFS** — reading packed content with nothing unpacked.
- **`bg3_reload` + `bg3_bridge_status`** as a round-trip for validating Lua edits: fast,
  honest, and the confirmation is a fresh handshake rather than a log guess.
- **Polling a predicate** (`pollUntil`) instead of sleeping — most Osiris calls settle on
  a later tick, and status-application → spell-grant chains confirmed in 300-400 ms.
- **Temporary-spawn tracking and despawn** — the cleanup path did its job.
- **Structured failure.** `bg3_resolve_character` returning `found:false` plus the list of
  probes it tried and what each returned answers the session complaint that mattered
  most: not "it failed" but *why*.
