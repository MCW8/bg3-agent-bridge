--- Shared protocol layer for the agent bridge.
--- Script Extender Lua has no sockets and no directory listing, so the
--- transport is a pair of fixed-path JSON files per context that the MCP
--- server writes and this mod polls.

BG3AgentBridge = BG3AgentBridge or {}
local Bridge = BG3AgentBridge

Bridge.PROTOCOL_VERSION = 1

--- Relative to the Script Extender data directory, which is where
--- Ext.IO.SaveFile resolves unqualified paths:
---   %LOCALAPPDATA%\Larian Studios\Baldur's Gate 3\Script Extender\
Bridge.ROOT = "BG3AgentBridge/"

--- Ticks between mailbox polls. Measured on a live session, one poll costs
--- Script Extender ~8-9ms — enough that it gets flagged as a slow event, so
--- this is deliberately conservative. Agent round trips are measured in
--- seconds, which makes ~2 polls/second plenty responsive.
Bridge.POLL_INTERVAL_TICKS = 30

function Bridge.paths(context)
    return {
        request = Bridge.ROOT .. "request_" .. context .. ".json",
        response = Bridge.ROOT .. "response_" .. context .. ".json",
        hello = Bridge.ROOT .. "hello_" .. context .. ".json",
    }
end

--- Probe what this Script Extender build actually exposes, rather than
--- assuming. `load` in particular is not documented as available to mod
--- scripts (the console compiles input at the C++ level), so eval degrades
--- to a clear error instead of a mysterious nil-call.
function Bridge.probeCapabilities()
    local caps = {
        eval = type(load) == "function" or type(loadstring) == "function",
        entity = Ext.Entity ~= nil and type(Ext.Entity.Get) == "function",
        stats = Ext.Stats ~= nil and type(Ext.Stats.Get) == "function",
        reset = Ext.Debug ~= nil and type(Ext.Debug.Reset) == "function",
        json = Ext.Json ~= nil and type(Ext.Json.Stringify) == "function",
    }
    return caps
end

--- Compile a chunk using whichever loader this build exposes.
--- Returns chunk, nil on success or nil, errorMessage on failure.
---
--- Script Extender's `load` does not take standard Lua's chunk-name string as
--- argument 2 — it expects an environment table there, which eval uses to give
--- chunks a per-call environment (print capture, mod context). loadstring has
--- no environment parameter; on a build offering only loadstring the chunk
--- compiles without one and eval degrades to the shared environment.
function Bridge.compile(code, env)
    if type(load) == "function" then
        if env ~= nil then
            return load(code, env)
        end
        return load(code)
    end
    if type(loadstring) == "function" then
        return loadstring(code)
    end
    return nil, "no Lua loader (load/loadstring) is exposed in this sandbox"
end

Bridge.DEFAULT_MAX_DEPTH = 6

--- Handlers set this to cap serialization depth for one response when the
--- payload is a live engine object that can blow up under a deep walk. Cleared
--- by the mailbox after every reply.
Bridge.responseDepth = nil

local function stringifyOptions(maxDepth)
    return {
        Beautify = false,
        StringifyInternalTypes = true,
        IterateUserdata = true,
        AvoidRecursion = true,
        MaxDepth = maxDepth or Bridge.DEFAULT_MAX_DEPTH,
    }
end

--- Encode a value to JSON. Returns nil plus a reason when the value cannot be
--- represented; callers must then build a correlatable failure themselves.
---
--- Note that MaxDepth *raises* once exceeded rather than truncating, so a lower
--- limit turns large-but-valid payloads into hard errors instead of shorter
--- ones. Keep it generous and use narrower queries for big objects.
function Bridge.encode(value, maxDepth)
    local ok, encoded = pcall(Ext.Json.Stringify, value, stringifyOptions(maxDepth))
    if ok and type(encoded) == "string" then
        return encoded
    end

    local okPlain, plain = pcall(Ext.Json.Stringify, value)
    if okPlain and type(plain) == "string" then
        return plain
    end

    return nil, tostring(encoded)
end

--- A reply that is guaranteed to encode and, critically, still carries `seq`.
--- A response without it can never be matched by the caller, so a single
--- unserializable result would otherwise present as an indefinite hang.
function Bridge.encodeFailure(seq, message)
    local body = {
        seq = seq,
        ok = false,
        context = Bridge.context,
        protocol = Bridge.PROTOCOL_VERSION,
        error = message,
    }

    local ok, encoded = pcall(Ext.Json.Stringify, body)
    if ok and type(encoded) == "string" then
        return encoded
    end

    -- Last resort, hand-built. seq is a number and the message is ours, so
    -- there is nothing here that needs escaping.
    return '{"seq":' .. tostring(seq) .. ',"ok":false,"error":"response serialization failed"}'
end

--- Reduce a Lua value to something the serializer can handle.
--- Tables and userdata are left intact for Ext.Json to walk with the options
--- above; only types with no JSON analogue are replaced.
function Bridge.describe(value)
    local t = type(value)
    if t == "function" then
        return "<function>"
    elseif t == "thread" then
        return "<thread>"
    end
    return value
end

function Bridge.log(message)
    local line = "[AgentBridge] " .. tostring(message)
    if Ext.Utils ~= nil and type(Ext.Utils.Print) == "function" then
        Ext.Utils.Print(line)
    elseif type(print) == "function" then
        print(line)
    end
end
