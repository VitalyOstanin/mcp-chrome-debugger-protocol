import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import { setTimeout } from "node:timers/promises";
import { globalMCPClient } from "../setup";

describe("MCP Chrome Debugger Protocol - Basic State Switching", () => {
  let testApp: TestAppManager;
  let debuggerHelper: DebuggerTestHelper;

  beforeEach(async () => {
    if (!globalMCPClient) {
      throw new Error("Global MCP client not initialized");
    }

    testApp = new TestAppManager();
    debuggerHelper = new DebuggerTestHelper(globalMCPClient, testApp);
  });

  afterEach(async () => {
    try {
      await debuggerHelper.disconnectFromDebugger();
    } catch {
      // Ignore disconnect errors in cleanup
    }

    await testApp.stop();
  });

  describe("connect_url tool state switching", () => {
    it("should work correctly with Claude Code CLI", async () => {
      const { pid, webSocketUrl } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(webSocketUrl).toBeDefined();

      await setTimeout(2000);

      // Before connection - connect_url should be available
      const connectResult = await globalMCPClient!.callTool("connect_url", {
        url: webSocketUrl!
      });

      expect(connectResult.isError).toBeFalsy();
      expect(connectResult.content[0].text).toContain("Successfully connected");

      // Wait for tool state changes to propagate
      await setTimeout(1000);

      // After connection - connect_url should be disabled
      const connectResult2 = await globalMCPClient!.callTool("connect_url", { url: webSocketUrl! });

      expect(connectResult2.isError).toBe(true);
      expect(connectResult2.content[0].text).toContain("disabled");

      // Check debugger state after connection
      const debuggerStateResult = await globalMCPClient!.callTool("get_debugger_state");

      expect(debuggerStateResult.isError).toBeFalsy();

      // Wait a bit for tool state to propagate
      await setTimeout(500);

      // After connection - try a simple tool that should work
      const disconnectTest = await globalMCPClient!.callTool("disconnect");

      expect(disconnectTest.isError).toBeFalsy();

      // Disconnect
      await debuggerHelper.disconnectFromDebugger();

      // After disconnect - connect_default should be available again
      // But we can't test this easily since we already used the port
    });

    it("should prevent using debugging tools when disconnected", async () => {
      // Without connection, debugging tools should be disabled
      const disconnectResult = await globalMCPClient!.callTool("disconnect");

      expect(disconnectResult.isError).toBe(true);
      expect(disconnectResult.content[0].text).toContain("disabled");

      const breakpointResult = await globalMCPClient!.callTool("set_breakpoint", {
        filePath: "/some/path",
        lineNumber: 1,
        columnNumber: 0
      });

      expect(breakpointResult.isError).toBe(true);
      expect(breakpointResult.content[0].text).toContain("disabled");

      const evaluateResult = await globalMCPClient!.callTool("evaluate", {
        expression: "1 + 1"
      });

      expect(evaluateResult.isError).toBe(true);
      expect(evaluateResult.content[0].text).toContain("Not connected");
    });

    it("should allow using connection tools when disconnected", async () => {
      // Connection tools should work when disconnected
      const { pid, webSocketUrl } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(webSocketUrl).toBeDefined();
      await setTimeout(2000);

      const connectResult = await globalMCPClient!.callTool("connect_url", {
        url: webSocketUrl!
      });

      expect(connectResult.isError).toBeFalsy();
      expect(connectResult.content[0].text).toContain("Successfully connected");
    });
  });

  describe("Connection and disconnection flow", () => {
    it("should handle complete connect-disconnect cycle", async () => {
      const { pid, port } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      await setTimeout(2000);

      // Step 1: Connect
      await debuggerHelper.connectToDebugger(port);

      // Wait for tool state changes to propagate
      await setTimeout(1000);

      // Step 2: Verify debugging tools work
      const evaluateResult = await globalMCPClient!.callTool("evaluate", {
        expression: "typeof process"
      });

      expect(evaluateResult.isError).toBeFalsy();

      // Step 3: Verify connection tools are disabled
      const connectResult3 = await globalMCPClient!.callTool("connect_url", { url: `ws://127.0.0.1:${port}` });

      expect(connectResult3.isError).toBe(true);
      expect(connectResult3.content[0].text).toContain("disabled");

      // Step 4: Disconnect
      await debuggerHelper.disconnectFromDebugger();

      // Wait for tool state changes to propagate
      await setTimeout(1000);

      // Step 5: Verify debugging tools are disabled after disconnect
      const result = await globalMCPClient!.callTool("evaluate", {
        expression: "1 + 1"
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not connected");
    });
  });
});
