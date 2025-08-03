#!/usr/bin/env node

import { NodeDebuggerMCPServer } from "./mcp-server.js";

async function main() {
  const server = new NodeDebuggerMCPServer();

  await server.run();
}


if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
