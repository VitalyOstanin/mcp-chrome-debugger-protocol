import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import { waitForDebuggerState } from "../utils/wait-helpers";
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

  describe("attach tool state switching", () => {
    it("should work correctly with Claude Code CLI", async () => {
      const { pid, webSocketUrl } = await testApp.start({
        enableDebugger: true,
      });

      expect(pid).toBeDefined();
      expect(webSocketUrl).toBeDefined();

      // App is ready immediately after start

      // Before connection - attach should be available
      const connectResult = await globalMCPClient!.callTool("attach", {
        url: webSocketUrl!,
      });
      const connectData = JSON.parse(connectResult.content[0].text);

      expect(connectData.success).toBe(true);

      // Wait until connection state is reflected in debugger state
      await waitForDebuggerState(globalMCPClient!, (s: unknown) => {
        if (!(s && typeof s === 'object')) return false;

        const st = s as { connection?: { isConnected?: boolean } };

        return st.connection?.isConnected === true;
      });

      // After connection - attach should be disabled
      const connectResult2 = await globalMCPClient!.callTool("attach", { url: webSocketUrl! });

      expect(connectResult2.isError).toBe(true);
      expect(connectResult2.content[0].text).toContain("disabled");

      // Check debugger state after connection
      const debuggerStateResult = await globalMCPClient!.callTool("getDebuggerState");

      expect(debuggerStateResult.isError).toBeFalsy();

      // Ensure state reflects connected tools
      await waitForDebuggerState(globalMCPClient!, (s: unknown) => {
        if (!(s && typeof s === 'object')) return false;

        const st = s as { state?: { disabledTools?: string[] } };

        return Array.isArray(st.state?.disabledTools) && st.state.disabledTools.includes('attach');
      });

      // After connection - try a simple tool that should work
      const disconnectTest = await globalMCPClient!.callTool("disconnect");

      expect(disconnectTest.content[0].text).toContain("Disconnected");

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

      const breakpointResult = await globalMCPClient!.callTool("setBreakpoints", {
        source: { path: "/some/path" },
        breakpoints: [{ line: 1 }],
      });

      expect(breakpointResult.isError).toBe(true);
      expect(breakpointResult.content[0].text).toContain("disabled");

      const evaluateResult = await globalMCPClient!.callTool("evaluate", {
        expression: "1 + 1",
      });

      expect(evaluateResult.isError).toBe(true);
      expect(evaluateResult.content[0].text).toContain("disabled");
    });

    it("should allow using connection tools when disconnected", async () => {
      // Connection tools should work when disconnected
      const { pid, webSocketUrl } = await testApp.start({
        enableDebugger: true,
      });

      expect(pid).toBeDefined();
      expect(webSocketUrl).toBeDefined();

      const connectResult = await globalMCPClient!.callTool("attach", {
        url: webSocketUrl!,
      });
      const connectResultData = JSON.parse(connectResult.content[0].text);

      expect(connectResultData.success).toBe(true);
    });
  });

  describe("Connection and disconnection flow", () => {
    it("should handle complete connect-disconnect cycle", async () => {
      const { pid, port } = await testApp.start({
        enableDebugger: true,
      });

      expect(pid).toBeDefined();

      // Step 1: Connect
      await debuggerHelper.connectToDebugger(port);

      // Wait until connected state is reflected
      await waitForDebuggerState(globalMCPClient!, (s: unknown) => {
        if (!(s && typeof s === 'object')) return false;

        const st = s as { connection?: { isConnected?: boolean } };

        return st.connection?.isConnected === true;
      });

      // Step 2: Verify debugging tools work
      const evaluateResult = await globalMCPClient!.callTool("evaluate", {
        expression: "typeof process",
      });

      expect(evaluateResult.isError).toBeFalsy();

      // Step 3: Verify connection tools are disabled
      const connectResult3 = await globalMCPClient!.callTool("attach", { url: `ws://127.0.0.1:${port}` });

      expect(connectResult3.isError).toBe(true);
      expect(connectResult3.content[0].text).toContain("disabled");

      // Step 4: Disconnect
      await debuggerHelper.disconnectFromDebugger();

      // Wait until disconnected state is reflected
      await waitForDebuggerState(globalMCPClient!, (s: unknown) => {
        if (!(s && typeof s === 'object')) return false;

        const st = s as { connection?: { isConnected?: boolean } };

        return st.connection?.isConnected === false;
      });

      // Step 5: Verify debugging tools are disabled after disconnect
      const result = await globalMCPClient!.callTool("evaluate", {
        expression: "1 + 1",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });
  });
});
