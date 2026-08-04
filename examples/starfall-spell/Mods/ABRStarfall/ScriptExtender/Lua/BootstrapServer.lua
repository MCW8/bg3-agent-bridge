--- Grants Starfall to the host character.
---
--- Adding the spell from Lua avoids touching class Progressions or SpellLists,
--- which keeps the example small and means it applies to an existing save
--- rather than only to a fresh character.

local SPELL = "Target_ABR_Starfall"

local function grant(character)
    if character == nil or character == "" then
        return false, "no character"
    end
    if Osi.HasSpell(character, SPELL) == 1 then
        return false, "already known"
    end

    Osi.AddSpell(character, SPELL, 1, 1)
    return true, "granted"
end

local function grantToHost()
    local host = Osi.GetHostCharacter()
    local ok, reason = grant(host)
    Ext.Utils.Print("[Starfall] " .. tostring(host) .. ": " .. reason)
    return ok
end

Ext.Osiris.RegisterListener("LevelGameplayStarted", 2, "after", function(_levelName, _isEditorMode)
    grantToHost()
end)

-- Re-grant on demand from the Script Extender console with `!starfall`, which
-- is handy after a Lua reset drops the spell or when testing on a save that was
-- already loaded.
Ext.RegisterConsoleCommand("starfall", function()
    grantToHost()
end)
