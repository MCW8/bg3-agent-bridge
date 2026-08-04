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

--- Ticks between mailbox polls. The engine ticks per frame, so polling every
--- frame would read a file 60x/second for no benefit; ~4x/second is well
--- below agent round-trip latency.
Bridge.POLL_INTERVAL_TICKS = 15

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
function Bridge.compile(code, chunkName)
    local name = chunkName or "@agent-eval"
    if type(load) == "function" then
        return load(code, name)
    end
    if type(loadstring) == "function" then
        return loadstring(code, name)
    end
    return nil, "no Lua loader (load/loadstring) is exposed in this sandbox"
end

local STRINGIFY_OPTIONS = {
    Beautify = false,
    StringifyInternalTypes = true,
    IterateUserdata = true,
    AvoidRecursion = true,
    MaxDepth = 6,
}

--- Encode a value to JSON, degrading rather than throwing.
--- Live engine objects are userdata and can defeat the serializer at depth,
--- so every failure path still produces a parseable response body.
function Bridge.encode(value)
    local ok, encoded = pcall(Ext.Json.Stringify, value, STRINGIFY_OPTIONS)
    if ok and type(encoded) == "string" then
        return encoded
    end

    local okPlain, plain = pcall(Ext.Json.Stringify, value)
    if okPlain and type(plain) == "string" then
        return plain
    end

    local okFallback, fallback = pcall(Ext.Json.Stringify, {
        ok = false,
        error = "response was not serializable: " .. tostring(encoded),
    })
    if okFallback then
        return fallback
    end

    return '{"ok":false,"error":"response serialization failed"}'
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
