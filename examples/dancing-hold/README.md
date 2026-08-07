# Dancing Hold — example mod

Hold Person's mechanics, Otto's Irresistible Dance animation, Hold Person's visual effect. An example of composing a status out of two existing ones, and of finding out how they work by asking the running game rather than guessing.

## The composition

```
using "HOLD_PERSON"                    everything below comes free
  StatusType INCAPACITATED
  Boosts: auto-fail Str/Dex saves, attackers auto-crit within 3m,
          advantage against target, movement blocked
  StatusGroups: SG_Condition, SG_Incapacitated, SG_Paralyzed
  RemoveConditions: Wisdom save at end of turn
  StatusEffect 16afeddb — the Hold Person visual, kept deliberately

overrides
  StillAnimationType "Dancing"         from IRRESISTIBLE_DANCE
  AnimationLoop ""                     clear the inherited freeze
  AnimationEnd  ""
```

## The part that is not guessable

The two statuses animate through **different mechanisms**.

`HOLD_PERSON` freezes its target with `AnimationLoop` and `AnimationEnd`, both pointing at a specific GR2 (`REAC_Magic_External_Combat_01`). `IRRESISTIBLE_DANCE` sets neither — it uses `StillAnimationType "Dancing"`, a named animation state.

So the dance cannot be copied by copying an animation reference, because there is no reference to copy. You switch mechanism, and clear the inherited one so the two do not compete. Both already share `StillAnimationPriority "Snared"`, so that needs no change.

Reading both stat entries out of the running game is what made this visible in about a minute. Neither is documented anywhere.

Worth knowing: `IRRESISTIBLE_DANCE` is a `BOOST`, not `INCAPACITATED` — Otto's is genuinely weaker than Hold Person. This inherits Hold Person, so it is the stronger mechanics with the dance appearance. Inherit `IRRESISTIBLE_DANCE` instead if you want Otto's actual strength.

## A limit found while building this

`Ext.Stats.Create` will compose a new status at runtime, and reading it back shows every field resolved correctly — but **it cannot be applied**. The engine builds status prototypes at load, so `Osi.ApplyStatus` silently does nothing for one created mid-session, with no error logged. A control test with a shipped status confirmed the call itself was fine.

Live stat *editing* works (`bg3_stats_set` on existing entries). Creating a new status needs a real mod and a restart.

## Build and install

```bash
divine -g bg3 -a convert-loca   -s Localization/English/DancingHold.xml -d Localization/English/DancingHold.loca
divine -g bg3 -a create-package -s . -d "%LOCALAPPDATA%/Larian Studios/Baldur's Gate 3/Mods/DancingHold.pak"
```

Add a `ModuleShortDesc` for `f5055ba5-ba48-411f-b1fc-3db9a205c4b8` to `modsettings.lsx` **with the game closed**, then restart.

## Testing it

The spell **Dancing Hold** is granted on level load, or `!dancinghold` in the Script Extender console. It targets humanoids like Hold Person does.

Fastest check is `!danceme`, which applies the status to yourself for 30 seconds — no need to find a valid target to see the animation.

`StillAnimationType "Dancing"` may not have art for every race and creature type. Trying it on a few is worth doing before relying on it.
