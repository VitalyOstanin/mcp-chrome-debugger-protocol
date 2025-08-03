#!/usr/bin/env node

import { NodeDebuggerMCPServer } from "./mcp-server.js";

async function main() {
  const server = new NodeDebuggerMCPServer();

  await server.run();
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
