import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from './runtime.js';

/**
 * Signatures for the Osiris API, parsed from the Script Extender's generated
 * reference Lua (ReferenceLua/Osi.lua and Osi.Events.lua).
 *
 * This is the arity-trap killer: the field notes cost a session discovering
 * that Osi.SetFlag needs exactly 4 arguments (flag, object, dialogInstance,
 * sendFlagSetEventIfChanged) because the 2-arity overload BINDS and silently
 * no-ops — and the answer was sitting in Osi.lua's `---@overload` lines all
 * along. The reference ships next to the executable (repo root under Node);
 * when absent, lookups degrade with instructions instead of guessing.
 *
 * File shape being parsed (one entry per function):
 *
 *   ---@overload fun(flag:FLAG)
 *   ---@overload fun(flag:FLAG, object:GUIDSTRING)
 *   ---@param flag FLAG
 *   ---@param object GUIDSTRING
 *   ---@param dialogInstance integer
 *   ---@param sendFlagSetEventIfChanged integer
 *   function Osi.SetFlag(flag, object, dialogInstance, sendFlagSetEventIfChanged) end
 */

export interface OsirisParam {
    name: string;
    type: string;
}

export interface OsirisSignature {
    name: string;
    /** Main declared signature. */
    params: OsirisParam[];
    /** Declared overloads — other arities the game documents. */
    overloads: OsirisParam[][];
    /** Total argument count of the main signature. */
    arity: number;
}

export interface OsirisReference {
    functions: Map<string, OsirisSignature>;
    events: Map<string, OsirisSignature>;
}

const OVERLOAD = /^---@overload\s+fun\(([^)]*)\)\s*$/;
const PARAM = /^---@param\s+(\S+)\s+(\S+)/;
const FUNCTION = /^function\s+Osi\.(\w+)\(([^)]*)\)\s*end\s*$/;

function parseParamList(list: string | undefined): OsirisParam[] {
    const trimmed = (list ?? '').trim();
    if (trimmed === '') return [];
    return trimmed.split(',').map((part) => {
        const [name, type] = part.split(':');
        return { name: (name ?? '').trim(), type: (type ?? '').trim() };
    });
}

function parseReferenceFile(file: string, into: Map<string, OsirisSignature>): void {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let overloads: OsirisParam[][] = [];
    let params: OsirisParam[] = [];
    for (const line of lines) {
        const overloadArgs = OVERLOAD.exec(line)?.[1];
        if (overloadArgs !== undefined) {
            overloads.push(parseParamList(overloadArgs));
            continue;
        }
        const paramMatch = PARAM.exec(line);
        if (paramMatch !== null) {
            const name = paramMatch[1];
            params.push({ name: name ?? '', type: paramMatch[2] ?? '' });
            continue;
        }
        const functionMatch = FUNCTION.exec(line);
        if (functionMatch !== null) {
            // Annotated params drift from the identifier list on generated
            // files; trust the function statement for param names in order
            // and take the types from the annotations when present.
            const declared = parseParamList(functionMatch[2] ?? '');
            const signatureParams = declared.map((p, i) => ({
                name: p.name,
                type: params[i]?.type ?? p.type,
            }));
            const fnName = functionMatch[1];
            if (fnName === undefined) continue;
            into.set(fnName, {
                name: fnName,
                params: signatureParams,
                overloads,
                arity: signatureParams.length,
            });
            overloads = [];
            params = [];
        }
    }
}

let cached: OsirisReference | undefined;

export function loadOsirisReference(): OsirisReference {
    if (cached !== undefined) return cached;
    const reference: OsirisReference = { functions: new Map(), events: new Map() };
    parseReferenceFile(path.join(packageRoot(), 'ReferenceLua', 'Osi.lua'), reference.functions);
    parseReferenceFile(path.join(packageRoot(), 'ReferenceLua', 'Osi.Events.lua'), reference.events);
    cached = reference;
    return reference;
}

export function osirisReferenceAvailable(): boolean {
    return existsSync(path.join(packageRoot(), 'ReferenceLua', 'Osi.lua'));
}
