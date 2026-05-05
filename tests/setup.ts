import path from "path";
import { MCPClient } from "./utils/mcp-client";
import { setGlobalMCPClient, spawnedProcesses } from "./globals";

// Re-export for backwards compatibility
export { globalMCPClient, spawnedProcesses } from "./globals";

beforeAll(async () => {
  // Build steps live in tests/globalSetup.ts so they run once for the whole test run,
  // not 4 times in parallel across workers (which races on shared output dirs).
  // Create global MCP client
  const serverPath = path.resolve(__dirname, "../dist/index.js");
  const client = new MCPClient(serverPath);

  await client.connect();
  setGlobalMCPClient(client);

  // Track the MCP server process PID
  const serverProcess = client.getServerProcess();

  if (serverProcess?.pid) {
    spawnedProcesses.add(serverProcess.pid);
  }
});

afterAll(async () => {
  // Ensure global MCP client is properly closed
  const { globalMCPClient } = await import("./globals");

  if (globalMCPClient) {
    await globalMCPClient.disconnect();
    setGlobalMCPClient(null);
  }
});
