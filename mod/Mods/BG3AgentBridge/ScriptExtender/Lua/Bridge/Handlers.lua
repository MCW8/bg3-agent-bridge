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

    -- Namespace-qualified names often index under the joined short form:
    -- eoc::status::ContainerComponent is reached as e.StatusContainer, and
    -- none of the aliases above produce that (probed live). Any wrong guess
    -- costs one pcall, which resolveComponent already pays per candidate.
    local parts = {}
    for segment in string.gmatch(name, "[^:]+") do
        parts[#parts + 1] = segment
    end
    if #parts > 2 then
        local joined = {}
        for i = 2, #parts do
            local segment = parts[i]
            if i == #parts then
                segment = (string.gsub(segment, "Component$", ""))
            end
            joined[#joined + 1] = string.upper(string.sub(segment, 1, 1)) .. string.sub(segment, 2)
        end
        add(table.concat(joined))
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

--- Characters spawned through this handler, so despawn and clear can find
--- them again. CreateAt writes the character into the save — without tracking,
--- the only way back from an unwanted spawn is reloading the save. A VM reset
--- (bg3_reload) loses this list while the characters persist, so clear can no
--- longer reach them afterwards.
local spawnedCharacters = {}

--- An entity id stays valid after SetOnStage(id, 0) — the character is
--- offloaded, not destroyed — so existence is no proof it is still in the
--- world. IsOnStage answers the question that matters.
local function onStage(id)
    local stage = false
    pcall(function()
        stage = Osi.IsOnStage(id) == 1
    end)
    return stage
end

H["character.spawn"] = function(params)
    local action = params.action or "list"

    if action == "list" then
        local entries = {}
        for _, entry in ipairs(spawnedCharacters) do
            entries[#entries + 1] = {
                id = entry.id,
                template = entry.template,
                templateName = entry.templateName,
                x = entry.x,
                y = entry.y,
                z = entry.z,
                onStage = onStage(entry.id),
            }
        end
        return { spawned = entries, count = #entries }
    end

    if action == "despawn" then
        local id = params.id
        if type(id) ~= "string" or id == "" then
            error("params.id is required for despawn — a character UUID from action=list")
        end
        local ok, err = pcall(function()
            Osi.SetOnStage(id, 0)
        end)
        if not ok then
            error("SetOnStage failed: " .. tostring(err))
        end
        for index, entry in ipairs(spawnedCharacters) do
            if entry.id == id then
                table.remove(spawnedCharacters, index)
                break
            end
        end
        return { despawned = id, tracked = #spawnedCharacters }
    end

    if action == "clear" then
        local removed = {}
        for _, entry in ipairs(spawnedCharacters) do
            pcall(function()
                Osi.SetOnStage(entry.id, 0)
            end)
            removed[#removed + 1] = entry.id
        end
        spawnedCharacters = {}
        return { removed = removed, count = #removed }
    end

    if action ~= "spawn" then
        error("unknown action: " .. tostring(action) .. " (expected spawn, despawn, clear or list)")
    end

    local templateId = params.template
    if type(templateId) ~= "string" or templateId == "" then
        error("params.template is required — a character template UUID, e.g. from bg3_find_template")
    end

    local template = Ext.Template.GetTemplate(templateId)
    if template == nil then
        error("no root template found with id: " .. tostring(templateId))
    end
    -- Spawning the wrong type is legal as far as CreateAt is concerned but
    -- rarely the intent, and an item dropped at world coordinates is hard to
    -- spot. Name what was passed rather than silently spawning it.
    if tostring(template.TemplateType) ~= "character" then
        error(
            "template " .. tostring(templateId) .. " is a " .. tostring(template.TemplateType)
                .. ", not a character — pass a character template from bg3_find_template"
        )
    end

    -- Explicit x/y/z wins; otherwise the spawn lands `offset` metres from
    -- `near` (default: the host character), which is what an agent wants nine
    -- times out of ten and saves a GetPosition round trip.
    local x, y, z
    if params.x ~= nil and params.y ~= nil and params.z ~= nil then
        x, y, z = tonumber(params.x), tonumber(params.y), tonumber(params.z)
        if x == nil or y == nil or z == nil then
            error("params.x, params.y and params.z must be numbers")
        end
    else
        local near = params.near
        if type(near) ~= "string" or near == "" then
            near = Osi.GetHostCharacter()
        end
        if near == nil then
            error("no host character (is a save loaded?) — pass params.near or explicit x, y and z")
        end
        local nx, ny, nz = Osi.GetPosition(near)
        if nx == nil then
            error("could not read the position of " .. tostring(near) .. " — pass explicit x, y and z")
        end
        local offset = tonumber(params.offset) or 2.0
        x, y, z = nx + offset, ny, nz
    end

    local name = params.name
    if type(name) ~= "string" then
        name = ""
    end

    -- CreateAt's arity is fixed at 7 and no shorter form binds — calls with
    -- fewer arguments fail with "No function named 'CreateAt' exists that can
    -- be called with N parameters", which never says the wanted count. The
    -- order is (templateId, x, y, z, temporary, playSpawn, customName); the
    -- fifth argument is `temporary`, not `playSpawn`. temporary=1 marks the
    -- entity disposable (how bg3_preview_item spawns its gear); a character
    -- meant to persist in the save stays 0.
    local playSpawn = params.playSpawn and 1 or 0
    local spawned = Osi.CreateAt(template.Id, x, y, z, 0, playSpawn, name)
    if spawned == nil or spawned == "" then
        error("Osi.CreateAt returned nothing for template " .. tostring(templateId))
    end

    spawnedCharacters[#spawnedCharacters + 1] = {
        id = tostring(spawned),
        template = tostring(templateId),
        templateName = tostring(template.Name),
        x = x,
        y = y,
        z = z,
    }

    return {
        spawned = tostring(spawned),
        template = tostring(templateId),
        templateName = tostring(template.Name),
        position = { x = x, y = y, z = z },
        tracked = #spawnedCharacters,
        note = "the engine finishes populating the entity a beat later; verify with bg3_entity_inspect",
    }
end

--- Animation auditioning and idle overriding.
---
--- Hard-won facts behind this handler, all probed against the live game:
---
--- * Osi.PlayAnimation resolves ONLY the bare AnimationShortName GUID.
---   Appending the "(name)" suffix — the exact format status AnimationLoop
---   fields display — turns the call into a silent no-op. So strip it.
--- * Osi.PlayLoopingAnimation is real but looks dead: every arity from 2-6
---   fails with "No function named ...", and the true signature is EIGHT
---   arguments with the animation reference in position 3:
---       PlayLoopingAnimation(character, "", guid, "", "", "", "", "")
---   It loops Looping=false animations continuously and holds statue poses
---   indefinitely. Movement is blocked while one runs; crouching (sneak)
---   breaks the loop one-way — it does not resume when you stop moving.
---   End one with Osi.StopAnimation(character, 1) — the second argument is
---   the animation channel, a number, which is why string forms error with
---   "Number expected for argument 3". The looping-call signature comes
---   from the source of the Emotes mod by claravel; the bogus-name
---   PlayLoopingAnimation that mod uses in one ping handler is NOT a
---   general cancel — tried it, the loop kept running.
--- * The status AnimationLoop field (Hold Person's freeze) is ignored on
---   BOOST-type statuses — a correctly formatted reference played nothing.
---   It is part of the incapacitation mechanism, not an idle override.
--- * The persistent idle override that works on any character is a status
---   with StillAnimationType set (the enum behind "Dazed" etc.), carried by
---   a status with no Boosts and no RemoveEvents so nothing else rides
---   along. Still types without art for the race freeze the character
---   mid-pose (ORTHON_LAUGH on an elf), which list flags where visible.
--- * Osi.Freeze is a story-event control lock, not an animation hold, and
---   the Animation resource Offset field silences playback when set — so a
---   photo-mode pose (a Timing marker inside a parent animation) cannot be
---   held at an arbitrary frame; loop the parent animation instead.
---
--- All of it is session-only: runtime stat edits and applied statuses die
--- with a VM reset or save reload, which is exactly what an auditioning
--- tool wants.

--- Active native loops, keyed by character:guid, so stop and clear can end
--- them with StopAnimation(character, 1).
local animationLoops = {}

--- The one active carrier-status override: idle (StillAnimationType edit)
--- and animset (DynamicAnimationTag edit) share a carrier status, so they
--- are mutually exclusive — the same single-active pattern as item.preview.
--- Fields: kind ("idle"|"animset"), carrier, character, duration,
--- restoreStill (string to put back, nil = field was never edited),
--- restoreTag (string to put back, FALSE = restore to absent — writing ""
--- is rejected by the stats proxy while nil clears, and nil = never edited).
local activeOverride = nil

local function clearCarrierOverride()
    if activeOverride == nil then
        return nil
    end
    local finished = activeOverride
    pcall(function()
        Osi.RemoveStatus(finished.character, finished.carrier)
    end)
    if finished.restoreStill ~= nil or finished.restoreTag ~= nil then
        local stat = Ext.Stats.Get(finished.carrier)
        if stat ~= nil then
            if finished.restoreStill ~= nil then
                stat.StillAnimationType = finished.restoreStill
            end
            if finished.restoreTag ~= nil then
                if finished.restoreTag == false then
                    stat.DynamicAnimationTag = nil
                else
                    stat.DynamicAnimationTag = finished.restoreTag
                end
            end
            if type(stat.Sync) == "function" then
                stat:Sync()
            end
        end
    end
    activeOverride = nil
    return { kind = finished.kind, carrier = finished.carrier, character = finished.character }
end

--- The AnimationShortName GUID is not the animation resource's GUID; the
--- only link is the name embedded in the GR2 path (…_PM_FlyingKiss_01.GR2).
--- A full Animation-bank scan costs ~1s, so results (and misses) are cached
--- per name. Duration is uniform across rig variants for the animations
--- checked, so the first hit answers for every race.
local animationDurationCache = {}

local function animationDuration(name)
    if type(name) ~= "string" or name == "" then
        return nil
    end
    local cached = animationDurationCache[name]
    if cached ~= nil then
        return cached or nil -- false marks a prior miss
    end

    local needle = normalize(name)
    local found = nil
    for _, guid in ipairs(Ext.Resource.GetAll("Animation")) do
        local ok, resource = pcall(function()
            return Ext.Resource.Get(guid, "Animation")
        end)
        if ok and resource ~= nil then
            local path = tostring(resource.Template) .. " " .. tostring(resource.SourceFile)
            if string.find(normalize(path), needle, 1, true) ~= nil then
                local duration = tonumber(resource.Duration)
                if duration ~= nil and duration > 0 then
                    found = duration
                    break
                end
            end
        end
    end
    animationDurationCache[name] = found or false
    return found
end

--- A GUID passed directly skips the name search, but the name is still worth
--- having: it is the key into the duration lookup. 8.8k static entries — a
--- cheap scan compared to the 101k animation bank.
local function nameForAnimationGuid(guid)
    local lowered = string.lower(guid)
    for _, entryGuid in ipairs(Ext.StaticData.GetAll("AnimationShortName")) do
        local ok, entry = pcall(function()
            return Ext.StaticData.Get(entryGuid, "AnimationShortName")
        end)
        if ok and entry ~= nil and string.lower(tostring(entry.ResourceUUID)) == lowered then
            return tostring(entry.Name)
        end
    end
    return nil
end

--- Resolve an animation reference to the bare GUID PlayAnimation wants.
--- Accepts a GUID, a "GUID(name)" pair (suffix stripped — it breaks the
--- call), or a name to search in AnimationShortName static data. Returns
--- guid, name, matches — matches has every candidate when searching by
--- name, so find and "picked X of N" reporting share one lookup.
local function resolveAnimation(query)
    if type(query) ~= "string" or query == "" then
        error("params.animation is required — an AnimationShortName GUID or name, e.g. from action=find")
    end

    local guid = string.match(query, "^(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)")
    if guid ~= nil then
        guid = string.lower(guid)
        return guid, nameForAnimationGuid(guid), nil
    end

    local needle = normalize(query)
    local matches = {}
    for _, entryGuid in ipairs(Ext.StaticData.GetAll("AnimationShortName")) do
        local ok, entry = pcall(function()
            return Ext.StaticData.Get(entryGuid, "AnimationShortName")
        end)
        if ok and entry ~= nil then
            local name = tostring(entry.Name)
            if string.find(normalize(name), needle, 1, true) ~= nil then
                matches[#matches + 1] = { guid = tostring(entry.ResourceUUID), name = name }
            end
        end
    end
    table.sort(matches, function(a, b)
        return a.name < b.name
    end)

    if #matches == 0 then
        error("no AnimationShortName matching: " .. query)
    end
    return matches[1].guid, matches[1].name, matches
end

--- Every StillAnimationType in use, with example statuses and whether a
--- clean carrier exists — a status with no Boosts and no RemoveEvents, so
--- the idle override brings nothing but the animation. DRUNK is the proof
--- that these re-assert after movement; PERFORM_* statuses are not, they
--- are sessions that movement cancels.
local function stillAnimationTypes()
    local types = {}
    for _, name in ipairs(Ext.Stats.GetStats("StatusData")) do
        local stat = Ext.Stats.Get(name)
        local ok, stillType = pcall(function()
            return tostring(stat.StillAnimationType)
        end)
        if ok and stillType ~= nil and stillType ~= "" and stillType ~= "None" then
            local bucket = types[stillType]
            if bucket == nil then
                bucket = { type = stillType, carriers = {}, examples = {} }
                types[stillType] = bucket
            end
            local boosts = tostring(stat.Boosts)
            local removeCount = 0
            for _ in pairs(stat.RemoveEvents) do
                removeCount = removeCount + 1
            end
            if boosts == "" and removeCount == 0 and #bucket.carriers < 4 then
                bucket.carriers[#bucket.carriers + 1] = name
            elseif #bucket.examples < 4 then
                bucket.examples[#bucket.examples + 1] = name
            end
        end
    end

    local out = {}
    for _, bucket in pairs(types) do
        out[#out + 1] = bucket
    end
    table.sort(out, function(a, b)
        return a.type < b.type
    end)
    return out
end

local function stopAllLoops()
    local stoppedLoops = 0
    local cancelled = {}
    for _, entry in pairs(animationLoops) do
        stoppedLoops = stoppedLoops + 1
        -- The cancel is StopAnimation with a numeric second argument — the
        -- loop channel — NOT the bogus-name PlayLoopingAnimation call, which
        -- the Emotes mod uses only as a one-off pose interrupt and which left
        -- a looped kneel running when tried as a general cancel.
        if cancelled[entry.character] == nil then
            pcall(function()
                Osi.StopAnimation(entry.character, 1)
            end)
            cancelled[entry.character] = true
        end
    end
    animationLoops = {}
    return stoppedLoops
end

local function clearAnimationState()
    local stoppedLoops = stopAllLoops()
    local clearedOverride = clearCarrierOverride()
    return { stoppedLoops = stoppedLoops, overrideCleared = clearedOverride }
end

--- Every AnimationSetPriority entry — the named locomotion override sets
--- (Zombie, on_all_fours, Bladesong, crowd sits and staggers, …). A status
--- whose DynamicAnimationTag holds one of these GUIDs swaps the character's
--- whole animation set — idle, walk, run — through the same channel RAGE
--- and Bladesong use, so movement is never blocked. The mechanism and the
--- carrier recipe (hidden BOOST status, toggleable passive) come from the
--- On All Fours Toggle mod, which ships no animation data at all: its crawl
--- set is the base game's own, merely tagged in.
local function animationSets()
    local sets = {}
    for _, g in ipairs(Ext.StaticData.GetAll("AnimationSetPriority")) do
        local ok, entry = pcall(function()
            return Ext.StaticData.Get(g, "AnimationSetPriority")
        end)
        if ok and entry ~= nil then
            sets[#sets + 1] = {
                name = tostring(entry.Name),
                priority = tonumber(entry.Priority),
                guid = string.lower(tostring(entry.ResourceUUID)),
            }
        end
    end
    table.sort(sets, function(a, b)
        return a.name < b.name
    end)
    return sets
end

--- The cleanest status already carrying a given animation tag: no Boosts
--- and no RemoveEvents, so the override brings nothing but the animation
--- set. Returns the status name, or nil when no clean carrier exists and
--- the caller should edit a carrier itself.
local function cleanCarrierForTag(guid)
    local lowered = string.lower(guid)
    for _, name in ipairs(Ext.Stats.GetStats("StatusData")) do
        local stat = Ext.Stats.Get(name)
        local ok, tag = pcall(function()
            return string.lower(tostring(stat.DynamicAnimationTag))
        end)
        if ok and tag == lowered then
            local boosts = tostring(stat.Boosts)
            local removeCount = 0
            for _ in pairs(stat.RemoveEvents) do
                removeCount = removeCount + 1
            end
            if boosts == "" and removeCount == 0 then
                return name
            end
        end
    end
    return nil
end

H["animation"] = function(params)
    local action = params.action or "list"

    if action == "clear" then
        return clearAnimationState()
    end

    if action == "list" then
        local loops = {}
        for key, entry in pairs(animationLoops) do
            loops[#loops + 1] = { key = key, character = entry.character, guid = entry.guid, name = entry.name }
        end
        local sets = animationSets()
        for _, set in ipairs(sets) do
            set.cleanCarrier = cleanCarrierForTag(set.guid)
        end
        return {
            stillTypes = stillAnimationTypes(),
            animationSets = sets,
            activeLoops = loops,
            activeOverride = activeOverride,
            defaultCarrier = "ANIM_COWER",
        }
    end

    if action == "find" then
        local guid, name, matches = resolveAnimation(params.query or params.animation)
        -- One bank scan per distinct name, cached; beyond ten matches the
        -- scans cost more than the information is worth.
        if #matches <= 10 then
            for _, match in ipairs(matches) do
                match.durationSeconds = animationDuration(match.name)
            end
        end
        return { matched = #matches, animations = matches }
    end

    local character = params.character
    if type(character) ~= "string" or character == "" then
        character = Osi.GetHostCharacter()
    end
    if character == nil then
        error("no host character (is a save loaded?) — pass params.character")
    end

    if action == "play" then
        local guid, name = resolveAnimation(params.animation)
        local ok, err = pcall(function()
            Osi.PlayAnimation(character, guid, "")
        end)
        if not ok then
            error("PlayAnimation failed: " .. tostring(err))
        end
        return { played = guid, name = name, character = character, durationSeconds = animationDuration(name) }
    end

    if action == "loop" then
        local guid, name = resolveAnimation(params.animation)
        local ok, err = pcall(function()
            Osi.PlayLoopingAnimation(character, "", guid, "", "", "", "", "")
        end)
        if not ok then
            error("PlayLoopingAnimation failed: " .. tostring(err))
        end
        local key = tostring(character) .. ":" .. guid
        animationLoops[key] = { character = character, guid = guid, name = name }
        return {
            looping = key,
            name = name,
            durationSeconds = animationDuration(name),
            note = "engine loop: holds statue poses, loops animations continuously. Movement is blocked while it runs — crouching breaks it one-way, or use stop/clear",
        }
    end

    if action == "stop" then
        -- Loops only: stop must not tear down an idle override, which is an
        -- independent state the user asked for separately.
        local stopped = stopAllLoops()
        return { stoppedLoops = stopped }
    end

    if action == "idle" then
        local stillType = params.stillType
        if type(stillType) ~= "string" or stillType == "" then
            error("params.stillType is required for idle — see action=list for the valid values")
        end

        local known = nil
        for _, bucket in ipairs(stillAnimationTypes()) do
            if string.lower(bucket.type) == string.lower(stillType) then
                known = bucket.type
                break
            end
        end
        if known == nil then
            error("unknown StillAnimationType: " .. stillType .. " — see action=list for the values in use")
        end

        local carrier = params.carrier
        if type(carrier) ~= "string" or carrier == "" then
            carrier = "ANIM_COWER"
        end
        local stat = Ext.Stats.Get(carrier)
        if stat == nil then
            error("no status named: " .. tostring(carrier))
        end
        if tostring(stat.Boosts) ~= "" and params.allowBoosts ~= true then
            error(
                "carrier " .. carrier .. " has Boosts (" .. tostring(stat.Boosts)
                    .. ") — the idle override would carry mechanics with it. Pick a clean carrier from action=list, or pass allowBoosts=true."
            )
        end

        -- One override at a time, like item.preview: stacked edits would lose
        -- the original values the restore depends on.
        if activeOverride ~= nil then
            clearCarrierOverride()
        end

        local duration = tonumber(params.duration) or 600.0
        local originalStill = tostring(stat.StillAnimationType)
        stat.StillAnimationType = known
        if type(stat.Sync) == "function" then
            stat:Sync()
        end

        pcall(function()
            Osi.RemoveStatus(character, carrier)
        end)
        local ok, err = pcall(function()
            Osi.ApplyStatus(character, carrier, duration, 1, character)
        end)
        if not ok then
            stat.StillAnimationType = originalStill
            if type(stat.Sync) == "function" then
                stat:Sync()
            end
            error("ApplyStatus failed: " .. tostring(err))
        end

        activeOverride = {
            kind = "idle",
            carrier = carrier,
            character = tostring(character),
            duration = duration,
            restoreStill = originalStill,
            restoreTag = nil,
        }
        return {
            idle = known,
            carrier = carrier,
            character = tostring(character),
            duration = duration,
            note = "re-asserts whenever the character stands still; if the race has no art for this still type the character freezes mid-pose instead — clear and pick another",
        }
    end

    if action == "animset" then
        local setName = params.set
        if type(setName) ~= "string" or setName == "" then
            error("params.set is required for animset — an AnimationSetPriority name, e.g. \"Zombie\"; see action=list")
        end

        local needle = normalize(setName)
        local chosen = nil
        for _, set in ipairs(animationSets()) do
            if normalize(set.name) == needle then
                chosen = set
                break
            elseif chosen == nil and string.find(normalize(set.name), needle, 1, true) ~= nil then
                chosen = set
            end
        end
        if chosen == nil then
            error("no animation set matching: " .. setName .. " — see action=list for the valid names")
        end

        if activeOverride ~= nil then
            clearCarrierOverride()
        end

        local duration = tonumber(params.duration) or 600.0
        local carrier = cleanCarrierForTag(chosen.guid)
        local edited = false
        local restoreTag, restoreStill = nil, nil

        if carrier == nil then
            -- No clean status already carries this tag: edit one in. The
            -- carrier's StillAnimationType is neutralised too — a lingering
            -- still type would fight the override set for the idle slot.
            carrier = params.carrier
            if type(carrier) ~= "string" or carrier == "" then
                carrier = "ANIM_COWER"
            end
            local stat = Ext.Stats.Get(carrier)
            if stat == nil then
                error("no status named: " .. tostring(carrier))
            end
            if tostring(stat.Boosts) ~= "" and params.allowBoosts ~= true then
                error(
                    "carrier " .. carrier .. " has Boosts (" .. tostring(stat.Boosts)
                        .. ") — the animset override would carry mechanics with it. Pick a clean carrier, or pass allowBoosts=true."
                )
            end
            local rawTag = stat.DynamicAnimationTag
            -- An absent GUID field does not read as Lua nil: the stats proxy
            -- returns a sentinel userdata whose tostring is "nil". Treat that
            -- (and empty/zero GUID) as absent; false marks "restore to
            -- absent" because the proxy rejects "" but accepts assigning nil.
            local tagString = tostring(rawTag)
            local tagAbsent = rawTag == nil
                or tagString == "nil"
                or tagString == ""
                or tagString == "00000000-0000-0000-0000-000000000000"
            -- `tagAbsent and false or tagString` can never yield false —
            -- false is falsy, so the or-chain falls through. Assign plainly.
            if tagAbsent then
                restoreTag = false
            else
                restoreTag = tagString
            end
            restoreStill = tostring(stat.StillAnimationType)
            stat.DynamicAnimationTag = chosen.guid
            stat.StillAnimationType = "None"
            if type(stat.Sync) == "function" then
                stat:Sync()
            end
            edited = true
        end

        pcall(function()
            Osi.RemoveStatus(character, carrier)
        end)
        local ok, err = pcall(function()
            Osi.ApplyStatus(character, carrier, duration, 1, character)
        end)
        if not ok then
            if edited then
                local stat = Ext.Stats.Get(carrier)
                if restoreTag == false then
                    stat.DynamicAnimationTag = nil
                else
                    stat.DynamicAnimationTag = restoreTag
                end
                stat.StillAnimationType = restoreStill
                if type(stat.Sync) == "function" then
                    stat:Sync()
                end
            end
            error("ApplyStatus failed: " .. tostring(err))
        end

        activeOverride = {
            kind = "animset",
            carrier = carrier,
            character = tostring(character),
            duration = duration,
            restoreStill = restoreStill,
            restoreTag = restoreTag,
        }
        return {
            animset = chosen.name,
            priority = chosen.priority,
            carrier = carrier,
            carrierEdited = edited,
            character = tostring(character),
            duration = duration,
            note = "locomotion override: idle, walk and run all come from the set while the status lasts, with normal movement — no crouch tricks",
        }
    end

    error("unknown action: " .. tostring(action) .. " (expected find, play, loop, stop, idle, animset, clear or list)")
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

--- The environment eval chunks run in ---------------------------------------
--
-- Probed against the live game: chunks from SE's one-arg load() land in the
-- SHARED global table (_ENV == _G inside the chunk; a global set in one eval
-- is visible in the next; bridge-mod globals like BG3AgentBridge are not
-- visible). The handler's own `_G` is the bridge mod's PRIVATE global table —
-- a different table — so patching print from the handler side never reached
-- the chunk (first attempt captured nothing). SE's load() takes an
-- environment table as its second argument, which settles this cleanly: each
-- eval compiles the chunk with a per-call environment that chains reads AND
-- writes to the shared globals (cross-eval state keeps working), with print
-- and the mod context shadowed per call. No global patching, nothing to
-- restore, no leak when a call fails.

local function sharedGlobals()
    if Bridge.evalSharedGlobals == nil then
        local probe = Bridge.compile("return _G")
        if probe ~= nil then
            local ok, g = pcall(probe)
            if ok and type(g) == "table" then
                Bridge.evalSharedGlobals = g
            end
        end
    end
    return Bridge.evalSharedGlobals
end

local function recordPrint(prints, ...)
    local parts = {}
    for i = 1, select("#", ...) do
        parts[i] = tostring((select(i, ...)))
    end
    prints[#prints + 1] = table.concat(parts, " ")
end

--- Build the per-call environment for an eval chunk. Raises when modContext
--- names a mod that is not loaded or has no PersistentVars — before anything
--- is patched, so a failure leaves nothing to clean up.
local function buildEvalEnv(prints, modFolder)
    local shared = sharedGlobals()
    if shared == nil then
        error("could not discover the shared global table for eval")
    end

    local env = {}
    local realPrint = rawget(shared, "print")
    if type(realPrint) == "function" then
        env.print = function(...)
            recordPrint(prints, ...)
            return realPrint(...)
        end
    end

    -- SE scopes PersistentVars per mod and the bridge mod has none, which made
    -- a bare `PersistentVars` reference in eval a nil-index error. Shadowing
    -- the target mod's table into the chunk env makes it just work. Mods is
    -- resolved through the shared globals: the handler's own `Mods` is not
    -- guaranteed to be the table the chunk sees (same trap as Ext.Utils).
    if modFolder ~= nil and modFolder ~= "" then
        local mods = type(shared.Mods) == "table" and shared.Mods or nil
        local mod = mods ~= nil and mods[modFolder] or nil
        if mod == nil then
            error(
                'no loaded mod with folder name "'
                    .. tostring(modFolder)
                    .. '" — check bg3_list_mods for the folder (directory) name, not the display name'
            )
        end
        if type(mod.PersistentVars) ~= "table" then
            error('mod "' .. tostring(modFolder) .. '" has no PersistentVars table in this context')
        end
        env.PersistentVars = mod.PersistentVars
        env.ModuleUUID = mod.ModuleUUID
    end

    return setmetatable(env, { __index = shared, __newindex = shared })
end

--- Ext.Utils.Print is a shared table field the chunk reaches through Ext, so
--- shadowing it in the eval env does nothing — the field itself is wrapped for
--- the duration of the call (plus any capture window), forwarding to the real
--- one. Restore is unconditional on every exit path.
--- Ext.Utils.Print is reached through the Ext table of the chunk's
--- environment — which is NOT the table the handler's `Ext` resolves to
--- (probed: a handler-side write "took" but chunk-side calls were unaffected;
--- SE gives the bridge mod its own Ext). Patch through the shared globals the
--- chunk actually reads. The wrapper forwards to the real Print, so log
--- behaviour is unchanged, and restore runs on every exit path.
local function installUtilsPrintCapture(prints, shared)
    local utils = type(shared) == "table" and type(shared.Ext) == "table" and shared.Ext.Utils or nil
    if type(utils) ~= "table" or type(utils.Print) ~= "function" then
        return function() end
    end
    local real = utils.Print
    local active = true
    utils.Print = function(...)
        recordPrint(prints, ...)
        return real(...)
    end
    return function()
        if active then
            active = false
            utils.Print = real
        end
    end
end

--- Compile a pollUntil predicate. An expression ("entity.Health.Hp == 0") is
--- the common case; statements work too, since the expression form is tried
--- first and the raw form second. Shares the eval chunk's environment.
local function compilePredicate(source, env)
    local chunk = Bridge.compile("return " .. source, env)
    if chunk == nil then
        chunk = Bridge.compile(source, env)
    end
    return chunk
end

local function monotonicMs()
    if Ext.Timer ~= nil and type(Ext.Timer.MonotonicTime) == "function" then
        local ok, value = pcall(Ext.Timer.MonotonicTime)
        if ok and type(value) == "number" then
            return value
        end
    end
    return nil
end

local function clampNumber(value, fallback, low, high)
    local n = tonumber(value)
    if n == nil then
        return fallback
    end
    return math.min(math.max(n, low), high)
end

H["eval"] = function(params, seq)
    if not Bridge.capabilities.eval then
        error("eval is unavailable: this Script Extender build does not expose load() to mod scripts")
    end

    local code = params.code
    if type(code) ~= "string" or code == "" then
        error("params.code must be a non-empty string")
    end

    local captureMs = clampNumber(params.captureMs, 0, 0, 30000)
    local hasPoll = type(params.pollUntil) == "string" and params.pollUntil ~= ""
    local intervalMs = clampNumber(params.intervalMs, 250, 50, 10000)
    local timeoutMs = clampNumber(params.timeoutMs, 5000, 100, 60000)

    -- The per-call environment shadows print (capture) and, when modContext is
    -- given, PersistentVars/ModuleUUID. buildEvalEnv raises on an unknown mod
    -- before anything global is touched, so there is nothing to restore.
    local prints = {}
    local env = buildEvalEnv(prints, params.modContext)

    local chunk, compileError = Bridge.compile(code, env)
    if chunk == nil then
        error("compile error: " .. tostring(compileError))
    end

    local predicate = nil
    if hasPoll then
        predicate = compilePredicate(params.pollUntil, env)
        if predicate == nil then
            error("pollUntil compile error: not valid Lua as an expression or a chunk")
        end
    end

    -- Ext.Utils.Print is reached through the shared Ext table, so the env
    -- cannot shadow it; the field itself is wrapped until the call settles.
    local restoreUtilsPrint = installUtilsPrintCapture(prints, sharedGlobals())

    local returned = table.pack(pcall(chunk))
    local mainOk = returned[1]
    local values = {}
    if mainOk then
        for i = 2, returned.n do
            values[i - 1] = Bridge.describe(returned[i])
        end
    end

    local result = { count = #values, values = values, prints = prints }

    -- The chunk itself failed: restore and let dispatch report the error.
    -- Polling a state that never got set up would only hide the real problem.
    if not mainOk then
        restoreUtilsPrint()
        error(tostring(returned[2]))
    end

    -- No deferred work requested: answer synchronously, as before.
    if not hasPoll and captureMs <= 0 then
        restoreUtilsPrint()
        return result
    end

    -- Deferred path. The response is written by a timer once the predicate is
    -- satisfied, the window closes, or the wait times out — print capture and
    -- the mod context stay live until then (the env is held by the timer
    -- closures), so timers the chunk scheduled are captured too.
    local settled = false
    local attempts = 0
    local started = monotonicMs()
    local function elapsedMs()
        local now = monotonicMs()
        if started ~= nil and now ~= nil then
            return math.max(0, now - started)
        end
        return attempts * intervalMs
    end

    local function settle(polled)
        if settled then
            return
        end
        settled = true
        restoreUtilsPrint()
        if polled ~= nil then
            result.polled = polled
        end
        Bridge.Respond(seq, true, result)
    end

    local function pollTick()
        if settled then
            return
        end
        attempts = attempts + 1

        if predicate ~= nil then
            local ok, value = pcall(predicate)
            if not ok then
                settled = true
                restoreUtilsPrint()
                Bridge.Respond(seq, false, "pollUntil raised after " .. attempts .. " attempt(s): " .. tostring(value))
                return
            end
            if value then
                settle({
                    satisfied = true,
                    attempts = attempts,
                    elapsedMs = elapsedMs(),
                    value = Bridge.describe(value),
                })
                return
            end
        end

        local deadline = hasPoll and timeoutMs or captureMs
        if elapsedMs() >= deadline then
            if hasPoll then
                settle({ satisfied = false, attempts = attempts, elapsedMs = elapsedMs() })
            else
                settle(nil)
            end
            return
        end

        Ext.Timer.WaitFor(intervalMs, pollTick)
    end

    if hasPoll then
        -- First check is immediate: the chunk often arranges the end state
        -- itself, and waiting a full interval would just add latency.
        pollTick()
    else
        Ext.Timer.WaitFor(captureMs, pollTick)
    end

    return Bridge.DEFERRED
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

--- Schema introspection ------------------------------------------------------
--
-- The questions that otherwise cost a runtime error each: "is it .Name or
-- .SourceFile?", ".TempHp or .TemporaryHp?", "why is StatusManager not a
-- component?". SE exposes no standalone type registry to mod scripts, so the
-- schema is read from a LIVE instance: stringify one level of the object and
-- report each field's name and value type. Ext.Json's depth limit raises
-- rather than truncates, so the stringify retries with a growing limit before
-- giving up.

--- Flatten one level of a live object into {name, type, preview} rows.
--- Uses the response encoder's option set: without IterateUserdata the
--- stringifier rejects component userdata outright ("unsupported type").
local function fieldRows(value)
    local lastError = nil
    for _, depth in ipairs({ 3, 6, 10 }) do
        local ok, encoded = pcall(Ext.Json.Stringify, value, {
            StringifyInternalTypes = true,
            IterateUserdata = true,
            AvoidRecursion = true,
            MaxDepth = depth,
        })
        if ok and type(encoded) == "string" then
            local parsedOk, parsed = pcall(Ext.Json.Parse, encoded)
            if parsedOk and type(parsed) == "table" then
                local rows = {}
                for name, field in pairs(parsed) do
                    local preview = nil
                    if type(field) == "string" then
                        preview = #field > 120 and string.sub(field, 1, 120) .. "…" or field
                    elseif type(field) == "number" or type(field) == "boolean" then
                        preview = tostring(field)
                    end
                    rows[#rows + 1] = { name = tostring(name), type = type(field), preview = preview }
                end
                table.sort(rows, function(a, b)
                    return a.name < b.name
                end)
                return rows
            end
        else
            lastError = encoded
        end
    end
    error("could not read fields (object too deep even at limit 10): " .. tostring(lastError))
end

H["schema"] = function(params)
    local action = params.action or "components"

    if action == "components" then
        -- The union of both listings, each row marked with whether property
        -- access actually works. GetAllComponents() and GetAllComponentNames()
        -- DISAGREE on some entities (AvatarComponent appeared in the names
        -- list only) — and a listed name is no guarantee the indexer accepts
        -- it (e.StatusManager raises; the reachable one is e.StatusContainer).
        local id = params.entity
        if type(id) ~= "string" or id == "" then
            error("params.entity is required for action=components — an entity UUID")
        end
        local entity = Ext.Entity.Get(id)
        if entity == nil then
            error("no entity found for id: " .. tostring(id))
        end

        local rows, seen = {}, {}
        local function add(name, source)
            if name == nil or name == "" then
                return
            end
            name = tostring(name)
            if seen[name] ~= nil then
                seen[name].listedBy = seen[name].listedBy .. "+" .. source
                return
            end
            local accessible = Bridge.resolveComponent(entity, name) ~= nil
            local row = { name = name, accessible = accessible, listedBy = source }
            seen[name] = row
            rows[#rows + 1] = row
        end

        pcall(function()
            for _, name in ipairs(entity:GetAllComponentNames()) do
                add(name, "names")
            end
        end)
        pcall(function()
            local all = entity:GetAllComponents()
            if type(all) == "table" then
                for name in pairs(all) do
                    add(name, "components")
                end
            end
        end)

        table.sort(rows, function(a, b)
            return a.name < b.name
        end)
        return { entity = id, count = #rows, components = rows }
    end

    if action == "fields" then
        local id = params.entity
        local componentName = params.component
        if type(id) ~= "string" or id == "" or type(componentName) ~= "string" or componentName == "" then
            error("action=fields needs params.entity (UUID) and params.component (e.g. \"Health\" or \"eoc::HealthComponent\")")
        end
        local entity = Ext.Entity.Get(id)
        if entity == nil then
            error("no entity found for id: " .. tostring(id))
        end
        local component, resolved = Bridge.resolveComponent(entity, componentName)
        if component == nil then
            error(
                "entity has no reachable component named: " .. tostring(componentName)
                    .. " (tried " .. table.concat(Bridge.componentAliases(componentName), ", ") .. ")"
            )
        end
        return { entity = id, component = resolved, fields = fieldRows(component) }
    end

    if action == "resource" then
        -- Field schema of a resource bank, from a loaded entry. Loaded-only:
        -- Ext.Resource sees what the game has loaded, not what paks define.
        local bank = params.type
        if type(bank) ~= "string" or bank == "" then
            error('params.type is required for action=resource — a resource bank, e.g. "Animation", "Visual"')
        end
        local all = Ext.Resource.GetAll(bank)
        if type(all) ~= "table" or #all == 0 then
            error('no loaded resources in bank "' .. tostring(bank) .. '" — banks only hold what the game has loaded')
        end
        local resource = Ext.Resource.Get(all[1], bank)
        if resource == nil then
            error("could not fetch a sample resource from bank: " .. tostring(bank))
        end
        return { type = bank, sampled = tostring(all[1]), fields = fieldRows(resource) }
    end

    error("unknown action: " .. tostring(action) .. " (expected components, fields or resource)")
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
