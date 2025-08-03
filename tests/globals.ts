import { MCPClient } from "./utils/mcp-client";

// Global MCP client instance for all tests
export let globalMCPClient: MCPClient | null = null;

// Track spawned process PIDs for proper cleanup
export const spawnedProcesses = new Set<number>();

// Function to set global MCP client
export function setGlobalMCPClient(client: MCPClient | null) {
  globalMCPClient = client;
}
