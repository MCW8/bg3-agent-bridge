// Verify the bridge without an MCP client in the loop.
// Usage: node scripts/check-bridge.mjs
import { callBridge, readHello } from '../dist/mailbox.js';
import { bridgeDir } from '../dist/paths.js';
import { tailLog } from '../dist/logs.js';

console.log(`mailbox: ${bridgeDir()}\n`);

let anyOnline = false;

for (const context of ['server', 'client']) {
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
        console.log(`  ping: ${error.constructor.name} — ${error.message}`);
    }
}

if (anyOnline) {
    console.log('\n--- eval probe ---');
    try {
        const result = await callBridge('server', 'eval', { code: 'return 2 + 2' });
        console.log(`eval: ${JSON.stringify(result)}`);
    } catch (error) {
        console.log(`eval: ${error.constructor.name} — ${error.message}`);
    }
}

console.log('\n--- bridge lines in the newest log ---');
const log = await tailLog({ lines: 15, filter: 'AgentBridge|BG3AgentBridge' });
console.log(log.file ?? '(no log found)');
console.log(log.matched === 0 ? '(no bridge output yet)' : log.lines.join('\n'));

process.exit(0);
