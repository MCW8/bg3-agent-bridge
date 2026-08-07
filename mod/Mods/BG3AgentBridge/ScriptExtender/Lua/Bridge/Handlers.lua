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

--- Split an asset name into the words a person would recognise.
--- "UNI_CRE_HUM_Sun_Mace_BloodOfLathander" becomes
--- uni, cre, hum, sun, mace, blood, of, lathander — which is what makes typo
--- matching feasible, since comparing a query against the whole mangled name
--- would always look wildly different.
local function tokenize(name)
    local spaced = string.gsub(tostring(name), '(%l)(%u)', '%1 %2')
    local tokens = {}
    for word in string.gmatch(string.lower(spaced), '[%w]+') do
        tokens[#tokens + 1] = word
    end
    return tokens
end

--- Levenshtein distance, abandoned as soon as it exceeds `maxDistance`.
--- The early exits matter: this runs across tens of thousands of candidates.
local function editDistance(a, b, maxDistance)
    local la, lb = #a, #b
    if math.abs(la - lb) > maxDistance then
        return maxDistance + 1
    end

    local previous, current = {}, {}
    for j = 0, lb do
        previous[j] = j
    end

    for i = 1, la do
        current[0] = i
        local best = i
        local byteA = string.byte(a, i)
        for j = 1, lb do
            local cost = (byteA == string.byte(b, j)) and 0 or 1
            local value = math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            current[j] = value
            if value < best then
                best = value
            end
        end
        if best > maxDistance then
            return maxDistance + 1
        end
        previous, current = current, previous
    end

    return previous[lb]
end

--- Score a candidate against an already-tokenized query.
---
--- Every query token has to find a near match among the candidate's tokens, and
--- the score is the total distance. Requiring all of them is what ranks
--- correctly: "blood lathandar" scores 1 against the mace, while a Lathander
--- portrait fails outright because nothing there resembles "blood". Matching on
--- any single token would rank them equal.
---
--- Returns nil when the candidate does not qualify.
local function fuzzyScore(text, queryTokens)
    local candidateTokens = tokenize(text)
    if #candidateTokens == 0 then
        return nil
    end

    local total = 0
    for _, queryToken in ipairs(queryTokens) do
        -- Tolerance scales with token length: roughly one edit per four
        -- characters.
        --
        -- A flat two-edit allowance was tried and measured worse. It rescued
        -- double typos like "bludd" for "blood", but at two edits "blood" also
        -- reaches "bld" — an abbreviation littered through scenery names — so
        -- "Blood of Lathandar" went from four hits with the right one first to
        -- fifteen with a gemstone on top. Catching one more typo is not worth
        -- burying the answer.
        local tolerance = math.max(1, math.floor(#queryToken / 4))
        local best = nil

        for _, candidateToken in ipairs(candidateTokens) do
            local distance = editDistance(candidateToken, queryToken, tolerance)
            if distance <= tolerance and (best == nil or distance < best) then
                best = distance
                if best == 0 then
                    break
                end
            end
        end

        if best == nil then
            return nil
        end
        total = total + best
    end

    return total
end

--- Query tokens worth matching on. Words under three characters ("of", "a")
--- are dropped: they carry no signal and would fail a candidate that simply
--- spells the name without them.
local function queryTokensFor(query)
    local tokens = {}
    for _, token in ipairs(tokenize(query)) do
        if #token >= 3 then
            tokens[#tokens + 1] = token
        end
    end
    return tokens
end

local function staticDataTypes()
    local names = {}
    pcall(function()
        for key in pairs(Ext.Enums.ExtResourceManagerType) do
            if type(key) == 'string' then
                names[#names + 1] = key
            end
        end
    end)
    table.sort(names)
    return names
end

--- Flatten a static data entry to its scalar fields.
local function summarizeStatic(entry, guid)
    local summary = { Guid = tostring(guid) }
    pcall(function()
        for key, value in pairs(entry) do
            local t = type(value)
            if t == 'string' or t == 'number' or t == 'boolean' then
                local text = tostring(value)
                if text ~= '' and text ~= '00000000-0000-0000-0000-000000000000' then
                    summary[key] = value
                end
            end
        end
    end)
    return summary
end

--- Search a static data type by name.
---
--- This is a third data layer beside resources and templates, and the one that
--- holds the pieces nothing else exposes: MultiEffectInfo (what a status
--- actually looks like), VFX, Flag, Tag, Race, Progression, SpellList.
--- Resolve a stat's DisplayName handle to the text a player sees.
local function statDisplayName(stat)
    local ok, handle = pcall(function()
        return tostring(stat.DisplayName)
    end)
    if not ok or handle == nil or handle == '' then
        return nil
    end
    local okText, text = pcall(function()
        return Ext.Loca.GetTranslatedString(handle)
    end)
    if not okText or text == nil then
        return nil
    end
    text = tostring(text)
    return text ~= '' and text or nil
end

--- Search stat entries by name or by the name players actually see.
---
--- Statuses, spells, armour and weapons all live here rather than in the
--- template or static data banks, and until now nothing could search them —
--- bg3_stats_get needed an exact name you already knew.
H["stats.find"] = function(params)
    local statType = params.type
    if type(statType) ~= 'string' or statType == '' then
        statType = 'StatusData'
    end

    local ok, names = pcall(function()
        return Ext.Stats.GetStats(statType)
    end)
    if not ok or type(names) ~= 'table' then
        error('unknown stat type: ' .. tostring(statType)
            .. '. Try StatusData, SpellData, Armor, Weapon, Object, Passive, Interrupt, Character.')
    end

    local needle = params.query
    if type(needle) == 'string' and needle ~= '' then
        needle = string.lower(needle)
    else
        needle = nil
    end
    local needleNormalized = needle and normalize(needle) or nil
    local queryTokens = needle and queryTokensFor(needle) or {}

    local limit = tonumber(params.limit) or 25
    if limit < 1 then limit = 1 elseif limit > 200 then limit = 200 end

    local clock = Ext.Utils ~= nil and Ext.Utils.MonotonicTime or nil
    local started = clock and clock() or nil

    local function summarize(name, stat, shown, distance)
        local entry = { Name = name, DisplayName = shown }
        for _, key in ipairs({ 'StatusType', 'SpellType', 'StatusEffect', 'Icon', 'Using', 'Level', 'Slot', 'ArmorType' }) do
            local okField, value = pcall(function()
                return stat[key]
            end)
            if okField and value ~= nil then
                local t = type(value)
                if t == 'string' or t == 'number' or t == 'boolean' then
                    local text = tostring(value)
                    if text ~= '' and text ~= 'None' then
                        entry[key] = value
                    end
                end
            end
        end
        -- Resolve the visual so a caller can see what it looks like without a
        -- second round trip.
        if entry.StatusEffect ~= nil then
            local okm, info = pcall(function()
                return Ext.StaticData.Get(tostring(entry.StatusEffect), 'MultiEffectInfo')
            end)
            if okm and info ~= nil then
                entry.StatusEffectName = tostring(info.Name)
            end
        end
        if distance ~= nil then
            entry.fuzzyDistance = distance
        end
        return entry
    end

    local results, matched = {}, 0
    local pool = {}

    for _, name in ipairs(names) do
        local stat = Ext.Stats.Get(name)
        if stat ~= nil then
            local shown = statDisplayName(stat)
            pool[#pool + 1] = { name = name, stat = stat, shown = shown }

            local hit = needle == nil
            if not hit then
                hit = string.find(string.lower(name), needle, 1, true) ~= nil
                    or string.find(normalize(name), needleNormalized, 1, true) ~= nil
                if not hit and shown ~= nil then
                    hit = string.find(string.lower(shown), needle, 1, true) ~= nil
                        or string.find(normalize(shown), needleNormalized, 1, true) ~= nil
                end
            end

            if hit then
                matched = matched + 1
                if #results < limit then
                    results[#results + 1] = summarize(name, stat, shown)
                end
            end
        end
    end

    local fuzzy = false
    if matched == 0 and #queryTokens > 0 then
        fuzzy = true
        local scored = {}
        for _, candidate in ipairs(pool) do
            local score = fuzzyScore(candidate.name, queryTokens)
            if score == nil and candidate.shown ~= nil then
                score = fuzzyScore(candidate.shown, queryTokens)
            end
            if score ~= nil then
                scored[#scored + 1] = { candidate = candidate, score = score }
            end
        end
        table.sort(scored, function(a, b)
            return a.score < b.score
        end)
        matched = #scored
        for index = 1, math.min(limit, #scored) do
            local c = scored[index].candidate
            results[#results + 1] = summarize(c.name, c.stat, c.shown, scored[index].score)
        end
    end

    return {
        type = statType,
        scanned = #names,
        matched = matched,
        returned = #results,
        truncated = matched > #results,
        fuzzy = fuzzy or nil,
        elapsedMs = started and (clock() - started) or nil,
        entries = results,
    }
end

H["staticdata.find"] = function(params)
    local dataType = params.type
    if type(dataType) ~= 'string' or dataType == '' then
        error('params.type is required, e.g. "MultiEffectInfo", "VFX", "Flag", "Tag". Valid: '
            .. table.concat(staticDataTypes(), ', '))
    end

    local ok, guids = pcall(function()
        return Ext.StaticData.GetAll(dataType)
    end)
    if not ok or type(guids) ~= 'table' then
        error('unknown static data type: ' .. tostring(dataType)
            .. '. Valid: ' .. table.concat(staticDataTypes(), ', '))
    end

    local needle = params.query
    if type(needle) == 'string' and needle ~= '' then
        needle = string.lower(needle)
    else
        needle = nil
    end
    local needleNormalized = needle and normalize(needle) or nil
    local queryTokens = needle and queryTokensFor(needle) or {}

    local limit = tonumber(params.limit) or 25
    if limit < 1 then
        limit = 1
    elseif limit > 200 then
        limit = 200
    end

    local clock = Ext.Utils ~= nil and Ext.Utils.MonotonicTime or nil
    local started = clock and clock() or nil

    local results, matched = {}, 0
    local entries = {}

    for _, guid in ipairs(guids) do
        local okGet, entry = pcall(function()
            return Ext.StaticData.Get(guid, dataType)
        end)
        if okGet and entry ~= nil then
            local name
            pcall(function()
                name = tostring(entry.Name)
            end)
            entries[#entries + 1] = { guid = guid, entry = entry, name = name }

            local hit = needle == nil
            if not hit and name ~= nil then
                hit = string.find(string.lower(name), needle, 1, true) ~= nil
                    or string.find(normalize(name), needleNormalized, 1, true) ~= nil
            end

            if hit then
                matched = matched + 1
                if #results < limit then
                    results[#results + 1] = summarizeStatic(entry, guid)
                end
            end
        end
    end

    -- Same fallback as template search: only pay for typo tolerance when the
    -- literal pass found nothing.
    local fuzzy = false
    if matched == 0 and #queryTokens > 0 then
        fuzzy = true
        local scored = {}
        for _, candidate in ipairs(entries) do
            if candidate.name ~= nil then
                local score = fuzzyScore(candidate.name, queryTokens)
                if score ~= nil then
                    scored[#scored + 1] = { candidate = candidate, score = score }
                end
            end
        end
        table.sort(scored, function(a, b)
            return a.score < b.score
        end)
        matched = #scored
        for index = 1, math.min(limit, #scored) do
            local summary = summarizeStatic(scored[index].candidate.entry, scored[index].candidate.guid)
            summary.fuzzyDistance = scored[index].score
            results[#results + 1] = summary
        end
    end

    return {
        type = dataType,
        scanned = #guids,
        matched = matched,
        returned = #results,
        truncated = matched > #results,
        fuzzy = fuzzy or nil,
        elapsedMs = started and (clock() - started) or nil,
        entries = results,
    }
end

--- Which statuses reference a given MultiEffectInfo, by name fragment.
---
--- The lookup that closes the loop: you can see an effect in game or find it by
--- name, but to actually use it you need the status that applies it, and
--- nothing indexes that direction.
H["status.usingEffect"] = function(params)
    local needle = params.query
    if type(needle) ~= 'string' or needle == '' then
        error('params.query is required — a fragment of the effect name, e.g. "ghost"')
    end
    needle = string.lower(needle)
    local needleNormalized = normalize(needle)

    local wanted = {}
    for _, guid in ipairs(Ext.StaticData.GetAll('MultiEffectInfo')) do
        local ok, info = pcall(function()
            return Ext.StaticData.Get(guid, 'MultiEffectInfo')
        end)
        if ok and info ~= nil then
            local name = tostring(info.Name)
            if string.find(string.lower(name), needle, 1, true) ~= nil
                or string.find(normalize(name), needleNormalized, 1, true) ~= nil
            then
                wanted[tostring(guid)] = name
            end
        end
    end

    local statuses = {}
    for _, statusName in ipairs(Ext.Stats.GetStats('StatusData')) do
        local stat = Ext.Stats.Get(statusName)
        if stat ~= nil then
            local ok, effect = pcall(function()
                return tostring(stat.StatusEffect)
            end)
            if ok and effect ~= nil and wanted[effect] ~= nil then
                statuses[#statuses + 1] = {
                    status = statusName,
                    statusType = tostring(stat.StatusType),
                    effect = wanted[effect],
                    effectGuid = effect,
                }
            end
        end
    end

    return { matchedEffects = wanted, statuses = statuses, count = #statuses }
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

    -- On by default: measured at 31ms across all ~32k templates, which is
    -- nothing against how often the wanted name is the player-facing one. Two
    -- real searches failed without it — "Marked for Negation" is a status
    -- called OBLITERATIONORB, sharing not one word with it.
    local searchDisplayNames = params.searchDisplayNames ~= false

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

    -- Nothing matched literally, so the query is probably misspelled or
    -- half-remembered. Only now is a fuzzy sweep worth its cost, and paying it
    -- exactly when the alternative is an empty answer is a good trade.
    local fuzzy = false
    local queryTokens = needle ~= nil and queryTokensFor(needle) or {}
    if matched == 0 and #queryTokens > 0 then
        fuzzy = true
        local scored = {}

        for _, template in pairs(all) do
            local name, templateType
            pcall(function()
                name = tostring(template.Name)
            end)
            pcall(function()
                templateType = tostring(template.TemplateType)
            end)

            local typeOk = wantType == nil
                or (templateType ~= nil and string.lower(templateType) == string.lower(wantType))

            if typeOk and name ~= nil then
                local score = fuzzyScore(name, queryTokens)
                if score == nil and searchDisplayNames then
                    local shown = displayNameOf(template)
                    if shown ~= nil then
                        score = fuzzyScore(shown, queryTokens)
                    end
                end
                if score ~= nil then
                    scored[#scored + 1] = { template = template, score = score }
                end
            end
        end

        -- Closest first, so the intended item leads even when several are near.
        table.sort(scored, function(a, b)
            return a.score < b.score
        end)

        matched = #scored
        for index = 1, math.min(limit, #scored) do
            local template = scored[index].template
            local entry = { fuzzyDistance = scored[index].score }
            pcall(function()
                entry.Id = tostring(template.Id)
            end)
            for _, key in ipairs(fields) do
                local ok, value = pcall(function()
                    return template[key]
                end)
                if ok and value ~= nil then
                    local asString = tostring(value)
                    if asString ~= ''
                        and asString ~= '00000000-0000-0000-0000-000000000000'
                        and not string.find(asString, '(0000', 1, true)
                    then
                        entry[key] = (type(value) == 'string' or type(value) == 'number' or type(value) == 'boolean')
                            and value
                            or asString
                    end
                end
            end
            entry.DisplayName = displayNameOf(template)
            results[#results + 1] = entry
        end
    end

    return {
        scanned = scanned,
        matched = matched,
        returned = #results,
        truncated = matched > #results,
        fuzzy = fuzzy or nil,
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
--- Equipment slots as Osiris names them. Note these are NOT the names an item's
--- Equipable component reports: a weapon's component says "MeleeMainHand" while
--- Osi.GetEquippedItem only answers to "Melee Main Weapon". Armour happens to
--- agree ("Breast"), which is why an earlier version appeared to work.
local OSIRIS_SLOTS = {
    'Helmet',
    'Breast',
    'Cloak',
    'Gloves',
    'Boots',
    'Underwear',
    'Amulet',
    'Ring',
    'Ring2',
    'MusicalInstrument',
    'VanityBody',
    'VanityBoots',
    'Melee Main Weapon',
    'Melee Offhand Weapon',
    'Ranged Main Weapon',
    'Ranged Offhand Weapon',
}

--- What is worn right now, keyed by Osiris slot name.
---
--- Snapshotting everything and diffing afterwards avoids translating between
--- the two slot vocabularies at all — whichever slot changed is the one the
--- game chose, and its previous occupant is what has to go back.
local function snapshotEquipment(character)
    local worn = {}
    for _, slot in ipairs(OSIRIS_SLOTS) do
        local ok, item = pcall(function()
            return Osi.GetEquippedItem(character, slot)
        end)
        if ok and item ~= nil and item ~= '' and tostring(item) ~= 'nil' then
            worn[slot] = tostring(item)
        end
    end
    return worn
end

local preview = {
    active = false,
    character = nil,
    slot = nil,
    originalItem = nil,
    previewItem = nil,
    template = nil,
    equipped = false,
    lastError = nil,
    before = nil,
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

    -- Record what is worn before anything changes; the diff after equipping is
    -- what identifies both the slot and the item to restore.
    local before = snapshotEquipment(character)

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
    preview.before = before

    -- Equipping immediately fails: the engine is still populating the entity.
    -- Armory found by experiment that a tick and 10ms are both too early and
    -- settled on 50ms, which matches what we see.
    Ext.Timer.WaitFor(50, function()
        local ok, err = pcall(function()
            Osi.Equip(preview.character, preview.previewItem, 1, 0, 1)
            preview.equipped = true
        end)

        if not ok then
            preview.lastError = tostring(err)
            return
        end

        -- Equipping settles a moment after the call, so read the result on a
        -- second timer rather than immediately.
        Ext.Timer.WaitFor(150, function()
            pcall(function()
                local after = snapshotEquipment(preview.character)
                for slot, occupant in pairs(after) do
                    if occupant == preview.previewItem then
                        preview.slot = slot
                        -- Whatever was in this slot beforehand is what restore
                        -- has to put back. Absent means the slot was empty.
                        preview.originalItem = preview.before and preview.before[slot] or nil
                    end
                end
                preview.before = nil
            end)
        end)
    end)

    local status = previewStatus()
    status.pending = "equip scheduled in 50ms; read status to confirm"
    return status
end

--- Statuses applied for auditioning, so they can all be cleared afterwards.
--- Tracked rather than relying on duration: an EFFECT status with a long or
--- permanent duration would otherwise be left on the character.
local previewedStatuses = {}

H["status.preview"] = function(params)
    local action = params.action or 'status'

    local character = params.character
    if type(character) ~= 'string' or character == '' then
        character = tostring(Osi.GetHostCharacter())
    end

    local function activeStatuses()
        local active = {}
        pcall(function()
            local entity = Ext.Entity.Get(character)
            for _, status in pairs(entity.ServerCharacter.StatusManager.Statuses) do
                active[#active + 1] = tostring(status.StatusId)
            end
        end)
        return active
    end

    if action == 'list' or action == 'status' then
        return {
            character = character,
            applied = previewedStatuses,
            active = activeStatuses(),
        }
    end

    if action == 'clear' then
        local removed = {}
        for _, name in ipairs(previewedStatuses) do
            pcall(function()
                Osi.RemoveStatus(character, name)
            end)
            removed[#removed + 1] = name
        end
        previewedStatuses = {}
        return { character = character, removed = removed }
    end

    if action == 'remove' then
        local name = params.status
        if type(name) ~= 'string' or name == '' then
            error('params.status is required for remove')
        end
        pcall(function()
            Osi.RemoveStatus(character, name)
        end)
        for index, tracked in ipairs(previewedStatuses) do
            if tracked == name then
                table.remove(previewedStatuses, index)
                break
            end
        end
        return { character = character, removed = name, active = activeStatuses() }
    end

    if action ~= 'apply' then
        error('unknown action: ' .. tostring(action) .. ' (expected apply, remove, clear, list)')
    end

    local name = params.status
    if type(name) ~= 'string' or name == '' then
        error('params.status is required — a status name, e.g. "GHOST_FX"')
    end

    local stat = Ext.Stats.Get(name)
    if stat == nil then
        error('no status named "' .. tostring(name) .. '" — check bg3_find_status or bg3_stats_get')
    end

    local duration = tonumber(params.duration) or 60.0
    local ok, err = pcall(function()
        Osi.ApplyStatus(character, name, duration, 1, character)
    end)
    if not ok then
        error('ApplyStatus failed: ' .. tostring(err))
    end

    local alreadyTracked = false
    for _, tracked in ipairs(previewedStatuses) do
        if tracked == name then
            alreadyTracked = true
        end
    end
    if not alreadyTracked then
        previewedStatuses[#previewedStatuses + 1] = name
    end

    return {
        character = character,
        applied = name,
        statusType = tostring(stat.StatusType),
        duration = duration,
        note = 'Osiris applies this a moment later; read back with action=list to confirm.',
    }
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
