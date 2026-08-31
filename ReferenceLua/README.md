# ReferenceLua — Osiris API signatures

Machine-readable signatures for the Osiris scripting API, read by
`bg3_osiris_functions action=signature` (works with the game closed).

## Files

| File | Source | Used by |
|---|---|---|
| `Osi.lua` | [BG3ModdingTools `generated/`](https://github.com/LaughingLeader/BG3ModdingTools/tree/master/generated) (MIT — see `LICENSE-BG3ModdingTools.txt`) | `action=signature`, every function arity/overload |
| `Osi.Events.lua` | BG3ModdingTools `generated/` (MIT) | `action=signature` for event names |
| `Ext.Osiris.RegisterListener.lua` | BG3ModdingTools `generated/` (MIT) | reference for listener event shapes |
| `ExtIdeHelpers_v32.lua` | generated per-machine by the Script Extender (SE writes it into the game's Script Extender folder) | human/agent reference for the `Ext.*` API — not parsed by the bridge |

Provenance note: the three BG3ModdingTools files are generated from the game's
`story_header.div` by LaughingLeader's scripts and kept current in that
repository as Larian updates the game. `ExtIdeHelpers_v32.lua` was generated
locally by the Script Extender (v32); regenerate it from your own install with
`Ext.Types.GenerateIdeHelpers()` in a running game.

## Refreshing

When Larian updates the game, pull fresh copies of the three generated files
from the BG3ModdingTools `generated/` folder (raw URLs work:

`https://raw.githubusercontent.com/LaughingLeader/BG3ModdingTools/master/generated/Osi.lua`

) or regenerate locally with the Script Extender. The parser degrades
gracefully when files are missing — `action=signature` says where to put them
instead of failing.

## Why bundled rather than fetched at install

The files are small (~265 KB for the three that matter), the signature lookup
is designed to work offline with the game closed, and an install-time network
fetch would add a failure mode to the one step that must be bulletproof
(first-run setup). MIT permits redistribution with this attribution.
