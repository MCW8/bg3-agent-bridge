--- Grants the Dancing Hold spell so the status is testable by casting.
---
--- Entity variables must be registered before use, or every access logs
--- "Variable class '<name>' not registered" and reads back nil — so the guard
--- would never trip and the spell would be re-granted on every level load. The
--- options table is required, despite ExtIdeHelpers.lua declaring this
--- function as taking only a name.
local SPELL = "Target_DancingHold"
local STATUS = "HOLD_PERSON_DANCING"
local GRANTED_FLAG = "DancingHold_Granted"

Ext.Vars.RegisterUserVariable(GRANTED_FLAG, {
    Server = true,
    Persistent = true,
    SyncToClient = false,
})

--- Never compare Script Extender userdata against nil — several types raise
--- "attempt to call a nil value" on the comparison, though indexing is fine.
local function alreadyGranted(entity)
    local ok, value = pcall(function()
        return entity.Vars[GRANTED_FLAG]
    end)
    return ok and value == true
end

local function grant()
    local host = Osi.GetHostCharacter()
    if host == nil or host == "" then
        return
    end

    local entity = Ext.Entity.Get(host)
    if entity == nil then
        return
    end

    if alreadyGranted(entity) then
        return
    end

    Osi.AddSpell(host, SPELL, 1, 1)
    pcall(function()
        entity.Vars[GRANTED_FLAG] = true
    end)
    Ext.Utils.Print("[DancingHold] granted " .. SPELL .. " to " .. tostring(host))
end

Ext.Osiris.RegisterListener("LevelGameplayStarted", 2, "after", function(_levelName, _isEditorMode)
    grant()
end)

-- `!dancinghold` re-grants the spell; `!danceme` applies the status directly to
-- the host, which is the quickest way to see the animation without finding a
-- humanoid to target.
Ext.RegisterConsoleCommand("dancinghold", function()
    Osi.AddSpell(Osi.GetHostCharacter(), SPELL, 1, 1)
    Ext.Utils.Print("[DancingHold] granted on request")
end)

Ext.RegisterConsoleCommand("danceme", function()
    local host = Osi.GetHostCharacter()
    Osi.ApplyStatus(host, STATUS, 30.0, 1, host)
    Ext.Utils.Print("[DancingHold] applied " .. STATUS .. " for 30s")
end)
