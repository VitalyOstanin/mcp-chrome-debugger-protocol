#!/usr/bin/env node

import { NodeDebuggerMCPServer } from "./mcp-server.js";
import { logError } from "./logger.js";

async function main() {
  const server = new NodeDebuggerMCPServer();

  await server.run();
}

main().catch((error) => {
  logError("Server error", error);
  process.exit(1);
});
