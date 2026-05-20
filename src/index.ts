#!/usr/bin/env node

import { NodeDebuggerMCPServer } from "./mcp-server.js";
import { logError } from "./logger.js";

// Fire-and-forget paths exist throughout the codebase (CDP event handlers,
// `void this.cdpTransport.sendCommand(...)` in nodejs-debug-adapter, async
// listeners passed to EventEmitter.on). Without these top-level handlers a
// rejection from any of those would either be swallowed by Node's default
// unhandledRejection behaviour or terminate the process abruptly without
// stderr context, leaving MCP clients with nothing but a stdio disconnect.
//
// uncaughtException is treated as fatal: the process state is undefined past
// this point, so we log and exit non-zero so the host (Claude Code, etc) can
// restart us cleanly. unhandledRejection is logged but does not exit -- many
// rejections come from event handlers whose failure should not take down the
// whole debug session.
process.on('uncaughtException', (error: Error) => {
  logError('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logError('Unhandled promise rejection', reason);
});

async function main() {
  const server = new NodeDebuggerMCPServer();

  await server.run();
}

main().catch((error) => {
  logError("Server error", error);
  process.exit(1);
});
