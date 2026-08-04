--- Puts one Fancy Armor in the host's inventory so the mod is testable without
--- console commands or a shop. Guarded so repeated level loads do not stack
--- copies up.

local TEMPLATE = "ff2c72c3-7301-4f6f-bcad-3f98711a0321"
local GRANTED_FLAG = "FancyArmor_Granted"

--- Entity variables must be registered before use, or every access logs
--- "Variable class '<name>' not registered" and silently reads back nil — so a
--- guard built on one never trips, and the item is granted again on every level
--- load.
---
--- The options table is required despite ExtIdeHelpers.lua declaring this as
--- fun(a1:FixedString): calling it with the name alone fails outright. Verified
--- against the running game rather than the dump.
Ext.Vars.RegisterUserVariable(GRANTED_FLAG, {
    Server = true,
    Persistent = true,
    SyncToClient = false,
})

--- Never write `entity.Vars ~= nil`. Several Script Extender userdata types
--- raise "attempt to call a nil value" when compared against nil, because their
--- equality metamethod is not callable — indexing them is fine. Read through
--- pcall instead of testing for presence.
local function alreadyGranted(entity)
    local ok, value = pcall(function()
        return entity.Vars[GRANTED_FLAG]
    end)
    return ok and value == true
end

local function give()
    local host = Osi.GetHostCharacter()
    if host == nil or host == "" then
        return
    end

    local entity = Ext.Entity.Get(host)
    if entity == nil then
        return
    end

    if alreadyGranted(entity) then
        Ext.Utils.Print("[FancyArmor] already granted to " .. tostring(host))
        return
    end

    Osi.TemplateAddTo(TEMPLATE, host, 1, 0)
    pcall(function()
        entity.Vars[GRANTED_FLAG] = true
    end)
    Ext.Utils.Print("[FancyArmor] granted to " .. tostring(host))
end

Ext.Osiris.RegisterListener("LevelGameplayStarted", 2, "after", function(_levelName, _isEditorMode)
    give()
end)

-- `!fancyarmor` in the Script Extender console hands out another one, which is
-- handy when iterating without reloading a save.
Ext.RegisterConsoleCommand("fancyarmor", function()
    local host = Osi.GetHostCharacter()
    Osi.TemplateAddTo(TEMPLATE, host, 1, 0)
    Ext.Utils.Print("[FancyArmor] granted on request")
end)
