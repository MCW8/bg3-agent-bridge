--- The mailbox loop: poll a fixed request path, dispatch, write a response.
--- One in-flight request per context, ordered by a caller-supplied sequence
--- number. That is enough for agent-driven use and needs no directory
--- listing, which Script Extender Lua does not provide.

BG3AgentBridge = BG3AgentBridge or {}
local Bridge = BG3AgentBridge

local tickCounter = 0
local lastSeq = -1

local function readRequest()
    local raw = Ext.IO.LoadFile(Bridge.paths_.request)
    if raw == nil or raw == "" then
        return nil
    end

    local ok, parsed = pcall(Ext.Json.Parse, raw)
    if not ok or type(parsed) ~= "table" then
        return nil
    end

    return parsed
end

local function respond(seq, ok, payload)
    local body = {
        seq = seq,
        ok = ok,
        context = Bridge.context,
        protocol = Bridge.PROTOCOL_VERSION,
    }

    if ok then
        body.result = payload
    else
        body.error = tostring(payload)
    end

    local depth = Bridge.responseDepth
    Bridge.responseDepth = nil

    local encoded, reason = Bridge.encode(body, depth)
    if encoded == nil then
        encoded = Bridge.encodeFailure(
            seq,
            "result could not be serialized (" .. tostring(reason) .. "). "
                .. "Request a single attribute or component instead of the whole object."
        )
    end

    Ext.IO.SaveFile(Bridge.paths_.response, encoded)
end

local function dispatch(request)
    local seq = tonumber(request.seq)
    if seq == nil or seq <= lastSeq then
        return
    end

    -- Claim the sequence before running. A handler that hard-crashes must not
    -- leave the same request to be retried on every subsequent tick.
    lastSeq = seq

    local op = request.op
    local handler = Bridge.Handlers[op]
    if handler == nil then
        respond(seq, false, "unknown op: " .. tostring(op))
        return
    end

    local ok, result = pcall(handler, request.params or {})
    respond(seq, ok, result)

    if Bridge.pendingReset then
        Bridge.pendingReset = false
        Ext.OnNextTick(function()
            Bridge.log("resetting Lua VM on request")
            Ext.Debug.Reset()
        end)
    end
end

local function onTick()
    tickCounter = tickCounter + 1
    if tickCounter < Bridge.POLL_INTERVAL_TICKS then
        return
    end
    tickCounter = 0

    local request = readRequest()
    if request ~= nil then
        dispatch(request)
    end
end

--- Entry point, called from the context bootstrap.
function Bridge.Start(context)
    -- Bootstrap can be loaded more than once in a session. A reset gives a fresh
    -- VM so this is normally moot, but subscribing twice in one VM would run
    -- every poll twice, so refuse politely.
    if Bridge.started then
        Bridge.log("Start(" .. tostring(context) .. ") ignored — already running in this VM")
        return
    end
    Bridge.started = true

    Bridge.context = context
    Bridge.paths_ = Bridge.paths(context)
    Bridge.capabilities = Bridge.probeCapabilities()
    Bridge.pendingReset = false

    -- Ext.Debug.Reset re-runs bootstrap against the same on-disk mailbox. Seed
    -- the cursor from whatever request is already there so a completed command
    -- is not replayed against the fresh VM.
    local existing = readRequest()
    if existing ~= nil then
        local seq = tonumber(existing.seq)
        if seq ~= nil then
            lastSeq = seq
        end
    end

    Ext.IO.SaveFile(Bridge.paths_.hello, Bridge.encode({
        context = context,
        protocol = Bridge.PROTOCOL_VERSION,
        capabilities = Bridge.capabilities,
        resumedAtSeq = lastSeq,
        pollIntervalTicks = Bridge.POLL_INTERVAL_TICKS,
    }))

    Ext.Events.Tick:Subscribe(onTick)

    Bridge.log("bridge online (" .. context .. "), eval=" .. tostring(Bridge.capabilities.eval))
end
