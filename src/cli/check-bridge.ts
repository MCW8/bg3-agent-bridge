#!/usr/bin/env node
/**
 * Verify the bridge without an MCP client in the loop.
 *
 * Usage:  bg3-bridge check   (exe)
 *         node scripts/check-bridge.mjs   (Node)
 */
import { callBridge, readHello, type BridgeContext } from '../mailbox.js';
import { bridgeDir } from '../paths.js';
import { tailLog } from '../logs.js';
import { ranDirectly } from '../runtime.js';

export async function main(): Promise<void> {
    console.log(`mailbox: ${bridgeDir()}\n`);

    let anyOnline = false;

    for (const context of ['server', 'client'] as BridgeContext[]) {
        const hello = await readHello(context);
        if (hello === null) {
            console.log(`${context}: no handshake file — the mod has not booted in this context`);
            continue;
        }

        console.log(`${context}: handshake found, protocol ${hello.protocol}`);
        console.log(`  capabilities: ${JSON.stringify(hello.capabilities)}`);

        try {
            const pong = await callBridge(context, 'ping', {}, { timeoutMs: 4000 });
            console.log(`  ping: OK ${JSON.stringify(pong)}`);
            anyOnline = true;
        } catch (error) {
            console.log(`  ping: ${(error as Error).name} — ${(error as Error).message}`);
        }
    }

    if (anyOnline) {
        console.log('\n--- eval probe ---');
        try {
            const result = await callBridge('server', 'eval', { code: 'return 2 + 2' });
            console.log(`eval: ${JSON.stringify(result)}`);
        } catch (error) {
            console.log(`eval: ${(error as Error).name} — ${(error as Error).message}`);
        }
    }

    console.log('\n--- bridge lines in the newest Extender log ---');
    const log = await tailLog({ lines: 15, filter: 'AgentBridge|BG3AgentBridge', namePattern: 'Extender Runtime' });
    console.log(log.file ?? '(no log found)');
    console.log(log.matched === 0 ? '(no bridge output yet)' : log.lines.join('\n'));
}

if (ranDirectly(import.meta.url)) await main();
