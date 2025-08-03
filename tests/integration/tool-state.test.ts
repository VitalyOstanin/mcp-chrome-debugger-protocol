import { MCPClient } from "../utils/mcp-client";
import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import path from "path";
import { setTimeout } from "node:timers/promises";

describe("MCP Chrome Debugger Protocol - Tool State Management", () => {
  let mcpClient: MCPClient;
  let testApp: TestAppManager;
  let debuggerHelper: DebuggerTestHelper;
  const serverPath = path.resolve(__dirname, "../../dist/index.js");

  beforeEach(async () => {
    mcpClient = new MCPClient(serverPath);
    testApp = new TestAppManager();
    debuggerHelper = new DebuggerTestHelper(mcpClient, testApp);

    await mcpClient.connect();
  });

  afterEach(async () => {
    try {
      await debuggerHelper.disconnectFromDebugger();
    } catch {
      // Ignore disconnect errors in cleanup
    }

    await testApp.stop();
    await mcpClient.disconnect();
  });

  describe("Tool state switching on connection", () => {
    it("should disable connection tools and enable debugging tools after connect_url", async () => {
      const { pid, port, webSocketUrl } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();
      expect(webSocketUrl).toBeDefined();

      await setTimeout(2000);

      // Before connection - connection tools should be available, debugging tools should be disabled
      const initialStateResult = await mcpClient.callTool("get_debugger_state");

      expect(initialStateResult.isError).toBeFalsy();

      const initialState = JSON.parse(initialStateResult.content[0].text);

      expect(initialState.connection.isConnected).toBeFalsy();
      expect(initialState.state.state).toBe('disconnected');

      // Connection tools should be enabled in disconnected state
      expect(initialState.state.enabledTools).toContain('connect_default');
      expect(initialState.state.enabledTools).toContain('connect_url');
      expect(initialState.state.enabledTools).toContain('enable_debugger_pid');

      // Debugging tools should be disabled
      expect(initialState.state.disabledTools).toContain('disconnect');
      expect(initialState.state.disabledTools).toContain('set_breakpoint');
      expect(initialState.state.disabledTools).toContain('evaluate');

      // Connect to debugger using connect_url with full WebSocket URL
      const connectResult = await mcpClient.callTool("connect_url", {
        url: webSocketUrl!
      });

      expect(connectResult.isError).toBeFalsy();
      expect(connectResult.content[0].text).toContain("Successfully connected");

      // After connection - tool states should flip
      const connectedStateResult = await mcpClient.callTool("get_debugger_state");

      expect(connectedStateResult.isError).toBeFalsy();

      const connectedState = JSON.parse(connectedStateResult.content[0].text);

      expect(connectedState.connection.isConnected).toBeTruthy();
      expect(connectedState.state.state).toBe('connected');

      // Connection tools should now be disabled
      expect(connectedState.state.disabledTools).toContain('connect_default');
      expect(connectedState.state.disabledTools).toContain('connect_url');
      expect(connectedState.state.disabledTools).toContain('enable_debugger_pid');

      // Debugging tools should now be enabled
      expect(connectedState.state.enabledTools).toContain('disconnect');
      expect(connectedState.state.enabledTools).toContain('set_breakpoint');
      expect(connectedState.state.enabledTools).toContain('evaluate');
    });

    it("should prevent using disabled connection tools when connected", async () => {
      const { pid, webSocketUrl } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(webSocketUrl).toBeDefined();
      await setTimeout(2000);

      // Connect first
      const connectResult = await mcpClient.callTool("connect_url", {
        url: webSocketUrl!
      });

      expect(connectResult.isError).toBeFalsy();

      // Now try to use connection tools - they should be disabled
      const connectResult2 = await mcpClient.callTool("connect_url", { url: webSocketUrl! });

      expect(connectResult2.isError).toBe(true);
      expect(connectResult2.content[0].text).toContain("disabled");

      const connectResult3 = await mcpClient.callTool("connect_url", { url: "ws://localhost:9229" });

      expect(connectResult3.isError).toBe(true);
      expect(connectResult3.content[0].text).toContain("disabled");

      const enableResult = await mcpClient.callTool("enable_debugger_pid", { pid: pid! });

      expect(enableResult.isError).toBe(true);
      expect(enableResult.content[0].text).toContain("disabled");
    });

    it("should prevent using disabled debugging tools when disconnected", async () => {
      // Without connection, debugging tools should be disabled
      const disconnectResult = await mcpClient.callTool("disconnect");

      expect(disconnectResult.isError).toBe(true);
      expect(disconnectResult.content[0].text).toContain("disabled");

      const breakpointResult = await mcpClient.callTool("set_breakpoint", {
        filePath: "/some/path",
        lineNumber: 1,
        columnNumber: 0
      });

      expect(breakpointResult.isError).toBe(true);
      expect(breakpointResult.content[0].text).toContain("disabled");

      const evaluateResult = await mcpClient.callTool("evaluate", {
        expression: "1 + 1"
      });

      expect(evaluateResult.isError).toBe(true);
      expect(evaluateResult.content[0].text).toContain("Not connected");

      const callStackResult = await mcpClient.callTool("get_call_stack");

      // get_call_stack should either error or indicate it's not connected
      if (callStackResult.isError) {
        expect(callStackResult.content[0].text).toContain("Not connected");
      } else {
        // If it doesn't error, it should return some indication that it can't work
        expect(callStackResult.content[0].text).toMatch(/(not available|disabled|Not connected|requires connection)/i);
      }
    });

    it("should correctly handle tool states after disconnect", async () => {
      const { pid, port } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      await setTimeout(2000);

      // Connect
      await debuggerHelper.connectToDebugger(port);

      // Verify we're connected and debugging tools are available
      const connectedStateResult = await mcpClient.callTool("get_debugger_state");
      const connectedState = JSON.parse(connectedStateResult.content[0].text);

      expect(connectedState.connection.isConnected).toBeTruthy();
      expect(connectedState.state.enabledTools).toContain('disconnect');

      // Disconnect
      await debuggerHelper.disconnectFromDebugger();

      // Verify state switched back
      const disconnectedStateResult = await mcpClient.callTool("get_debugger_state");
      const disconnectedState = JSON.parse(disconnectedStateResult.content[0].text);

      expect(disconnectedState.connection.isConnected).toBeFalsy();
      expect(disconnectedState.state.state).toBe('disconnected');

      // Connection tools should be enabled again
      expect(disconnectedState.state.enabledTools).toContain('connect_default');
      expect(disconnectedState.state.enabledTools).toContain('connect_url');

      // Debugging tools should be disabled again
      expect(disconnectedState.state.disabledTools).toContain('disconnect');
      expect(disconnectedState.state.disabledTools).toContain('set_breakpoint');
    });
  });

  describe("Debugger pause state management", () => {
    it("should enable pause-dependent tools when debugger is paused", async () => {
      const { pid, port } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      await setTimeout(2000);

      // Connect to debugger
      await debuggerHelper.connectToDebugger(port);

      // Initially should be in connected state (not paused)
      const initialStateResult = await mcpClient.callTool("get_debugger_state");
      const initialState = JSON.parse(initialStateResult.content[0].text);

      expect(initialState.state.isPaused).toBeFalsy();
      expect(initialState.state.state).toBe('connected');

      // Pause the debugger using the pause tool
      const pauseResult = await mcpClient.callTool("pause");

      expect(pauseResult.isError).toBeFalsy();

      // Wait a bit for state to update
      await setTimeout(500);

      // Check state - should be in paused state
      const pausedStateResult = await mcpClient.callTool("get_debugger_state");
      const pausedState = JSON.parse(pausedStateResult.content[0].text);

      // Should be in debuggerPaused state when paused
      expect(pausedState.state.isPaused).toBeTruthy();
      expect(pausedState.state.state).toBe('debuggerPaused');

      // Pause-dependent tools should be available
      expect(pausedState.state.enabledTools).toContain('resume');
      expect(pausedState.state.enabledTools).toContain('step_over');
      expect(pausedState.state.enabledTools).toContain('step_into');
      expect(pausedState.state.enabledTools).toContain('step_out');

      // Note: Testing resume functionality requires active code execution
      // In a real debugging scenario, resume works correctly when there's actual execution to resume from
      // For testing purposes, we've verified that pause state management works correctly
    });
  });

  describe("Domain enablement state", () => {
    it("should show enabled domains in debugger state", async () => {
      const { pid, port } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      await setTimeout(2000);

      // Connect - this should auto-enable required domains
      await debuggerHelper.connectToDebugger(port);

      const stateResult = await mcpClient.callTool("get_debugger_state");
      const state = JSON.parse(stateResult.content[0].text);

      // Should show enabled domains
      expect(state.state.enabledDomains).toContain('Debugger');
      expect(state.state.enabledDomains).toContain('Runtime');
      expect(state.state.enabledDomains).toContain('Console');
    });
  });

  describe("get_debugger_state tool", () => {
    it("should return comprehensive state information", async () => {
      const stateResult = await mcpClient.callTool("get_debugger_state");

      expect(stateResult.isError).toBeFalsy();

      const state = JSON.parse(stateResult.content[0].text);

      // Should include connection info
      expect(state.connection).toBeDefined();
      expect(state.connection.isConnected).toBeDefined();

      // Should include state info
      expect(state.state).toBeDefined();
      expect(state.state.state).toBeDefined();
      expect(state.state.isPaused).toBeDefined();
      expect(state.state.enabledDomains).toBeDefined();
      expect(state.state.enabledTools).toBeDefined();
      expect(state.state.disabledTools).toBeDefined();
      expect(state.state.stateDescription).toBeDefined();

      // Should include tools availability
      expect(state.toolsAvailability).toBeDefined();
      expect(state.toolsAvailability.enabled).toBeDefined();
      expect(state.toolsAvailability.disabled).toBeDefined();
    });

    it("should be available in all states", async () => {
      // Should work when disconnected
      const disconnectedStateResult = await mcpClient.callTool("get_debugger_state");

      expect(disconnectedStateResult.isError).toBeFalsy();

      const { port } = await testApp.start({
        enableDebugger: true
      });

      await setTimeout(2000);

      // Should work when connected
      await debuggerHelper.connectToDebugger(port);
      const connectedStateResult = await mcpClient.callTool("get_debugger_state");

      expect(connectedStateResult.isError).toBeFalsy();
    });
  });

  describe("Tool list changes notification", () => {
    it("should verify tools are properly enabled/disabled based on state", async () => {
      const { pid, webSocketUrl } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(webSocketUrl).toBeDefined();
      await setTimeout(2000);

      // Before connection - connection tools should work, debugging tools should be disabled
      const connectResult = await mcpClient.callTool("connect_url", {
        url: webSocketUrl!
      });

      expect(connectResult.isError).toBeFalsy();

      // After connection - debugging tools should work, connection tools should be disabled
      const evaluateResult = await mcpClient.callTool("evaluate", {
        expression: "1 + 1"
      });

      expect(evaluateResult.isError).toBeFalsy();

      // Connection tools should now be disabled
      const connectResult2 = await mcpClient.callTool("connect_url", { url: webSocketUrl! });

      expect(connectResult2.isError).toBe(true);
      expect(connectResult2.content[0].text).toContain("disabled");
    });
  });
});
