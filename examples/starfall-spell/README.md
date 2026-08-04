# Starfall — example mod

A ground-targeted radiant AOE cantrip, built to exercise the agent bridge's debug loop end to end.

Cast it at any point you can see: creatures in a 6m radius make a Dexterity save or take `2d4` radiant damage and are outlined with `FAERIE_FIRE` for 10 turns.

## Why it is shaped this way

Every value in `Spell_Target.txt` was read out of the running game through the bridge rather than guessed:

```
bg3_stats_get Target_FaerieFire   -> recursion limit, as documented
bg3_eval      (flatten attributes to strings) -> the actual field values
```

That produced the two overrides that matter:

- **`TargetConditions "not Item();"`** — lifted from `Target_Grease`. Faerie Fire's own conditions (`not Dead() and ... not Self()`) require a creature, so inheriting them unchanged gives a spell that cannot be cast on bare ground.
- **`SpellFlags`** — respecified in full to drop `IsConcentration`, which Faerie Fire carries and this spell should not.

`Target_FaerieFire` is the parent rather than `Projectile_Fireball` because it is already a `Target` spell rather than a `Projectile`, and its `SpellProperties` are empty — so no surface or projectile behaviour comes along with the inheritance.

The spell is granted from Lua (`Osi.AddSpell`) instead of through class Progressions or SpellLists. That keeps the example small and means it works on an existing save rather than only a freshly created character.

## Build and install

```bash
divine -g bg3 -a convert-loca -s Localization/English/ABRStarfall.xml -d Localization/English/ABRStarfall.loca
divine -g bg3 -a create-package -s . -d "%LOCALAPPDATA%/Larian Studios/Baldur's Gate 3/Mods/ABRStarfall.pak"
```

Then add a `ModuleShortDesc` entry for UUID `f995a532-c12a-4527-a063-77cb5ab94240` to `modsettings.lsx`, or enable it in a mod manager.

**A restart is required.** Stats live in the pak, and `bg3_reload` only reinitialises Lua — it cannot reload packed data. Editing `BootstrapServer.lua` alone *is* hot-reloadable; editing `Spell_Target.txt` is not.

## Testing it

`!starfall` in the Script Extender console re-grants the spell without reloading a save — useful because a Lua reset drops it.
