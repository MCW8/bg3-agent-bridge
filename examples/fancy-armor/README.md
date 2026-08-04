# Fancy Armor — example mod

Chest armour that **looks like dwarven plate but counts as light armour**, demonstrating that appearance and mechanics are separate concerns in BG3.

## How the split works

```
RootTemplate  ParentTemplateId → ARM_Plate_Dwarven   inherits VisualTemplate + Icon
              Stats            → ARM_FancyArmor       overrides behaviour only

Armor.txt     using "ARM_StuddedLeather_Body"         light-armour behaviour
              ArmorType "StuddedLeather"
              Boosts ""                               drops plate's stealth penalty
              RootTemplate ff2c72c3-...               points back at the template
```

`ArmorType` is what drives proficiency, not the model. Verified against nine real entries in the running game:

| Proficiency | ArmorType values |
|---|---|
| Light | Padded, Leather, StuddedLeather |
| Medium | Hide, ChainShirt, ScaleMail, BreastPlate, HalfPlate |
| Heavy | RingMail, ChainMail, Splint, **Plate** |

Because `ParentTemplateId` carries the visual and icon, neither is restated — only `Stats` is overridden. The stat and the template **point at each other**: the template's `Stats` names the entry, and the entry's `RootTemplate` names the template's `MapKey`. Shipped transmog mods complain loudly about items where that pair disagrees.

## Three things that cost a debugging round each

**Root templates load from `RootTemplates/_merged.lsf` only.** Fixed filename, binary LSF. A differently-named `.lsx` in the same folder is silently ignored — and because the stat entry still loads fine, the item exists on paper while its template does not. The symptom is no error and no item. Build with:

```bash
divine -g bg3 -a convert-resource -s _source/RootTemplates.lsx -d Public/FancyArmor/RootTemplates/_merged.lsf
```

The `.lsx` is kept under `_source/` because LSF is binary and discards every comment.

**Never compare Script Extender userdata against nil.** `entity.Vars ~= nil` raises *"attempt to call a nil value"* — the equality metamethod is not callable, though indexing is fine. Read through `pcall` instead.

**Entity variables must be registered.** Without `Ext.Vars.RegisterUserVariable`, every access logs `Variable class '<name>' not registered` and reads back nil, so a guard built on one never trips and the item is re-granted on every level load. The options table is required, despite `ExtIdeHelpers.lua` declaring the function as taking only a name.

## Build and install

```bash
divine -g bg3 -a convert-loca      -s Localization/English/FancyArmor.xml -d Localization/English/FancyArmor.loca
divine -g bg3 -a convert-resource  -s _source/RootTemplates.lsx -d Public/FancyArmor/RootTemplates/_merged.lsf
divine -g bg3 -a create-package    -s . -d "%LOCALAPPDATA%/Larian Studios/Baldur's Gate 3/Mods/FancyArmor.pak"
```

Add a `ModuleShortDesc` for `bf8a0aca-5992-4f9f-937d-68c478b8d60c` to `modsettings.lsx` **with the game closed**, then restart. Pack `.`, not `_source/`.

The armour is granted on level load, or `!fancyarmor` in the Script Extender console.

**Iterating:** a packed mod's Lua cannot be hot-reloaded — the pak is read at startup, so `bg3_reload` re-reads the same bytes. Install loose under `Data/Mods/` while developing if you want the fast loop, and pack only to distribute.
