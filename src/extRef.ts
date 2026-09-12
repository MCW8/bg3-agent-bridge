import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from './runtime.js';

/**
 * Ext.* API signatures, enum values and component field lists, parsed from the
 * Script Extender's generated IDE helpers (ReferenceLua/ExtIdeHelpers_v32.lua).
 *
 * Complements osirisRef.ts, which covers the Osiris (Osi.*) side. Between them
 * an agent can answer "what arguments does this take" and "what values does
 * this enum have" without the game running and without trial-and-error calls —
 * the friction that made a prior session reverse-engineer an audio call's
 * shape one error message at a time.
 *
 * File shapes being parsed:
 *
 *   --- @class Ext_ClientAudio
 *   --- @field PlayExternalSound fun(a1:uint64, a2:string, a3:string, a4:AudioCodec, a5:number?):boolean
 *
 *   --- @alias AudioCodec string|"ADPCM"|"Bank"|"External"|…|"Vorbis"|"XMA"
 *
 *   --- @class HealthComponent:BaseComponent
 *   --- @field Hp int32
 *
 * Parameter names in the helpers are generic (a1, a2, …) because the generator
 * only knows types; the types and the optional marker (`?`) are the value.
 */

export interface ExtParam {
    name: string;
    type: string;
    optional: boolean;
}

export interface ExtFunction {
    /** Declared owner class, e.g. "Ext_ClientAudio". */
    declaredOn: string;
    /** Best-effort runtime path, e.g. "Ext.Audio.PlayExternalSound". */
    runtime: string;
    name: string;
    params: ExtParam[];
    returns: string;
    /** Count of parameters that must be supplied. */
    requiredArity: number;
}

export interface ExtEnum {
    name: string;
    values: string[];
}

export interface ExtClass {
    name: string;
    inherits: string | null;
    fields: { name: string; type: string }[];
}

export interface ExtReference {
    /** Keyed by bare function name, lower-cased; a name can exist on several modules. */
    functions: Map<string, ExtFunction[]>;
    enums: Map<string, ExtEnum>;
    classes: Map<string, ExtClass>;
}

const CLASS = /^---\s*@class\s+([\w.]+)(?::([\w.]+))?/;
const ALIAS = /^---\s*@alias\s+(\w+)\s+(.+)$/;
const FIELD = /^---\s*@field\s+([\w.]+)\s+(.+)$/;
const FUNCTION_TYPE = /^fun\(([^)]*)\)(?::\s*(.+))?$/;

let cached: ExtReference | undefined;

export function loadExtReference(): ExtReference {
    if (cached !== undefined) return cached;

    const reference: ExtReference = { functions: new Map(), enums: new Map(), classes: new Map() };
    const file = path.join(packageRoot(), 'ReferenceLua', 'ExtIdeHelpers_v32.lua');
    if (!existsSync(file)) {
        cached = reference;
        return cached;
    }

    let current: ExtClass | null = null;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const aliasMatch = ALIAS.exec(line);
        if (aliasMatch !== null) {
            const name = aliasMatch[1] ?? '';
            // string|"A"|"B" — the quoted members are the enum labels.
            const values = [...(aliasMatch[2] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
            if (values.length > 0) reference.enums.set(name.toLowerCase(), { name, values });
            continue;
        }

        const classMatch = CLASS.exec(line);
        if (classMatch !== null) {
            const name = classMatch[1] ?? '';
            current = { name, inherits: classMatch[2] ?? null, fields: [] };
            reference.classes.set(name.toLowerCase(), current);
            continue;
        }

        const fieldMatch = FIELD.exec(line);
        if (fieldMatch === null || current === null) continue;

        const fieldName = fieldMatch[1] ?? '';
        const fieldType = (fieldMatch[2] ?? '').trim();
        const asFunction = FUNCTION_TYPE.exec(fieldType);
        if (asFunction === null) {
            current.fields.push({ name: fieldName, type: fieldType });
            continue;
        }

        const declared = (asFunction[1] ?? '').trim();
        const params: ExtParam[] =
            declared === ''
                ? []
                : declared.split(',').map((part) => {
                      const [rawName, rawType] = part.split(':');
                      const type = (rawType ?? '').trim();
                      return {
                          name: (rawName ?? '').trim(),
                          type: type.replace(/\?$/, ''),
                          optional: type.endsWith('?'),
                      };
                  });

        // Ext_ClientAudio → Ext.Audio (SE drops the context prefix at runtime);
        // reported alongside the declared class so a wrong guess stays visible.
        const moduleName = current.name.replace(/^Ext_/, '').replace(/^(Client|Server)/, '');
        const entry: ExtFunction = {
            declaredOn: current.name,
            runtime: `Ext.${moduleName}.${fieldName}`,
            name: fieldName,
            params,
            returns: (asFunction[2] ?? 'void').trim(),
            requiredArity: params.filter((p) => !p.optional).length,
        };
        const key = fieldName.toLowerCase();
        const existing = reference.functions.get(key);
        if (existing === undefined) reference.functions.set(key, [entry]);
        else existing.push(entry);
    }

    cached = reference;
    return cached;
}

export function extReferenceAvailable(): boolean {
    return existsSync(path.join(packageRoot(), 'ReferenceLua', 'ExtIdeHelpers_v32.lua'));
}
