#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

import { callBridge, readHello, type BridgeContext, type CallOptions } from './mailbox.js';
import { listLogSessions, tailLog } from './logs.js';
import { bridgeDir, logDirectories, mailboxPaths } from './paths.js';
import { ranDirectly } from './runtime.js';

/**
 * Read from package.json rather than hardcoded: a duplicated constant silently
 * drifted and reported 0.1.0 from a 0.2.0 build, which a client would show as
 * the server's version.
 */
function readVersion(): string {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        // Strip a UTF-8 BOM: Windows editors and PowerShell's Set-Content both
        // write one, and JSON.parse rejects it outright.
        const raw = readFileSync(path.join(here, '..', 'package.json'), 'utf8').replace(/^﻿/, '');
        const manifest = JSON.parse(raw) as { version?: string };
        return manifest.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

// Baked in by scripts/build-exe.mjs via bun --define; undeclared at runtime
// under plain Node, where the package.json read below answers instead.
declare const BG3_BUILD_VERSION: string | undefined;

const VERSION = typeof BG3_BUILD_VERSION !== 'undefined' ? BG3_BUILD_VERSION : readVersion();

const contextSchema = z
    .enum(['server', 'client'])
    .default('server')
    .describe(
        'Which Lua VM to target. "server" holds game logic and stats and is almost always the right choice; ' +
            '"client" holds UI and only answers once a save is loaded.',
    );

interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

function text(body: string): ToolResult {
    return { content: [{ type: 'text', text: body }] };
}

function json(payload: unknown): ToolResult {
    return text(JSON.stringify(payload, null, 2));
}

function failure(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Await a fixed delay. Used by the poll loops that wait out async game state.
 * Executor form (not Promise.withResolvers) is deliberate: package.json targets
 * node>=20, and Promise.withResolvers only exists from Node 22.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ToolSpec<S extends z.ZodType> {
    title: string;
    description: string;
    inputSchema: S;
}

/**
 * Thin wrapper over registerTool that keeps one cast in one place.
 *
 * zod attaches `~standard.jsonSchema` at runtime but (as of 4.4.3) leaves it off
 * the schema's declared type, so a zod object does not structurally satisfy the
 * SDK's StandardSchemaWithJSON overload even though it works. Casting here keeps
 * handlers fully inferred at every call site; delete the cast once zod declares
 * the property.
 */
function defineTool<S extends z.ZodType>(
    server: McpServer,
    name: string,
    spec: ToolSpec<S>,
    handler: (args: z.output<S>) => Promise<ToolResult>,
): void {
    server.registerTool(
        name,
        {
            title: spec.title,
            description: spec.description,
            inputSchema: spec.inputSchema as unknown as StandardSchemaWithJSON<z.input<S>, z.output<S>>,
        },
        handler as never,
    );
}

/** Every bridge call funnels through here so failures read as messages, not stack traces. */
async function bridge(
    context: BridgeContext,
    op: string,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
): Promise<ToolResult> {
    try {
        return json(await callBridge(context, op, params, options));
    } catch (error) {
        return failure((error as Error).message);
    }
}

/**
 * The active bg3_trace_events capture: which Osiris log and how far it has
 * been read. Module-level so read calls without an explicit cursor continue
 * where the last one stopped.
 */
let traceCapture: { file: string; cursor: number } | null = null;

function registerTools(server: McpServer): void {
    defineTool(
        server,
        'bg3_bridge_status',
        {
            title: 'Bridge status',
            description:
                'Check whether Baldur\'s Gate 3 is running with the companion bridge mod loaded, and report what each Lua ' +
                'context supports. Call this first when any other bridge tool fails.',
            inputSchema: z.object({}),
        },
        async () => {
            const contexts: BridgeContext[] = ['server', 'client'];
            const report: Record<string, unknown> = { bridgeDirectory: bridgeDir(), logDirectories: logDirectories() };

            for (const context of contexts) {
                const hello = await readHello(context);
                if (hello === null) {
                    report[context] = { online: false, reason: 'no handshake file — mod has not booted in this context' };
                    continue;
                }

                // A handshake file survives the game exiting, so liveness needs a real round trip.
                try {
                    await callBridge(context, 'ping', {}, { timeoutMs: 2500 });
                    report[context] = { online: true, capabilities: hello.capabilities, protocol: hello.protocol };
                } catch (error) {
                    report[context] = {
                        online: false,
                        reason: (error as Error).message,
                        lastKnownCapabilities: hello.capabilities,
                    };
                }
            }

            return json(report);
        },
    );

    defineTool(
        server,
        'bg3_find_static_data',
        {
            title: 'Search static game data',
            description:
                'Search a static data type by name — a third data layer beside resources and templates, holding what neither ' +
                'exposes. Most useful: MultiEffectInfo (what a status actually looks like), VFX, ManagedStatusVFX, Flag, Tag, ' +
                'Race, Progression, SpellList, ClassDescription, Feat. Cheap to scan, and typo-tolerant like the other ' +
                'searches. An invalid type returns the full list of valid ones.',
            inputSchema: z.object({
                type: z
                    .string()
                    .min(1)
                    .describe('Static data type, e.g. "MultiEffectInfo", "VFX", "Flag", "Tag", "Race", "SpellList"'),
                query: z.string().optional().describe('Name to look for; spaces, underscores and case are ignored'),
                limit: z.number().int().min(1).max(200).default(25).describe('Maximum returned; matches counted in full'),
                context: contextSchema,
            }),
        },
        async ({ type, query, limit, context }) => bridge(context, 'staticdata.find', { type, query, limit }),
    );

    defineTool(
        server,
        'bg3_find_stat',
        {
            title: 'Search stat entries',
            description:
                'Search statuses, spells, armour, weapons and passives by internal name OR by the name players see. Use this ' +
                'to find a status when you only remember what it is called in game — "Marked for Negation" is a status ' +
                'called OBLITERATIONORB, which no name search would ever reach. Returns the resolved DisplayName and, for ' +
                'statuses, the name of the visual effect they apply, so one call usually answers the whole question. ' +
                'Typo-tolerant.',
            inputSchema: z.object({
                type: z
                    .string()
                    .default('StatusData')
                    .describe('Stat type: StatusData, SpellData, Armor, Weapon, Object, Passive, Interrupt, Character'),
                query: z.string().optional().describe('Internal or display name; spaces, underscores and case are ignored'),
                limit: z.number().int().min(1).max(200).default(25).describe('Maximum returned; matches counted in full'),
                context: contextSchema,
            }),
        },
        async ({ type, query, limit, context }) => bridge(context, 'stats.find', { type, query, limit }),
    );

    defineTool(
        server,
        'bg3_find_status_by_effect',
        {
            title: 'Find statuses by visual effect',
            description:
                'Reverse lookup: given part of a visual effect name, list the statuses that apply it. This is how you get from ' +
                '"I saw a look I want" to something you can actually use, because a status is rarely named after how it looks — ' +
                'the ghostly appearance in Oskar\'s quest comes from a status called LOW_OSKARSBELOVED_KERRI_BLUE. Nothing ' +
                'indexes this direction. Pair with bg3_preview_status to see each candidate.',
            inputSchema: z.object({
                query: z
                    .string()
                    .min(1)
                    .describe('Fragment of the effect name, e.g. "ghost", "spectral", "possess", "burn"'),
                context: contextSchema,
            }),
        },
        async ({ query, context }) => bridge(context, 'status.usingEffect', { query }),
    );

    defineTool(
        server,
        'bg3_preview_status',
        {
            title: 'Apply a status to see what it looks like',
            description:
                'Audition a status on a character, then clear it — the equivalent of bg3_preview_item for visual effects. ' +
                'Statuses of type EFFECT are purely cosmetic and safe to try; BOOST and POLYMORPHED change gameplay or the ' +
                'model, so read statusType before applying. Applied statuses are tracked so action=clear removes everything ' +
                'this tool put on. ALWAYS clear when done.',
            inputSchema: z.object({
                action: z
                    .enum(['apply', 'remove', 'clear', 'list'])
                    .default('list')
                    .describe('apply one, remove one, clear everything this tool applied, or list what is active'),
                status: z.string().optional().describe('Status name, e.g. "GHOST_FX". Required for apply and remove.'),
                duration: z.number().default(60).describe('Seconds before it lapses on its own; clear does not wait for this'),
                character: z.string().optional().describe('Character UUID; defaults to the host character'),
                context: contextSchema,
            }),
        },
        async ({ action, status, duration, character, context }) =>
            bridge(context, 'status.preview', { action, status, duration, character }),
    );

    defineTool(
        server,
        'bg3_spawn_character',
        {
            title: 'Spawn an NPC from a character template',
            description:
                'Spawn a character from a root template UUID (find one with bg3_find_template, templateType=character), ' +
                'by default 2m from the host character — pass near to anchor to someone else, or x/y/z for an exact spot. ' +
                'This wraps Osi.CreateAt, whose signature is the trap: it takes exactly 7 arguments ' +
                '(templateId, x, y, z, temporary, playSpawn, customName) and every shorter form fails with an overload ' +
                'error that never says the wanted count. Spawned characters are tracked so action=despawn or clear can ' +
                'remove them; a spawn persists in the save otherwise. ALWAYS clear test spawns when done. Spawning is ' +
                'server-side, so this tool always targets the server context.',
            inputSchema: z.object({
                action: z
                    .enum(['spawn', 'despawn', 'clear', 'list'])
                    .optional()
                    .describe(
                        'spawn creates a character (the default when template is given), despawn removes one by id, clear ' +
                            'removes everything this tool spawned, list (the default with no template) shows what is ' +
                            'tracked and whether it is still on stage',
                    ),
                template: z
                    .string()
                    .optional()
                    .describe('Character root template UUID, from bg3_find_template. Required for spawn.'),
                near: z
                    .string()
                    .optional()
                    .describe('Character UUID to spawn beside; defaults to the host character. Ignored when x/y/z are given.'),
                offset: z
                    .number()
                    .default(2)
                    .describe('Metres from `near` to place the spawn on the x axis, when no x/y/z are given'),
                x: z.number().optional().describe('World x; requires y and z too, and overrides near/offset'),
                y: z.number().optional().describe('World y'),
                z: z.number().optional().describe('World z'),
                name: z.string().optional().describe('Custom name for the spawned character; empty keeps the template\'s'),
                playSpawn: z
                    .boolean()
                    .default(false)
                    .describe('Play the spawn-in animation and sound instead of appearing instantly'),
                id: z.string().optional().describe('Character UUID to despawn. Required for despawn; take it from action=list.'),
            }),
        },
        // Hardcoded to server: Osi.CreateAt is a story call and only the server
        // VM can create entities, so offering a context argument would only
        // offer a way to get an error.
        //
        // action defaults by intent: a call carrying a template means spawn —
        // the previous unconditional "list" default turned a template-only
        // call into a silent no-op that returned {count: 0, spawned: []}.
        async ({ action, template, near, offset, x, y, z, name, playSpawn, id }) =>
            bridge('server', 'character.spawn', {
                action: action ?? (template !== undefined && template !== '' ? 'spawn' : 'list'),
                template,
                near,
                offset,
                x,
                y,
                z,
                name,
                playSpawn,
                id,
            }),
    );

    defineTool(
        server,
        'bg3_animation',
        {
            title: 'Audition animations and override the idle',
            description:
                'Play any animation on a character (one-shot or engine-looped), swap their whole locomotion set, or ' +
                'replace their idle animation with a named still-animation state (Dazed, Dancing, Feared, Laughing, … ' +
                '— action=list shows all ~29 still types plus the ~100 locomotion sets). Probed facts that shape this ' +
                'tool: Osi.PlayAnimation resolves ONLY the bare AnimationShortName GUID — the "GUID(name)" display ' +
                'form is a silent no-op, and the tool strips the suffix if you paste it. Osi.PlayLoopingAnimation ' +
                'looks dead (arities 2-6 all fail) but its true signature is 8 arguments with the animation in ' +
                'position 3 — loop mode uses it to hold statue poses indefinitely and loop animations continuously; ' +
                'movement is blocked while a loop runs and crouching breaks it one-way, so use stop/clear ' +
                '(Osi.StopAnimation(character, 1) — the channel number, not a name) to end one. action=animset is the ' +
                'strongest override: a status DynamicAnimationTag pointing at an AnimationSetPriority entry swaps ' +
                'idle, walk AND run with normal movement — the RAGE/Bladesong channel, and how the On All Fours crawl ' +
                'mod works. The status AnimationLoop field is ignored on BOOST statuses (it is the incapacitation ' +
                'freeze, not an idle override); action=idle live-edits StillAnimationType on a clean carrier instead. ' +
                'Everything is session-only and action=clear restores edited stats and cancels loops. ' +
                'ALWAYS clear when done. Server-side only.',
            inputSchema: z.object({
                action: z
                    .enum(['find', 'play', 'loop', 'stop', 'idle', 'animset', 'clear', 'list'])
                    .default('list')
                    .describe(
                        'find resolves a name to AnimationShortName GUIDs; play fires a one-shot; loop starts an ' +
                            'engine-level loop (or held pose); stop cancels all loops; idle overrides the idle ' +
                            'animation; animset swaps the whole locomotion set (idle, walk, run) via a status ' +
                            'DynamicAnimationTag — the engine-native channel with free movement; clear undoes ' +
                            'everything this tool changed; list shows still types, animation sets, carriers and ' +
                            'what is active',
                    ),
                query: z.string().optional().describe('Name to search for with action=find, e.g. "flying kiss", "wave", "bow"'),
                animation: z
                    .string()
                    .optional()
                    .describe('AnimationShortName GUID or name, e.g. "PM_Flying kiss_01". Required for play and loop.'),
                set: z
                    .string()
                    .optional()
                    .describe(
                        'AnimationSetPriority name for action=animset, e.g. "Zombie", "on_all_fours", "Bladesong". ' +
                            'See action=list for the full set. An existing clean ANIM_OVERRIDE status is used when ' +
                            'one carries the tag; otherwise the carrier status is live-edited and restored on clear.',
                    ),
                character: z.string().optional().describe('Character UUID; defaults to the host character'),
                stillType: z
                    .string()
                    .optional()
                    .describe('Still-animation state for action=idle, e.g. "Dazed", "Dancing", "Feared". See action=list.'),
                carrier: z
                    .string()
                    .optional()
                    .describe(
                        'Status to carry the idle override, default ANIM_COWER — must have no Boosts and no RemoveEvents; ' +
                            'action=list flags clean carriers per still type. The carrier\'s StillAnimationType is ' +
                            'live-edited session-only and restored on clear.',
                    ),
                duration: z.number().default(600).describe('Seconds the idle-override status lasts; clear does not wait for this'),
                allowBoosts: z
                    .boolean()
                    .default(false)
                    .describe('Permit a carrier status that has Boosts — the override would carry those mechanics with it'),
            }),
        },
        // Hardcoded to server: PlayAnimation and ApplyStatus are story calls,
        // so a context argument would only offer a way to get an error.
        async ({ action, query, animation, set, character, stillType, carrier, duration, allowBoosts }) =>
            bridge('server', 'animation', { action, query, animation, set, character, stillType, carrier, duration, allowBoosts }),
    );

    defineTool(
        server,
        'bg3_find_template',
        {
            title: 'Search root templates',
            description:
                'Search the game\'s root templates — items, characters, scenery, projectiles — by name. Templates carry ' +
                'cross-references that resources do not: Stats links to the stat entry, VisualTemplate to the visual GUID, ' +
                'and ParentTemplateId to what it inherits from, so one search gives you the whole graph for an item. Use the ' +
                'returned Id with bg3_preview_item to see it worn. Results include the readable DisplayName, which is how you ' +
                'tell the right hit from a hundred scenery props. Pass templateType=item when hunting equipment — it removes ' +
                'most of the noise.',
            inputSchema: z.object({
                query: z
                    .string()
                    .optional()
                    .describe(
                        'Name to look for. Spaces, underscores and case are ignored, so the in-game name usually works: ' +
                            '"Blood of Lathander" finds UNI_CRE_HUM_Sun_Mace_BloodOfLathander. If nothing matches exactly, ' +
                            'it retries allowing typos — "Sword of Justise" still finds Sword of Justice. Those results are ' +
                            'flagged with fuzzy:true and carry a fuzzyDistance, closest first. More words rank better than ' +
                            'fewer: one vague word can match a hundred props.',
                    ),
                templateType: z
                    .string()
                    .optional()
                    .describe('Restrict by type: item, character, scenery, projectile, light, trigger, prefab, decal, surface'),
                searchDisplayNames: z
                    .boolean()
                    .default(true)
                    .describe(
                        'Match against localised display names as well as internal ones. On by default and worth leaving on: ' +
                            'internal names frequently share nothing with what players call a thing. Costs about 31ms.',
                    ),
                limit: z.number().int().min(1).max(200).default(25).describe('Maximum returned; matches are counted in full'),
                context: contextSchema,
            }),
        },
        async ({ query, templateType, searchDisplayNames, limit, context }) =>
            bridge(context, 'template.find', { query, templateType, searchDisplayNames, limit }),
    );

    defineTool(
        server,
        'bg3_preview_item',
        {
            title: 'Preview an item on a character',
            description:
                'Temporarily equip an item so its appearance can be seen, then put the original back. BG3 has no in-place ' +
                'visual swap — writing an equipped item\'s visual does nothing — so the only way to see a look is to wear the ' +
                'item. Note the preview is a REAL item carrying its own stats, not a cosmetic shell: previewing plate over ' +
                'leather genuinely changes armour class, so avoid it mid-combat. The original is moved to inventory and ' +
                'restored on `restore`. ALWAYS restore when done.',
            inputSchema: z.object({
                action: z
                    .enum(['apply', 'restore', 'status'])
                    .default('status')
                    .describe('apply equips the preview; restore puts the original back and deletes the temporary item'),
                template: z.string().optional().describe('Root template UUID to preview, from bg3_find_template. Required for apply.'),
                slot: z
                    .string()
                    .optional()
                    .describe('Equipment slot, e.g. Breast, Helmet, Boots, Gloves, Cloak. Detected from the item when omitted.'),
                character: z.string().optional().describe('Character UUID; defaults to the host character'),
            }),
        },
        async ({ action, template, slot, character }) => {
            if (action !== 'apply') {
                return bridge('server', 'item.preview', { action, template, slot, character });
            }

            try {
                // The equip is deferred 50ms inside the game, so a bare apply would
                // always report equipped=false. Wait it out and report the settled
                // state, so callers get one honest answer instead of two calls.
                const applied = await callBridge('server', 'item.preview', { action, template, slot, character });
                await sleep(900);
                const settled = await callBridge('server', 'item.preview', { action: 'status' });
                return json({ applied, settled });
            } catch (error) {
                return failure((error as Error).message);
            }
        },
    );

    defineTool(
        server,
        'bg3_capture_sounds',
        {
            title: 'Capture sounds the game fires',
            description:
                'Record sound requests queued through the engine SoundRoutingSystem: start the capture, act in game, read it ' +
                'back. Treat this as an impact/shake detector rather than a general audio observer — in testing against both ' +
                'jumping and spell casts it returned only Shake_Rumble_Start/Stop, and the audio actually heard never appeared. ' +
                'Most of the game reaches Wwise by another path. Entries do carry a per-event subject entity, which makes it a ' +
                'reliable hook for landings and AOE impacts. Always runs in the client context.',
            inputSchema: z.object({
                action: z
                    .enum(['start', 'stop', 'read', 'clear', 'status'])
                    .default('status')
                    .describe('start clears the buffer and begins recording; read returns what was caught; stop leaves the buffer intact'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(2000)
                    .default(200)
                    .describe('Buffer size, applied on start. Overflow is counted rather than silently lost.'),
                dedupe: z
                    .boolean()
                    .default(true)
                    .describe('Collapse an event repeating on consecutive frames into one entry with a count'),
                clear: z.boolean().default(false).describe('With action=read, empty the buffer after returning it'),
            }),
        },
        async ({ action, limit, dedupe, clear }) => bridge('client', 'audio.capture', { action, limit, dedupe, clear }),
    );

    defineTool(
        server,
        'bg3_play_sound',
        {
            title: 'Play a sound in the running game',
            description:
                'Fire a Wwise sound event, to audition a sound you found with bg3_find_resource. This is a development tool ' +
                'driven from outside the game — it plays when this tool is called and gives the person playing no control of ' +
                'its own. Always runs in the client context, because Ext.Audio is client side only.',
            inputSchema: z.object({
                event: z
                    .string()
                    .optional()
                    .describe(
                        'SoundEvent name, e.g. "Spell_Cast_Damage_Thunder_Thunderwave_L1to3_01". Take these from the ' +
                            'SoundEvent field of bg3_find_resource with type=Sound. Required unless stop is true.',
                    ),
                target: z
                    .string()
                    .optional()
                    .describe(
                        'Where to play it. Prefer a character UUID — most game sounds are positional, and firing one at a ' +
                            'built-in object leaves it nowhere near the listener, so it returns success and you hear nothing. ' +
                            'Built-ins (Global, Music, Ambient, HUD, Listener) suit only wide-falloff sounds. Omit for the default object.',
                    ),
                stop: z
                    .boolean()
                    .default(false)
                    .describe('Stop sounds on the target instead of playing one. Use this when a looping event will not end on its own.'),
            }),
        },
        // Hardcoded to client: Ext.Audio does not exist server side, so offering
        // a context argument would only offer a way to get an error.
        async ({ event, target, stop }) => bridge('client', 'audio.post', { event, target, stop }),
    );

    defineTool(
        server,
        'bg3_find_resource',
        {
            title: 'Search game resources',
            description:
                'Search a resource bank by substring and get GUIDs back. This is how you find the UUID of a sound, visual, ' +
                'material or effect without unpacking anything. Sound entries carry a readable SoundEvent name (e.g. ' +
                '"CrSpell_Cast_Sahuagin_Net"), visuals carry Slot and SkeletonResource, and everything carries SourceFile — ' +
                'so you can search by asset name, by slot, or by the .bnk/pak a resource came from. The query matches every ' +
                'string field including the GUID itself, case-insensitively.',
            inputSchema: z.object({
                type: z
                    .string()
                    .min(1)
                    .describe(
                        'Resource bank: Sound, Visual, CharacterVisual, Material, MaterialPreset, MaterialSet, Effect, ' +
                            'VoiceBark, Texture, Animation, Skeleton, Dialog, Timeline, TileSet, VirtualTexture, and others. ' +
                            'An invalid value returns the full list of valid ones.',
                    ),
                query: z
                    .string()
                    .optional()
                    .describe('Case-insensitive substring. Omit to sample the bank and see what fields entries carry.'),
                limit: z.number().int().min(1).max(200).default(25).describe('Maximum entries returned; matches are counted in full regardless'),
                moddedOnly: z.boolean().default(false).describe('Only resources flagged IsModded — useful for isolating what a mod added'),
                context: contextSchema,
            }),
        },
        async ({ type, query, limit, moddedOnly, context }) =>
            bridge(context, 'resource.find', { type, query, limit, moddedOnly }),
    );

    defineTool(
        server,
        'bg3_list_mods',
        {
            title: 'List loaded mods',
            description:
                'List the mods actually mounted in the running game, in load order. Check this first whenever a mod "is not ' +
                'working": if it is absent here the pak never mounted or it is missing from modsettings.lsx, and no amount of ' +
                'stat or script debugging will help. Load order changes require a full game restart — reloading a save is not ' +
                'enough, and the game rewrites modsettings.lsx on exit, which can discard edits made while it was running.',
            inputSchema: z.object({
                filter: z
                    .string()
                    .optional()
                    .describe(
                        'Case-insensitive substring matched against both directory and display name. Base game modules ' +
                            '(Gustav, Shared, DiceSet_01, ...) are listed too, so filter to cut them out.',
                    ),
                context: contextSchema,
            }),
        },
        async ({ filter, context }) => bridge(context, 'mods.list', { filter }),
    );

    defineTool(
        server,
        'bg3_eval',
        {
            title: 'Evaluate Lua in the running game',
            description:
                'Run a Lua chunk inside the live game and return its values. Use `return` to get a value back. ' +
                'print/Ext.Utils.Print output emitted during the call is captured and returned as `prints` — no more ' +
                'eval-then-grep-the-log for diagnostics. The chunk runs in the bridge mod\'s own context: bare ' +
                '`PersistentVars` is the bridge\'s (nil), so to touch another mod\'s state either use ' +
                '`Mods.<Folder>.PersistentVars` or pass modContext to run the chunk with that mod\'s ' +
                'PersistentVars/ModuleUUID swapped in. Game state often settles asynchronously (status applies, scene ' +
                'teardown): pollUntil re-evaluates a Lua predicate until it is truthy or timeoutMs elapses and returns ' +
                'the outcome as `polled`, and captureMs keeps collecting prints for a window after the chunk returns ' +
                'so timers it scheduled are captured too. Avoid parallel bridge calls while a pollUntil is active. ' +
                'Availability depends on the Script Extender build exposing load() to mod scripts — check bg3_bridge_status first.',
            inputSchema: z.object({
                code: z.string().min(1).describe('Lua source to execute, e.g. "return Osi.GetHostCharacter()"'),
                context: contextSchema,
                modContext: z
                    .string()
                    .optional()
                    .describe(
                        'Folder (directory) name of the mod whose PersistentVars/ModuleUUID the chunk should see, e.g. ' +
                            '"a scene-manager mod". Get folder names from bg3_list_mods.',
                    ),
                pollUntil: z
                    .string()
                    .optional()
                    .describe(
                        'Lua predicate (expression or chunk) re-evaluated after `code` runs until truthy or timeout — ' +
                            'e.g. "Ext.Entity.Get(uuid).Health.Hp == 0". The reply waits for the outcome.',
                    ),
                timeoutMs: z
                    .number()
                    .int()
                    .min(100)
                    .max(60000)
                    .default(5000)
                    .describe('Longest pollUntil waits before reporting satisfied:false'),
                intervalMs: z
                    .number()
                    .int()
                    .min(50)
                    .max(10000)
                    .default(250)
                    .describe('Delay between pollUntil checks'),
                captureMs: z
                    .number()
                    .int()
                    .min(0)
                    .max(30000)
                    .default(0)
                    .describe(
                        'Keep capturing prints for this long after the chunk returns, so Ext.Timer callbacks it ' +
                            'scheduled are included. The reply waits for the window.',
                    ),
            }),
        },
        async ({ code, context, modContext, pollUntil, timeoutMs, intervalMs, captureMs }) => {
            // The reply is deferred until the poll/capture window closes, so the
            // bridge timeout must outlast it with margin for the mailbox poll.
            const windowMs = Math.max(pollUntil !== undefined && pollUntil !== '' ? timeoutMs : 0, captureMs);
            return bridge(
                context,
                'eval',
                { code, modContext, pollUntil, timeoutMs, intervalMs, captureMs },
                { timeoutMs: windowMs + 8000 },
            );
        },
    );

    defineTool(
        server,
        'bg3_entity_inspect',
        {
            title: 'Inspect a live entity',
            description:
                'List an entity\'s components, or dump one named component. Omit `component` first to discover what exists, ' +
                'then request a specific one — full component dumps are large.',
            inputSchema: z.object({
                id: z.string().min(1).describe('Entity UUID or handle, e.g. a character UUID'),
                component: z
                    .string()
                    .optional()
                    .describe(
                        'Component to dump; omit to list all component names. Either the qualified name from that list ' +
                            '("eoc::HealthComponent") or the short form ("Health") works.',
                    ),
                depth: z
                    .number()
                    .int()
                    .min(1)
                    .max(10)
                    .optional()
                    .describe('Serialization depth, default 3. Raise carefully — deep walks stall the game briefly.'),
                context: contextSchema,
            }),
        },
        async ({ id, component, depth, context }) => bridge(context, 'entity.get', { id, component, depth }),
    );

    defineTool(
        server,
        'bg3_schema',
        {
            title: 'Inspect component and resource field schemas',
            description:
                'Answer "what fields does this component/resource actually have" without a runtime error per guess. ' +
                'SE exposes no type registry to mod scripts, so the schema is read from a live instance. ' +
                'action=components lists every component on an entity with an `accessible` flag and which listing ' +
                'reported it — GetAllComponents() and GetAllComponentNames() DISAGREE on some entities, and a listed ' +
                'name is no guarantee the indexer accepts it (e.StatusManager raises; the reachable component is ' +
                'e.StatusContainer with a Statuses field). action=fields dumps one component\'s field names, value ' +
                'types and scalar previews — the direct fix for guessing .Name vs .SourceFile (visual/animation ' +
                'resources only have SourceFile) or .TempHp vs .TemporaryHp (it is TemporaryHp/MaxTemporaryHp). ' +
                'action=resource samples a resource bank the same way — loaded entries only, banks do not list ' +
                'pak-defined resources the game has not loaded.',
            inputSchema: z.object({
                action: z
                    .enum(['components', 'fields', 'resource'])
                    .default('components')
                    .describe('components lists an entity\'s components with accessibility; fields dumps one component; resource samples a bank'),
                entity: z.string().optional().describe('Entity UUID. Required for components and fields.'),
                component: z
                    .string()
                    .optional()
                    .describe('Component for action=fields; short ("Health") or qualified ("eoc::HealthComponent") form both work'),
                type: z.string().optional().describe('Resource bank for action=resource, e.g. "Animation", "Visual"'),
                context: contextSchema,
            }),
        },
        async ({ action, entity, component, type, context }) =>
            bridge(context, 'schema', { action, entity, component, type }),
    );

    defineTool(
        server,
        'bg3_stats_get',
        {
            title: 'Read a stat entry',
            description:
                'Read a stats entry (spell, passive, status, weapon, …) from the live game. Pass `attribute` to read one field ' +
                'instead of the whole entry.',
            inputSchema: z.object({
                name: z.string().min(1).describe('Stat entry name, e.g. "Target_MainHandAttack"'),
                attribute: z
                    .string()
                    .optional()
                    .describe('Single attribute to read. Much cheaper than a full entry — prefer this when you know the field.'),
                depth: z
                    .number()
                    .int()
                    .min(1)
                    .max(10)
                    .optional()
                    .describe(
                        'Serialization depth for a full entry, default 2. Large entries such as spells follow a long ' +
                            'inheritance chain, and a deep walk can stall the game for seconds.',
                    ),
                context: contextSchema,
            }),
        },
        async ({ name, attribute, depth, context }) => bridge(context, 'stats.get', { name, attribute, depth }),
    );

    defineTool(
        server,
        'bg3_stats_set',
        {
            title: 'Write a stat attribute',
            description:
                'Set one attribute on a live stat entry and sync it to clients. This changes the running session only — it does ' +
                'not edit your mod files, so persist any change you want to keep by editing the stat source.',
            inputSchema: z.object({
                name: z.string().min(1).describe('Stat entry name'),
                attribute: z.string().min(1).describe('Attribute to write'),
                value: z.union([z.string(), z.number(), z.boolean()]).describe('New value'),
                sync: z.boolean().default(true).describe('Sync the change to clients; false leaves it server-side'),
                context: contextSchema,
            }),
        },
        async ({ name, attribute, value, sync, context }) => bridge(context, 'stats.set', { name, attribute, value, sync }),
    );

    defineTool(
        server,
        'bg3_reload',
        {
            title: 'Hot-reload the Lua VM',
            description:
                'Reinitialise the Lua state so edited mod Lua takes effect without restarting the game. This is the fast half of ' +
                'the edit-test loop; changes to packed data such as stats or root templates still need a repack and restart. ' +
                'Note this resets BOTH the server and client VMs whichever context you target — all in-memory Lua state is lost, ' +
                'including runtime stat edits made with bg3_stats_set. By default this WAITS for the reload to finish and confirms ' +
                'it: it records the handshake file\'s timestamp, triggers the reset, waits for Bridge.Start to rewrite that ' +
                'handshake (the definitive "VM rebooted" signal — no dependence on Script Extender logging being enabled), then ' +
                'pings the fresh VM and returns {reloaded, rebooted, responsive, durationMs, capabilities}. A syntax error in a ' +
                'reloaded script stops Bridge.Start, so the handshake never advances and this correctly reports reloaded:false. ' +
                'Pass wait=false for fire-and-forget.',
            inputSchema: z.object({
                context: contextSchema.describe(
                    'Which context carries the request, and whose handshake confirms the reload. ' +
                        'It does not scope the reset — both VMs restart either way.',
                ),
                wait: z
                    .boolean()
                    .default(true)
                    .describe('Wait for the fresh handshake and ping, and report the outcome. false returns as soon as the reset is scheduled.'),
                timeoutMs: z
                    .number()
                    .int()
                    .min(1000)
                    .max(30000)
                    .default(8000)
                    .describe('How long to wait for the rebooted handshake before reporting reloaded:false'),
            }),
        },
        async ({ context, wait, timeoutMs }) => {
            const helloPath = mailboxPaths(context).hello;
            // The handshake file is rewritten by Bridge.Start on every boot, so
            // its mtime advancing is the definitive "VM rebooted" signal — and,
            // unlike scraping the extender log for a marker, it works whether or
            // not Script Extender runtime logging is enabled (it often is not,
            // which produced false reloaded:false reports).
            let beforeMtime = -1;
            try {
                beforeMtime = (await stat(helloPath)).mtimeMs;
            } catch {
                // No prior handshake: the bridge has not booted this session. A
                // reboot creates the file, which the poll still detects (> -1).
            }

            try {
                await callBridge(context, 'reset');
            } catch (error) {
                return failure(`reset request failed: ${(error as Error).message}`);
            }

            if (!wait) {
                return json({
                    scheduled: true,
                    context,
                    note: 'Reset scheduled (both server and client VMs restart). Call bg3_bridge_status to confirm it came back.',
                });
            }

            const started = Date.now();
            let rebooted = false;
            while (Date.now() - started < timeoutMs) {
                await sleep(300);
                try {
                    if ((await stat(helloPath)).mtimeMs > beforeMtime) {
                        rebooted = true;
                        break;
                    }
                } catch {
                    // File briefly absent mid-reboot: keep polling.
                }
            }

            if (!rebooted) {
                return json({
                    reloaded: false,
                    rebooted: false,
                    context,
                    durationMs: Date.now() - started,
                    note:
                        `No fresh handshake within ${timeoutMs}ms. The reset may still be settling, or a reloaded script failed ` +
                        `to boot (a Lua syntax error stops Bridge.Start). Call bg3_bridge_status, and check the extender log for errors.`,
                });
            }

            // Confirm the rebooted VM actually answers, and read its capabilities.
            let responsive = false;
            let capabilities: unknown;
            try {
                const pong = await callBridge<{ capabilities?: unknown }>(context, 'ping', {}, { timeoutMs: 3000 });
                responsive = true;
                capabilities = pong.capabilities;
            } catch {
                responsive = false;
            }

            return json({
                reloaded: rebooted && responsive,
                rebooted,
                responsive,
                context,
                durationMs: Date.now() - started,
                capabilities,
                note:
                    rebooted && responsive
                        ? 'VM restarted cleanly and the bridge is answering.'
                        : 'Handshake was rewritten but the bridge did not answer a ping yet — it may still be settling; retry bg3_bridge_status.',
            });
        },
    );

    defineTool(
        server,
        'bg3_resolve_character',
        {
            title: 'Resolve a character and its identity',
            description:
                'Resolve a character to its stable identity, or list the party. BG3 character identity is a minefield: ' +
                'GetHostCharacter() returns a BARE UUID and follows CONTROL (it moves to a companion when the avatar is ' +
                'downed and does not revert on resurrect), while Osiris events deliver PREFIXED template-name forms ' +
                '(Elves_Female_High_Player_<uuid>) that fail bare-string equality. action=resolve takes any of those ' +
                'forms (or a display name) and returns the bare uuid, the prefixed form, the display name, whether the ' +
                'entity is the player-created Tav (the AvatarComponent, which stays put across control and death \u2014 the ' +
                'reliable "who is the player" signal), whether it is currently host-controlled, HP, and dead/downed ' +
                'state. action=party lists every party member the same way; action=host resolves whoever holds control ' +
                'right now. Server-side only.',
            inputSchema: z.object({
                action: z
                    .enum(['resolve', 'party', 'host'])
                    .default('resolve')
                    .describe('resolve one id (default), list the whole party, or resolve the control-holding host'),
                id: z
                    .string()
                    .optional()
                    .describe(
                        'Character to resolve for action=resolve: a bare UUID, a prefixed template-name form, or a ' +
                            'display name (matched against party members). Defaults to the host character.',
                    ),
            }),
        },
        // Server-side: Osi and ServerCharacter live only in the server VM.
        async ({ action, id }) => bridge('server', 'character.resolve', { action, id }),
    );

    defineTool(
        server,
        'bg3_life',
        {
            title: 'Damage, heal, down, kill or resurrect a character',
            description:
                'Drive a character\'s health and life state for testing death/downing/healing logic. Osiris has no ' +
                'reliable damage/HP verbs (Osi.SetHitpoints/Die are absent; Osi.ApplyDamage accepts 3 args but produces ' +
                'no observable damage), so damage/heal/setHp/fullHeal/kill work by writing HealthComponent.Hp and ' +
                'replicating. That is NOT combat-faithful: an HP write to 0 does not run the DOWNED/DYING/Died pipeline ' +
                'the way a real hit does (and inside a suppressed a scene-manager mod scene leaves a "limbo death"), so validate real ' +
                'death logic with an in-game hit where it matters. down applies the DOWNED status (only sticks with no ' +
                'active scene/suppressor); resurrect uses Osi.Resurrect when present and otherwise just restores HP. ' +
                'Every mutating action reports before/after HP and dead/downed state after a short settle window, plus ' +
                'the method used and any faithfulness caveat. Server-side only. Verify the settled result, not the call.',
            inputSchema: z.object({
                action: z
                    .enum(['status', 'damage', 'heal', 'setHp', 'fullHeal', 'kill', 'down', 'resurrect'])
                    .default('status')
                    .describe(
                        'status reads HP + life state; damage/heal/setHp/fullHeal/kill write HP; down applies DOWNED; ' +
                            'resurrect restores life (Osi.Resurrect when available)',
                    ),
                character: z.string().optional().describe('Character UUID (bare or prefixed); defaults to the host character'),
                amount: z
                    .number()
                    .optional()
                    .describe('HP amount for damage/heal/setHp. Required for those actions; ignored otherwise.'),
                duration: z.number().default(6).describe('Seconds the DOWNED status lasts for action=down'),
                settleMs: z
                    .number()
                    .int()
                    .min(0)
                    .max(10000)
                    .default(500)
                    .describe('How long to wait after the change before reading post-state. 0 reads immediately (may miss async settle).'),
            }),
        },
        // Server-side: entity health writes and Osi calls are server-only.
        async ({ action, character, amount, duration, settleMs }) =>
            bridge('server', 'life', { action, character, amount, duration, settleMs }),
    );

    defineTool(
        server,
        'bg3_osiris_functions',
        {
            title: 'List or probe Osiris functions',
            description:
                'Discover Osiris calls/queries/events instead of guessing names like ApplyDamage/DealDamage/Damage ' +
                'blindly. action=list enumerates the whole Osi table (pairs(Osi) is enumerable — ~1303 names on SE v32), ' +
                'optionally narrowed by a substring query — this is the authoritative name set. What list cannot give is ' +
                'a reliable arity/type per name: the generated signatures lie and only a real call settles a shape. ' +
                'action=probe fills that gap for specific names by calling each with zero arguments inside pcall: SE ' +
                'raises a distinct "No function named X ... with N parameters" for a name it knows (exists:true) versus ' +
                'an "attempt to call a nil value" for one it does not (exists:false). SE rejects a wrong arity BEFORE ' +
                'executing, so probing never triggers a mutating call (those are all arity >= 1); only a genuinely ' +
                'parameterless function (usually a harmless query) would actually run, which is flagged. Probe confirms ' +
                'existence, not the correct arity — the error text does not reveal it. Server-side only.',
            inputSchema: z.object({
                action: z
                    .enum(['list', 'probe'])
                    .default('list')
                    .describe('list enumerates Osi names (optionally filtered by query); probe checks specific names for existence'),
                query: z
                    .string()
                    .optional()
                    .describe('Case-insensitive substring filter for action=list, e.g. "damage", "status", "hitpoint"'),
                names: z
                    .array(z.string().min(1))
                    .optional()
                    .describe('Osiris function names to check for action=probe, e.g. ["ApplyDamage","SetHitpoints","Resurrect","Die"]'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(5000)
                    .default(100)
                    .describe('Maximum names returned by action=list; matches are counted in full'),
            }),
        },
        // Server-side: the Osi story-function table lives in the server VM.
        async ({ action, query, names, limit }) => bridge('server', 'osiris.probe', { action, query, names, limit }),
    );

    defineTool(
        server,
        'bg3_vfs_probe',
        {
            title: 'Probe what the game VFS serves for a path',
            description:
                'Read a file through the game\'s virtual file system and report the byte length it serves \u2014 the decisive ' +
                'test for which physical copy is live when both a .pak and loose files exist. BG3 binds a module to its ' +
                'pak: with Mods/<mod>.pak installed AND loose dirs in Data/, the game serves the PAK copy of every file ' +
                '("loose overrides pak" does NOT hold), and a new loose file is invisible until restart because the VFS ' +
                'loose index is built at boot. Compare this length against your on-disk source to know whether an edit is ' +
                'actually being served. Note LoadFile needs the ioContext arg ("data" for mod content); without it some ' +
                'paths return nil. Lua hot-reload (bg3_reload) is the exception that re-reads scripts from disk.',
            inputSchema: z.object({
                path: z
                    .string()
                    .min(1)
                    .describe('VFS path, e.g. "Mods/BG3AgentBridge/ScriptExtender/Lua/BootstrapServer.lua"'),
                ioContext: z
                    .enum(['data', 'user', 'save'])
                    .default('data')
                    .describe('LoadFile context. "data" for mod/game content; most mod paths need this.'),
                context: contextSchema,
            }),
        },
        async ({ path, ioContext, context }) => bridge(context, 'vfs.probe', { path, ioContext }),
    );

    defineTool(
        server,
        'bg3_read_log',
        {
            title: 'Read Script Extender logs',
            description:
                'Read a Script Extender log — the primary feedback channel for Lua and Osiris behavior. Pick the channel with ' +
                'logType: "extender" holds your mod\'s print/Ext.Utils.Print output and script errors, "osiris" holds ' +
                'story/rule traffic (the >>> event ... lines). Cut noise with filter (a regex — your mod name, or "error"). ' +
                'For a live read-eval loop, follow mode is the key feature: pass the cursor from a previous response to get ' +
                'ONLY lines appended since — schedule your diagnostic prints with bg3_eval, then follow the extender log ' +
                'instead of re-reading the whole tail. head=true reads from the top of the file (session startup).',
            inputSchema: z.object({
                lines: z.number().int().min(1).max(2000).default(100).describe('How many lines to return'),
                logType: z
                    .enum(['extender', 'osiris'])
                    .optional()
                    .describe(
                        'Which channel to read: "extender" for Lua output and script errors, "osiris" for story/rule logs. ' +
                            'Defaults to the newest log of any channel — which is usually the noisy Osiris one, so set this.',
                    ),
                filter: z
                    .string()
                    .optional()
                    .describe('Case-insensitive regular expression; use your mod name or "error" to cut noise'),
                cursor: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe(
                        'Byte offset from a previous response\'s cursor field: return only lines appended since. ' +
                            'If the file rotated in between, the response flags truncated:true and starts over.',
                    ),
                head: z.boolean().default(false).describe('Read from the start of the file instead of the end'),
                file: z.string().optional().describe('Absolute path to a specific log file; omit to use the newest'),
                namePattern: z
                    .string()
                    .optional()
                    .describe(
                        'Substring of the log filename to pick which log to read. logType is the reliable form of this; ' +
                            'namePattern remains for unusually named files.',
                    ),
            }),
        },
        async ({ lines, logType, filter, cursor, head, file, namePattern }) => {
            try {
                const result = await tailLog({ lines, logType, filter, cursor, head, file, namePattern });
                if (result.file === null) {
                    return failure(
                        `No log files found. Searched: ${logDirectories().join(', ') || '(no known log directory exists)'}. ` +
                            `Script Extender logging may be disabled in ScriptExtenderSettings.json.`,
                    );
                }
                const flags = [
                    `${result.matched} matching lines`,
                    `cursor: ${result.cursor}`,
                    result.truncated === true ? 'truncated: file shrank under the cursor, restarted from the top' : null,
                    result.capped === true ? 'capped: read limit hit, earlier content skipped' : null,
                ].filter((flag) => flag !== null);
                return text(`${result.file} (${flags.join('; ')})\n\n${result.lines.join('\n')}`);
            } catch (error) {
                return failure((error as Error).message);
            }
        },
    );

    defineTool(
        server,
        'bg3_trace_events',
        {
            title: 'Trace Osiris story events',
            description:
                'Capture the ordered stream of Osiris story events — what actually fired and in what order — by ' +
                'following the Osiris Runtime log. start marks a position, you act in game (or via other bridge ' +
                'tools), then read returns every `>>> event` line since, oldest first, optionally narrowed to an ' +
                'event-name regex and/or an entity UUID (substring match — a bare UUID also matches its prefixed ' +
                'template-name form inside event arguments). This is the fastest way to answer "did my handler fire, ' +
                'and what ran before it" — e.g. discovering that vanilla incapacitation stripped a status before a ' +
                'mod\'s own StatusRemoved handler. Log lines carry no timestamps, so order is log order. Requires ' +
                'Script Extender\'s Osiris logging to be enabled; start tells you when no Osiris log exists at all.',
            inputSchema: z.object({
                action: z
                    .enum(['start', 'read', 'stop'])
                    .default('read')
                    .describe('start begins a capture at the current end of the log; read returns events since; stop discards the capture'),
                events: z
                    .string()
                    .optional()
                    .describe('Case-insensitive regex matched against the event name, e.g. "Status(Applied|Removed)|Died"'),
                entity: z
                    .string()
                    .optional()
                    .describe('Only events whose argument text contains this string — a character UUID narrows to one actor'),
                limit: z.number().int().min(1).max(5000).default(500).describe('Maximum events returned per read'),
                cursor: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe('Explicit byte offset to read from, instead of the stored capture position'),
            }),
        },
        async ({ action, events, entity, limit, cursor }) => {
            if (action === 'stop') {
                const had = traceCapture !== null;
                traceCapture = null;
                return text(had ? 'Trace capture stopped and discarded.' : 'No trace capture was active.');
            }

            if (action === 'start') {
                const probe = await tailLog({ logType: 'osiris', lines: 1 });
                if (probe.file === null) {
                    return failure(
                        'No Osiris Runtime log found — Script Extender\'s Osiris logging appears to be disabled. ' +
                            'Enable it in ScriptExtenderSettings.json and restart the game.',
                    );
                }
                traceCapture = { file: probe.file, cursor: probe.cursor ?? 0 };
                return json({
                    file: probe.file,
                    cursor: traceCapture.cursor,
                    note: 'Capture started. Act in game, then call action=read — optionally with events/entity filters.',
                });
            }

            // read
            if (traceCapture === null && cursor === undefined) {
                return failure('No trace capture is active — call action=start first, or pass an explicit cursor with file.');
            }
            const from = cursor ?? traceCapture!.cursor;
            const file = traceCapture?.file;
            // Filter BEFORE limiting: the line cap must apply to matched events,
            // not raw log lines — a busy session logs thousands of rule/exec
            // lines between events, and a raw pre-limit would silently drop them.
            // The 512KB read cap still bounds one read; capped:true flags the skip.
            const result = await tailLog({ file, logType: 'osiris', cursor: from, lines: 1_000_000 });
            if (result.file === null) {
                return failure('No Osiris Runtime log found.');
            }

            let namePattern: RegExp | null = null;
            if (events !== undefined && events !== '') {
                try {
                    namePattern = new RegExp(events, 'i');
                } catch (error) {
                    return failure(`events is not a valid regular expression: ${(error as Error).message}`);
                }
            }

            const parsed: { event: string; args: string; line: string }[] = [];
            for (const line of result.lines) {
                const match = /^>>> event ([^(]+)\((.*)\)\s*$/.exec(line);
                const name = match?.[1];
                if (match === null || name === undefined) continue;
                if (namePattern !== null && !namePattern.test(name)) continue;
                if (entity !== undefined && entity !== '' && !line.includes(entity)) continue;
                parsed.push({ event: name, args: match[2] ?? '', line });
                if (parsed.length >= limit) break;
            }

            if (traceCapture !== null && result.file === traceCapture.file) {
                traceCapture.cursor = result.cursor ?? from;
            }

            return json({
                file: result.file,
                events: parsed,
                matched: parsed.length,
                cursor: result.cursor,
                ...(result.truncated === true ? { truncated: 'log shrank under the cursor; restarted from the top' } : {}),
                ...(result.capped === true ? { capped: 'read limit hit between reads; some log content was skipped' } : {}),
                note: 'Order is log order; lines carry no timestamps. Pass cursor back (or just call read again) to continue.',
            });
        },
    );

    defineTool(
        server,
        'bg3_list_logs',
        {
            title: 'List available log files',
            description:
                'List Script Extender and Osiris log files grouped by game session, newest session first — each launch ' +
                'writes an Extender and an Osiris log a few seconds apart. Use the file paths with bg3_read_log.',
            inputSchema: z.object({
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .default(10)
                    .describe('How many sessions to return; older history is rarely useful'),
            }),
        },
        async ({ limit }) => {
            const sessions = await listLogSessions(limit);
            if (sessions.length === 0) {
                return failure(`No log files found. Searched: ${logDirectories().join(', ') || '(none)'}`);
            }
            return json(
                sessions.map((session) => ({
                    started: new Date(session.startedMs).toISOString(),
                    files: session.files.map((entry) => ({
                        file: entry.file,
                        type: entry.type,
                        modified: new Date(entry.modifiedMs).toISOString(),
                    })),
                })),
            );
        },
    );
}

export function serve(): void {
    serveStdio(() => {
        const server = new McpServer({ name: 'bg3-agent-bridge', version: VERSION }, { capabilities: { tools: {} } });
        registerTools(server);
        return server;
    });
}

if (ranDirectly(import.meta.url)) serve();
