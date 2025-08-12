import { MCPClient } from "../utils/mcp-client";
import { TestAppManager } from "../utils/test-app-manager";
import path from "path";

interface Test1Response {
  message: string;
  fibonacci: number;
  breakpoint: number;
  timestamp: string;
}

interface Test2Response {
  message: string;
  async: string;
  recursive: number;
  timestamp: string;
}

interface HealthResponse {
  status: string;
  pid: number;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  data: {
    count: number;
    processCount: number;
  };
}

describe("MCP Chrome Debugger Protocol - HTTP Server Tests", () => {
  let mcpClient: MCPClient;
  let testApp: TestAppManager;
  const serverPath = path.resolve(__dirname, "../../dist/index.js");

  beforeEach(async () => {
    mcpClient = new MCPClient(serverPath);
    testApp = new TestAppManager();

    await mcpClient.connect();
  });

  afterEach(async () => {
    await testApp.stop();
    await mcpClient.disconnect();
  });

  describe("HTTP server functionality", () => {
    it("should start HTTP server and be accessible", async () => {
      const { pid, serverPort } = await testApp.start();

      expect(pid).toBeDefined();
      expect(serverPort).toBeDefined();
      expect(serverPort).toBeGreaterThan(0);

      // Verify server is accessible
      const response1 = await fetch(`http://localhost:${serverPort}/test1`);

      expect(response1.status).toBe(200);

      const data1 = await response1.json() as Test1Response;

      expect(data1.message).toBe("test1 endpoint");
      expect(data1.fibonacci).toBeDefined();
      expect(data1.breakpoint).toBeDefined();

      const response2 = await fetch(`http://localhost:${serverPort}/test2`);

      expect(response2.status).toBe(200);

      const data2 = await response2.json() as Test2Response;

      expect(data2.message).toBe("test2 endpoint");
      expect(data2.async).toBeDefined();
      expect(data2.recursive).toBeDefined();

      const healthResponse = await fetch(`http://localhost:${serverPort}/health`);

      expect(healthResponse.status).toBe(200);

      const healthData = await healthResponse.json() as HealthResponse;

      expect(healthData.status).toBe("ok");
      expect(healthData.pid).toBe(pid);
    });

    it("should work with debugger enabled", async () => {
      const { pid, port, serverPort } = await testApp.start({ enableDebugger: true });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();
      expect(serverPort).toBeDefined();

      // Verify both debugger and HTTP server are working
      const response = await fetch(`http://localhost:${serverPort}/test1`);

      expect(response.status).toBe(200);

      const data = await response.json() as Test1Response;

      expect(data.message).toBe("test1 endpoint");

      // Verify we can connect to debugger (basic check)
      expect(port).toBeGreaterThan(0);
      expect(testApp.getWebSocketUrl()).toContain(`ws://127.0.0.1:${port}`);
    });
  });
});
