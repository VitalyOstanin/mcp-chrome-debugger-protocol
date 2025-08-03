import { execSync } from "child_process";
import path from "path";
import { MCPClient } from "./utils/mcp-client";
import { setGlobalMCPClient, spawnedProcesses } from "./globals";

// Re-export for backwards compatibility
export { globalMCPClient, spawnedProcesses } from "./globals";

beforeAll(async () => {
  // Build the main project
  execSync("npm run build", { cwd: path.resolve(__dirname, ".."), stdio: "pipe" });

  // Build TypeScript test application
  const testAppPath = path.resolve(__dirname, "fixtures/test-app");

  execSync("npm install", { cwd: testAppPath, stdio: "pipe" });
  execSync("npm run build", { cwd: testAppPath, stdio: "pipe" });

  // Setup JavaScript test application
  const testAppJsPath = path.resolve(__dirname, "fixtures/test-app-js");

  execSync("npm install", { cwd: testAppJsPath, stdio: "pipe" });

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
