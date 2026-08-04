#!/usr/bin/env node
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

import { callBridge, readHello, type BridgeContext } from './mailbox.js';
import { listLogFiles, tailLog } from './logs.js';
import { bridgeDir, logDirectories } from './paths.js';

const VERSION = '0.1.0';

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
async function bridge(context: BridgeContext, op: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
    try {
        return json(await callBridge(context, op, params));
    } catch (error) {
        return failure((error as Error).message);
    }
}

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
        'bg3_eval',
        {
            title: 'Evaluate Lua in the running game',
            description:
                'Run a Lua chunk inside the live game and return its values. Use `return` to get a value back. ' +
                'Availability depends on the Script Extender build exposing load() to mod scripts — check bg3_bridge_status first.',
            inputSchema: z.object({
                code: z.string().min(1).describe('Lua source to execute, e.g. "return Osi.GetHostCharacter()"'),
                context: contextSchema,
            }),
        },
        async ({ code, context }) => bridge(context, 'eval', { code }),
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
                'the edit-test loop; changes to packed data such as stats or root templates still need a repack and restart.',
            inputSchema: z.object({ context: contextSchema }),
        },
        async ({ context }) => {
            const result = await bridge(context, 'reset');
            if (result.isError === true) return result;
            return text(
                `Lua VM reset scheduled for the ${context} context. Give it a moment, then call bg3_read_log to see whether ` +
                    `your scripts reloaded cleanly.`,
            );
        },
    );

    defineTool(
        server,
        'bg3_read_log',
        {
            title: 'Read Script Extender logs',
            description:
                'Tail the newest Script Extender or Osiris log. This is where Lua errors surface, so it is the tool to reach for ' +
                'after bg3_reload or when a script silently does nothing.',
            inputSchema: z.object({
                lines: z.number().int().min(1).max(2000).default(100).describe('How many trailing lines to return'),
                filter: z
                    .string()
                    .optional()
                    .describe('Case-insensitive regular expression; use your mod name or "error" to cut noise'),
                file: z.string().optional().describe('Absolute path to a specific log file; omit to use the newest'),
                namePattern: z
                    .string()
                    .optional()
                    .describe(
                        'Substring of the log filename to pick which log to read. Script Extender writes several at once — ' +
                            'use "Extender Runtime" for Lua output and script errors, "Osiris" for story/rule logs.',
                    ),
            }),
        },
        async ({ lines, filter, file, namePattern }) => {
            try {
                const result = await tailLog({ lines, filter, file, namePattern });
                if (result.file === null) {
                    return failure(
                        `No log files found. Searched: ${logDirectories().join(', ') || '(no known log directory exists)'}. ` +
                            `Script Extender logging may be disabled in ScriptExtenderSettings.json.`,
                    );
                }
                return text(`${result.file} (${result.matched} matching lines)\n\n${result.lines.join('\n')}`);
            } catch (error) {
                return failure((error as Error).message);
            }
        },
    );

    defineTool(
        server,
        'bg3_list_logs',
        {
            title: 'List available log files',
            description: 'List Script Extender and Osiris log files, newest first, for use with bg3_read_log.',
            inputSchema: z.object({}),
        },
        async () => {
            const files = await listLogFiles();
            if (files.length === 0) {
                return failure(`No log files found. Searched: ${logDirectories().join(', ') || '(none)'}`);
            }
            return json(files.map((entry) => ({ file: entry.file, modified: new Date(entry.modifiedMs).toISOString() })));
        },
    );
}

serveStdio(() => {
    const server = new McpServer({ name: 'bg3-agent-bridge', version: VERSION }, { capabilities: { tools: {} } });
    registerTools(server);
    return server;
});
