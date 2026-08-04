--- Operation handlers. Each receives the request `params` table and either
--- returns a serializable result or raises; Mailbox wraps every call in pcall
--- and turns a raise into `{ ok = false, error = ... }`.

BG3AgentBridge = BG3AgentBridge or {}
local Bridge = BG3AgentBridge

Bridge.Handlers = {}
local H = Bridge.Handlers

--- GetAllComponentNames returns fully qualified names ("eoc::HealthComponent")
--- but the entity indexer wants the short form ("Health"), so discovery and
--- fetch disagree unless the name is normalised. Ordered most to least literal.
function Bridge.componentAliases(name)
    local seen, aliases = {}, {}
    local function add(value)
        if value ~= nil and value ~= "" and not seen[value] then
            seen[value] = true
            aliases[#aliases + 1] = value
        end
    end

    add(name)
    local short = string.match(name, "::([%w_]+)$")
    add(short)
    add((string.gsub(name, "Component$", "")))
    if short ~= nil then
        add((string.gsub(short, "Component$", "")))
    end

    return aliases
end

--- Indexing an unknown component raises rather than returning nil, so each
--- candidate needs its own pcall.
function Bridge.resolveComponent(entity, name)
    for _, alias in ipairs(Bridge.componentAliases(name)) do
        local ok, component = pcall(function()
            return entity[alias]
        end)
        if ok and component ~= nil then
            return component, alias
        end
    end
    return nil, nil
end

H["ping"] = function()
    return {
        pong = true,
        context = Bridge.context,
        protocol = Bridge.PROTOCOL_VERSION,
        capabilities = Bridge.capabilities,
    }
end

H["capabilities"] = function()
    return Bridge.capabilities
end

H["eval"] = function(params)
    if not Bridge.capabilities.eval then
        error("eval is unavailable: this Script Extender build does not expose load() to mod scripts")
    end

    local code = params.code
    if type(code) ~= "string" or code == "" then
        error("params.code must be a non-empty string")
    end

    local chunk, compileError = Bridge.compile(code)
    if chunk == nil then
        error("compile error: " .. tostring(compileError))
    end

    local returned = table.pack(chunk())
    local values = {}
    for i = 1, returned.n do
        values[i] = Bridge.describe(returned[i])
    end

    return { count = returned.n, values = values }
end

H["entity.get"] = function(params)
    if not Bridge.capabilities.entity then
        error("Ext.Entity is unavailable in this Script Extender build")
    end

    local id = params.id
    if id == nil or id == "" then
        error("params.id is required (an entity UUID or handle)")
    end

    local entity = Ext.Entity.Get(id)
    if entity == nil then
        error("no entity found for id: " .. tostring(id))
    end

    -- A single named component keeps the payload small; the component list is
    -- the discovery step an agent runs first.
    if params.component ~= nil and params.component ~= "" then
        local component, resolved = Bridge.resolveComponent(entity, params.component)
        if component == nil then
            error(
                "entity has no component named: " .. tostring(params.component)
                    .. " (tried " .. table.concat(Bridge.componentAliases(params.component), ", ") .. ")"
            )
        end

        Bridge.responseDepth = tonumber(params.depth)
        return { id = tostring(id), component = resolved, requested = params.component, data = component }
    end

    if type(entity.GetAllComponentNames) ~= "function" then
        error("this Script Extender build does not expose GetAllComponentNames")
    end

    return { id = tostring(id), components = entity:GetAllComponentNames() }
end

H["stats.get"] = function(params)
    if not Bridge.capabilities.stats then
        error("Ext.Stats is unavailable in this Script Extender build")
    end

    local name = params.name
    if name == nil or name == "" then
        error("params.name is required")
    end

    local stat = Ext.Stats.Get(name)
    if stat == nil then
        error("no stat entry found named: " .. tostring(name))
    end

    if params.attribute ~= nil and params.attribute ~= "" then
        return {
            name = name,
            attribute = params.attribute,
            value = Bridge.describe(stat[params.attribute]),
        }
    end

    -- Measured live: some entries (spells especially) follow an inheritance
    -- chain long enough to stall the Lua state for seconds, and lowering depth
    -- makes them fail outright rather than return less. Reading a single
    -- attribute is the fast, reliable path for those.
    Bridge.responseDepth = tonumber(params.depth)
    return { name = name, stat = stat }
end

H["stats.set"] = function(params)
    if not Bridge.capabilities.stats then
        error("Ext.Stats is unavailable in this Script Extender build")
    end

    local name = params.name
    local attribute = params.attribute
    if name == nil or name == "" then
        error("params.name is required")
    end
    if attribute == nil or attribute == "" then
        error("params.attribute is required")
    end

    local stat = Ext.Stats.Get(name)
    if stat == nil then
        error("no stat entry found named: " .. tostring(name))
    end

    local previous = Bridge.describe(stat[attribute])
    stat[attribute] = params.value

    -- Without a sync the change stays server-side and clients keep the old
    -- value; skippable for read-back-only experiments.
    local synced = false
    if params.sync ~= false and type(stat.Sync) == "function" then
        stat:Sync()
        synced = true
    end

    return {
        name = name,
        attribute = attribute,
        previous = previous,
        value = Bridge.describe(stat[attribute]),
        synced = synced,
    }
end

H["reset"] = function()
    if not Bridge.capabilities.reset then
        error("Ext.Debug.Reset is unavailable in this Script Extender build")
    end

    -- Resetting tears down this VM, so it must not happen until the response
    -- file is on disk. Mailbox performs the reset after it writes.
    Bridge.pendingReset = true
    return { scheduled = true, context = Bridge.context }
end
