import path from "node:path";
import { beforeAll, afterAll } from "vitest";
import { MCPClient } from "./utils/mcp-client.js";
import { setGlobalMCPClient, spawnedProcesses } from "./globals.js";

// Re-export for backwards compatibility
export { globalMCPClient, spawnedProcesses } from "./globals.js";

beforeAll(async () => {
  // Build steps live in tests/globalSetup.ts so they run once for the whole test run,
  // not multiple times across workers.
  const serverPath = path.resolve(__dirname, "../dist/index.js");
  const client = new MCPClient(serverPath);

  await client.connect();
  setGlobalMCPClient(client);

  const serverProcess = client.getServerProcess();

  if (serverProcess?.pid) {
    spawnedProcesses.add(serverProcess.pid);
  }
});

afterAll(async () => {
  const { globalMCPClient } = await import("./globals.js");

  if (globalMCPClient) {
    await globalMCPClient.disconnect();
    setGlobalMCPClient(null);
  }
});
