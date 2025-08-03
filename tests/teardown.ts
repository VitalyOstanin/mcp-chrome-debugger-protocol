export default async function teardown() {

  // Import setup to access tracked processes
  let globalMCPClient = null;
  let spawnedProcesses = new Set<number>();

  try {
    // Import the globals module to get access to variables
    const { globalMCPClient: client, spawnedProcesses: processes } = await import("./globals");

    globalMCPClient = client;
    spawnedProcesses = processes;
  } catch (error) {
    console.warn("Error importing globals module:", error);
  }

  // Disconnect global MCP client
  try {
    if (globalMCPClient) {
      await globalMCPClient.disconnect();
    }
  } catch (error) {
    console.warn("Error disconnecting global MCP client:", error);
  }

  // Kill any remaining tracked processes
  for (const pid of spawnedProcesses) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process might already be dead, try SIGKILL
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process is already dead or doesn't exist
      }
    }
  }
}
