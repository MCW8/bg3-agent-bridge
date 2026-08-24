#!/usr/bin/env node
/**
 * Single entry for the compiled executable: one binary that is the MCP server
 * and every maintenance command, so a modder never installs Node.
 *
 *   bg3-bridge              guided setup when double-clicked; the MCP server when an agent launches it
 *   bg3-bridge setup        run the guided setup explicitly (install + connect + check)
 *   bg3-bridge install      install the companion mod into the game
 *   bg3-bridge configure    print or write the agent's MCP config
 *   bg3-bridge check        talk to the game without an agent in the loop
 *   bg3-bridge pack         build a .pak with divine (needs LSLib)
 */
import { serve } from '../index.js';
import { main as checkMain } from './check-bridge.js';
import { main as configureMain } from './configure-agent.js';
import { main as installMain } from './install-dev.js';
import { main as packMain } from './install-mod.js';
import { main as setupMain } from './setup-wizard.js';

const USAGE = `
  bg3-bridge                  guided setup when double-clicked; the MCP server when launched by an agent
  bg3-bridge setup            run the guided setup (install + connect + check)
  bg3-bridge serve            run the MCP server explicitly
  bg3-bridge install          install the companion mod (--uninstall to remove)
  bg3-bridge configure        print the agent MCP config (--list, --write, --path)
  bg3-bridge check            verify the bridge without an agent
  bg3-bridge pack             build a .pak with divine
`;

const [command, ...args] = process.argv.slice(2);

switch (command) {
    case undefined:
        // No args: an MCP client launches us this way over a pipe (stdin is not
        // a TTY) and expects the stdio server. A human double-clicking, or
        // running bare in a terminal, gets an interactive console — route them
        // to guided setup instead of a silent, useless server window.
        if (process.stdin.isTTY === true) {
            await setupMain();
        } else {
            serve();
        }
        break;
    case 'serve':
        serve();
        break;
    case 'setup':
        await setupMain();
        break;
    case 'install':
        installMain(args);
        break;
    case 'configure':
        configureMain(args);
        break;
    case 'check':
        await checkMain();
        break;
    case 'pack':
        process.exitCode = packMain();
        break;
    default: {
        const known = command === 'help' || command === '--help' || command === '-h';
        (known ? console.log : console.error)(USAGE);
        process.exit(known ? 0 : 1);
    }
}
