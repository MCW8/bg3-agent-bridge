#!/usr/bin/env node
/**
 * Single entry for the compiled executable: one binary that is the MCP server
 * and every maintenance command, so a modder never installs Node.
 *
 *   bg3-bridge              run the MCP server (what agent configs point at)
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

const USAGE = `
  bg3-bridge                  run the MCP server (no arguments)
  bg3-bridge install          install the companion mod (--uninstall to remove)
  bg3-bridge configure        print the agent MCP config (--list, --write, --path)
  bg3-bridge check            verify the bridge without an agent
  bg3-bridge pack             build a .pak with divine
`;

const [command, ...args] = process.argv.slice(2);

switch (command) {
    case undefined:
    case 'serve':
        serve();
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
