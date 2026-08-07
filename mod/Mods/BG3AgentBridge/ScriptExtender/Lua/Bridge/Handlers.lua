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

--- ModVersion comes back as a four element array, not a string.
local function versionString(value)
    local parts = {}
    local ok = pcall(function()
        for _, n in ipairs(value) do
            parts[#parts + 1] = tostring(n)
        end
    end)

    if not ok or #parts == 0 then
        return "unknown"
    end
    return table.concat(parts, ".")
end

--- Dependencies are ModuleShortDesc objects rather than plain names.
local function dependencyNames(mod)
    local names = {}
    pcall(function()
        for _, dep in ipairs(mod.Dependencies) do
            local label
            pcall(function()
                label = dep.Folder or dep.Name
            end)
            names[#names + 1] = tostring(label or "unknown")
        end
    end)
    return names
end

--- Flatten a resource to its scalar fields, and build the lowercased haystack
--- that `query` is matched against.
---
--- Deliberately generic: iterating whatever the resource exposes means new or
--- unfamiliar banks work without a per-bank field list, and every string field
--- becomes searchable. For Sound that means SoundEvent; for Visual, Slot and
--- SkeletonResource; for everything, Guid and SourceFile.
local function summarizeResource(resource, guid)
    local entry = { Guid = tostring(guid) }
    local haystack = { string.lower(tostring(guid)) }

    pcall(function()
        for key, value in pairs(resource) do
            local t = type(value)
            if t == "string" then
                entry[key] = value
                haystack[#haystack + 1] = string.lower(value)
            elseif t == "number" or t == "boolean" then
                entry[key] = value
            end
        end
    end)

    return entry, table.concat(haystack, " ")
end

local function resourceBankNames()
    local names = {}
    pcall(function()
        for k, v in pairs(Ext.Enums.ResourceBankType) do
            if type(k) == "string" then
                names[#names + 1] = k
            end
        end
    end)
    table.sort(names)
    return names
end

--- Sound objects PostEvent will accept by name. Found by probing: the engine
--- rejects anything else with "Unknown built-in sound object name", and there
--- is no enum to enumerate them, so this list is verified rather than
--- exhaustive. An entity handle or nil are also valid.
local BUILTIN_SOUND_OBJECTS = {
    Global = true,
    Music = true,
    Ambient = true,
    HUD = true,
    Listener = true,
}

local function builtinSoundObjectList()
    local names = {}
    for name in pairs(BUILTIN_SOUND_OBJECTS) do
        names[#names + 1] = name
    end
    table.sort(names)
    return table.concat(names, ", ")
end

--- Resolve `target` to something PostEvent accepts: a built-in name, an entity
--- handle, or nil for the default object.
local function resolveSoundObject(target)
    if type(target) ~= "string" or target == "" then
        return nil
    end
    if BUILTIN_SOUND_OBJECTS[target] then
        return target
    end

    local ok, entity = pcall(function()
        return Ext.Entity.Get(target)
    end)
    if not ok or entity == nil then
        error("target must be an entity UUID or one of: " .. builtinSoundObjectList())
    end
    return entity
end

--- Live capture of sounds the engine fires.
---
--- Ext.Audio is write-only, but SoundRoutingSystem exposes the queue of
--- SoundPostEventRequests the engine is about to dispatch, and that queue is
--- readable from a tick handler. Draining it every tick is the only way to
--- observe audio, since the queue is emptied within the frame.
---
--- Note what this does NOT see: movement foley is fired from the animation
--- system straight to Wwise and never appears here. Spells, items, interactions
--- and scripted events do.
local capture = {
    active = false,
    installed = false,
    events = {},
    seen = 0,
    dropped = 0,
    limit = 200,
    dedupe = true,
}

local function captureTick()
    if not capture.active then
        return
    end

    local ok, system = pcall(function()
        return Ext.System.SoundRouting
    end)
    -- Never compare these against nil: on this build `Ext.System == nil` raises
    -- "attempt to call a nil value", because the userdata's equality metamethod
    -- is not callable. Indexing and type() are both fine.
    if not ok or type(system) ~= "userdata" then
        return
    end

    local queue = system.PostEvent
    if type(queue) ~= "userdata" then
        return
    end

    local okCount, count = pcall(function()
        return #queue
    end)
    if not okCount or count == nil or count == 0 then
        return
    end

    for i = 1, count do
        local request = queue[i]
        local name, subject, kind
        pcall(function()
            name = tostring(request.Event)
        end)
        pcall(function()
            subject = tostring(request.Subject)
        end)
        pcall(function()
            kind = tostring(request.Type)
        end)
        name = name or "<unknown>"

        capture.seen = capture.seen + 1

        -- The same event often fires several frames running; collapsing repeats
        -- keeps a busy scene from filling the buffer with one sound.
        local last = capture.events[#capture.events]
        if capture.dedupe and last ~= nil and last.event == name and last.subject == subject then
            last.count = last.count + 1
        elseif #capture.events < capture.limit then
            capture.events[#capture.events + 1] = {
                event = name,
                subject = subject,
                type = kind,
                count = 1,
            }
        else
            capture.dropped = capture.dropped + 1
        end
    end
end

local function captureStatus()
    return {
        active = capture.active,
        buffered = #capture.events,
        seen = capture.seen,
        dropped = capture.dropped,
        limit = capture.limit,
        dedupe = capture.dedupe,
    }
end

H["audio.capture"] = function(params)
    -- Type check rather than a nil comparison: see the note in captureTick.
    if type(Ext.System) ~= "userdata" then
        error("Ext.System is unavailable — sound capture needs the client context")
    end

    local action = params.action or "status"

    if action == "start" then
        capture.events = {}
        capture.seen = 0
        capture.dropped = 0
        capture.limit = tonumber(params.limit) or 200
        capture.dedupe = params.dedupe ~= false
        capture.active = true

        -- Subscribe lazily and only once: an always-on tick handler would cost
        -- every user every frame for a feature almost nobody has running.
        if not capture.installed then
            Ext.Events.Tick:Subscribe(captureTick)
            capture.installed = true
        end

        return captureStatus()
    elseif action == "stop" then
        capture.active = false
        return captureStatus()
    elseif action == "clear" then
        capture.events = {}
        capture.seen = 0
        capture.dropped = 0
        return captureStatus()
    elseif action == "read" or action == "status" then
        local status = captureStatus()
        if action == "read" then
            status.events = capture.events
            if params.clear == true then
                capture.events = {}
            end
        end
        return status
    end

    error("unknown action: " .. tostring(action) .. " (expected start, stop, read, clear or status)")
end

H["audio.post"] = function(params)
    if Ext.Audio == nil then
        error("Ext.Audio is unavailable — audio is client side only, so this has to run in the client context")
    end

    local object = resolveSoundObject(params.target)
    local label = params.target
    if type(label) ~= "string" or label == "" then
        label = "<default>"
    end

    if params.stop == true then
        local ok, result = pcall(function()
            return Ext.Audio.Stop(object)
        end)
        if not ok then
            error("Stop failed: " .. tostring(result))
        end
        return { stopped = true, target = label, result = result }
    end

    local event = params.event
    if type(event) ~= "string" or event == "" then
        error("params.event is required — a SoundEvent name, e.g. from bg3_find_resource with type=Sound")
    end

    -- Cheap and idempotent; some events will not fire until their bank entry has
    -- been loaded, and loading an already loaded event is harmless.
    local loaded = false
    pcall(function()
        loaded = Ext.Audio.LoadEvent(event) == true
    end)

    local ok, posted = pcall(function()
        return Ext.Audio.PostEvent(object, event)
    end)
    if not ok then
        error("PostEvent failed: " .. tostring(posted))
    end

    local result = { posted = posted, loaded = loaded, event = event, target = label }

    -- posted=true only means Wwise accepted the event, not that anything was
    -- audible. Most game sounds are positional, and firing one at a built-in
    -- object puts it nowhere near the listener — silence with a success
    -- response, which is a miserable thing to debug. Only worth the lookup
    -- when the target was not an entity, since that is the failing case.
    if type(object) ~= "userdata" then
        local okFind, info = pcall(function()
            for _, guid in ipairs(Ext.Resource.GetAll("Sound")) do
                local r = Ext.Resource.Get(guid, "Sound")
                if r ~= nil and r.SoundEvent == event then
                    return { MaxDistance = r.MaxDistance, Duration = r.Duration, Guid = tostring(r.Guid) }
                end
            end
            return nil
        end)

        if okFind and info ~= nil then
            result.maxDistance = info.MaxDistance
            result.duration = info.Duration
            result.guid = info.Guid

            if type(info.MaxDistance) == "number" and info.MaxDistance > 0 and info.MaxDistance < 100 then
                result.warning = "This event is positional (MaxDistance " .. tostring(info.MaxDistance)
                    .. ") and was played on the " .. label .. " sound object, so it is probably inaudible. "
                    .. "Pass target=<character UUID> to hear it. Note also that foley events are often gated on "
                    .. "Wwise switches such as surface material, and resolve to little or nothing without them."
            end
        end
    end

    return result
end

--- Collapse a name to letters and digits so that what a player types matches
--- what Larian named the asset. "Blood of Lathander" and
--- "UNI_CRE_HUM_Sun_Mace_BloodOfLathander" only meet after spaces, underscores
--- and case are removed.
local function normalize(text)
    return (string.gsub(string.lower(tostring(text)), "[^%w]", ""))
end

--- Templates carry DisplayName as a TranslatedString, which has to be resolved
--- to the localised text a player would recognise. Returns nil when there is
--- none, which is most scenery.
local function displayNameOf(template)
    local ok, value = pcall(function()
        return template.DisplayName:Get()
    end)
    if not ok or value == nil then
        return nil
    end
    local text = tostring(value)
    if text == "" then
        return nil
    end
    return text
end

H["template.find"] = function(params)
    local all = Ext.Template.GetAllRootTemplates()

    local needle = params.query
    local needleNormalized = nil
    if type(needle) == "string" and needle ~= "" then
        needle = string.lower(needle)
        needleNormalized = normalize(needle)
    else
        needle = nil
    end

    -- Resolving a localised string for all ~32k templates is not free, so
    -- searching display names is opt-in. Returned entries always carry theirs,
    -- which costs nothing at a capped result count.
    local searchDisplayNames = params.searchDisplayNames == true

    local wantType = params.templateType
    if type(wantType) ~= "string" or wantType == "" then
        wantType = nil
    end

    local limit = tonumber(params.limit) or 25
    if limit < 1 then
        limit = 1
    elseif limit > 200 then
        limit = 200
    end

    local clock = Ext.Utils ~= nil and Ext.Utils.MonotonicTime or nil
    local started = clock and clock() or nil

    local results, matched, scanned = {}, 0, 0

    -- Fields worth carrying back. Stats and VisualTemplate are the useful ones:
    -- they turn a name you half-remember into the stat entry and the visual GUID
    -- in a single lookup.
    local fields = { "Name", "TemplateType", "Stats", "Icon", "VisualTemplate", "ParentTemplateId", "EquipmentTypeID" }

    for _, template in pairs(all) do
        scanned = scanned + 1

        local name, templateType
        pcall(function()
            name = tostring(template.Name)
        end)
        pcall(function()
            templateType = tostring(template.TemplateType)
        end)

        local typeOk = wantType == nil or (templateType ~= nil and string.lower(templateType) == string.lower(wantType))

        local nameOk = needle == nil
        if not nameOk and name ~= nil then
            -- Plain substring first, then the normalised form, so a query typed
            -- the way it reads in game still finds an underscored asset name.
            nameOk = string.find(string.lower(name), needle, 1, true) ~= nil
                or string.find(normalize(name), needleNormalized, 1, true) ~= nil
        end

        -- Only pay for localisation lookups when asked, and only for entries
        -- the name match did not already claim.
        local displayName = nil
        if typeOk and not nameOk and searchDisplayNames then
            displayName = displayNameOf(template)
            if displayName ~= nil then
                nameOk = string.find(string.lower(displayName), needle, 1, true) ~= nil
                    or string.find(normalize(displayName), needleNormalized, 1, true) ~= nil
            end
        end

        if typeOk and nameOk then
            matched = matched + 1
            if #results < limit then
                local entry = {}
                pcall(function()
                    entry.Id = tostring(template.Id)
                end)
                for _, key in ipairs(fields) do
                    local ok, value = pcall(function()
                        return template[key]
                    end)
                    if ok and value ~= nil then
                        local t = type(value)
                        local text = (t == "string" or t == "number" or t == "boolean") and value or tostring(value)
                        -- Drop noise: opaque userdata addresses, empty strings,
                        -- and all-zero GUIDs, all of which just cost the caller
                        -- context to read past.
                        local asString = tostring(text)
                        if asString ~= ''
                            and asString ~= '00000000-0000-0000-0000-000000000000'
                            and not string.find(asString, '(0000', 1, true)
                        then
                            entry[key] = text
                        end
                    end
                end
                -- Always include the human-readable name for what is returned:
                -- it is what lets the caller tell the right hit from 173 others.
                entry.DisplayName = displayName or displayNameOf(template)
                results[#results + 1] = entry
            end
        end
    end

    return {
        scanned = scanned,
        matched = matched,
        returned = #results,
        truncated = matched > #results,
        elapsedMs = started and (clock() - started) or nil,
        templates = results,
    }
end

H["resource.find"] = function(params)
    local bank = params.type
    if type(bank) ~= "string" or bank == "" then
        error("params.type is required, e.g. \"Sound\", \"Visual\", \"CharacterVisual\". Valid: "
            .. table.concat(resourceBankNames(), ", "))
    end

    local okAll, all = pcall(function()
        return Ext.Resource.GetAll(bank)
    end)
    if not okAll or type(all) ~= "table" then
        error("unknown or unavailable resource type: " .. tostring(bank)
            .. ". Valid: " .. table.concat(resourceBankNames(), ", "))
    end

    local needle = params.query
    if type(needle) == "string" and needle ~= "" then
        needle = string.lower(needle)
    else
        needle = nil
    end

    local limit = tonumber(params.limit) or 25
    if limit < 1 then
        limit = 1
    elseif limit > 200 then
        limit = 200
    end

    local moddedOnly = params.moddedOnly == true
    local clock = Ext.Utils ~= nil and Ext.Utils.MonotonicTime or nil
    local started = clock and clock() or nil

    local results, matched = {}, 0

    for _, guid in ipairs(all) do
        local ok, resource = pcall(function()
            return Ext.Resource.Get(guid, bank)
        end)

        if ok and resource ~= nil then
            local entry, haystack = summarizeResource(resource, guid)
            local keep = (needle == nil or string.find(haystack, needle, 1, true) ~= nil)
                and (not moddedOnly or entry.IsModded == true)

            if keep then
                -- Counting past the limit is nearly free and tells the caller
                -- whether to narrow the query rather than guess.
                matched = matched + 1
                if #results < limit then
                    results[#results + 1] = entry
                end
            end
        end
    end

    return {
        type = bank,
        scanned = #all,
        matched = matched,
        returned = #results,
        truncated = matched > #results,
        elapsedMs = started and (clock() - started) or nil,
        resources = results,
    }
end

H["mods.list"] = function(params)
    local order = Ext.Mod.GetLoadOrder()

    local needle = params.filter
    if type(needle) == "string" and needle ~= "" then
        needle = string.lower(needle)
    else
        needle = nil
    end

    local mods = {}
    for index, uuid in ipairs(order) do
        local ok, mod = pcall(Ext.Mod.GetMod, uuid)
        if ok and mod ~= nil and mod.Info ~= nil then
            local info = mod.Info
            local directory = tostring(info.Directory)
            local name = tostring(info.Name)

            local matches = needle == nil
                or string.find(string.lower(directory), needle, 1, true) ~= nil
                or string.find(string.lower(name), needle, 1, true) ~= nil

            if matches then
                mods[#mods + 1] = {
                    loadIndex = index,
                    directory = directory,
                    name = name,
                    author = tostring(info.Author),
                    uuid = tostring(info.ModuleUUIDString or info.ModuleUUID),
                    version = versionString(info.ModVersion),
                    -- Mods is keyed by the ModTable in ScriptExtender/Config.json.
                    -- That conventionally matches the directory but is not required
                    -- to, so a false here means "no Lua under this directory name",
                    -- not necessarily "no Lua at all".
                    luaLoaded = Mods ~= nil and Mods[directory] ~= nil,
                    dependencies = dependencyNames(mod),
                }
            end
        end
    end

    return { total = #order, returned = #mods, mods = mods }
end

--- Temporary appearance preview.
---
--- BG3 has no in-place visual swap: writing an equipped item's GameObjectVisual
--- does nothing, and Osi.AddCustomVisualOverride does not apply to equipment
--- (its removal counterpart is not even bound at runtime). The only working
--- approach, as used by shipped transmog mods, is to equip a *different item*.
---
--- A preview is much lighter than a real transmog, though, because it does not
--- need to stay playable: transmog mods copy ~25 components across so the item
--- keeps its stats, armour class and boosts, and several more components crash
--- the game if copied. We copy nothing, spawn with temporary=1, and put the
--- original back afterwards.
local preview = {
    active = false,
    character = nil,
    slot = nil,
    originalItem = nil,
    previewItem = nil,
    template = nil,
    equipped = false,
    lastError = nil,
}

local function previewStatus()
    return {
        active = preview.active,
        equipped = preview.equipped,
        character = preview.character,
        slot = preview.slot,
        template = preview.template,
        previewItem = preview.previewItem,
        originalItem = preview.originalItem,
        lastError = preview.lastError,
    }
end

local function restorePreview()
    if not preview.active then
        return previewStatus()
    end

    -- Re-equipping the original displaces the preview item; there is no Osi
    -- unequip, so this ordering matters.
    if preview.originalItem ~= nil and preview.originalItem ~= "" then
        pcall(function()
            Osi.Equip(preview.character, preview.originalItem, 1, 0, 1)
        end)
    end

    -- Equipping settles a moment later, so deleting immediately would be
    -- deleting a still-equipped item. Defer it.
    local doomed = preview.previewItem
    if doomed ~= nil and doomed ~= "" then
        Ext.Timer.WaitFor(200, function()
            pcall(function()
                Osi.RequestDelete(doomed)
            end)
        end)
    end

    local finished = previewStatus()
    preview.active = false
    preview.equipped = false
    preview.previewItem = nil
    preview.originalItem = nil
    preview.slot = nil
    preview.template = nil
    finished.restored = true
    return finished
end

H["item.preview"] = function(params)
    local action = params.action or "status"

    if action == "status" then
        return previewStatus()
    elseif action == "restore" then
        return restorePreview()
    elseif action ~= "apply" then
        error("unknown action: " .. tostring(action) .. " (expected apply, restore or status)")
    end

    if preview.active then
        error("a preview is already active (" .. tostring(preview.template) .. "); restore it first")
    end

    local templateId = params.template
    if type(templateId) ~= "string" or templateId == "" then
        error("params.template is required — a root template UUID, e.g. from bg3_find_template")
    end

    local template = Ext.Template.GetTemplate(templateId)
    if template == nil then
        error("no root template found with id: " .. tostring(templateId))
    end

    local character = params.character
    if type(character) ~= "string" or character == "" then
        character = Osi.GetHostCharacter()
    end

    -- temporary=1 so the engine treats it as disposable, playSpawn=0 to skip
    -- the spawn animation and sound.
    local spawned = Osi.CreateAt(template.Id, 0, 0, 0, 1, 0, "")
    if spawned == nil or spawned == "" then
        error("Osi.CreateAt returned nothing for template " .. tostring(templateId))
    end

    preview.active = true
    preview.equipped = false
    preview.character = tostring(character)
    preview.template = tostring(templateId)
    preview.previewItem = tostring(spawned)
    preview.originalItem = nil
    preview.slot = params.slot
    preview.lastError = nil

    -- Equipping immediately fails: the engine is still populating the entity.
    -- Armory found by experiment that a tick and 10ms are both too early and
    -- settled on 50ms, which matches what we see.
    Ext.Timer.WaitFor(50, function()
        local ok, err = pcall(function()
            -- Read the slot from the item's Equipable component, not from
            -- Osi.GetEquipmentSlotForItem: the latter returns an enum index
            -- ("1") that GetEquippedItem does not accept, so the original was
            -- silently never recorded and restore had nothing to put back.
            local slot = preview.slot
            if type(slot) ~= "string" or slot == "" then
                local entity = Ext.Entity.Get(preview.previewItem)
                if entity ~= nil then
                    pcall(function()
                        slot = tostring(entity.Equipable.Slot)
                    end)
                end
                preview.slot = (type(slot) == "string" and slot ~= "") and slot or nil
            end

            if preview.slot ~= nil then
                local current = Osi.GetEquippedItem(preview.character, preview.slot)
                if current ~= nil and current ~= "" then
                    preview.originalItem = tostring(current)
                end
            end

            Osi.Equip(preview.character, preview.previewItem, 1, 0, 1)
            preview.equipped = true
        end)

        if not ok then
            preview.lastError = tostring(err)
        end
    end)

    local status = previewStatus()
    status.pending = "equip scheduled in 50ms; read status to confirm"
    return status
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
