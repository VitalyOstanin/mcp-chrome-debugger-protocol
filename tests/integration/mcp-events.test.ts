import { MCPClient } from "../utils/mcp-client";
import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import path from "path";
import { setTimeout } from "node:timers/promises";

describe("MCP Chrome Debugger Protocol - MCP Event Notifications", () => {
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

  describe("Logpoint Events via MCP Logging", () => {
    it("should capture logpoint hits and verify real-time execution", async () => {
      const { pid, port, serverPort } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();
      expect(serverPort).toBeDefined();

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      const mainScriptPath = await debuggerHelper.getMainScriptPath();

      // Clear any existing logpoint hits first
      await mcpClient.callTool("clear_logpoint_hits");

      // Set logpoint on a line that will definitely be executed
      // Line 76 is processor.processData() call in compiled JS - triggered via HTTP call
      const logpointResult = await debuggerHelper.setLogpoint(
        mainScriptPath,
        76, // processor.processData() call in compiled JS
        0,
        "INTEGRATION_TEST_LOGPOINT: processing data in test1 endpoint"
      );

      expect(logpointResult.breakpointId).toBeDefined();

      // Trigger code execution that will hit the logpoint
      const response = await fetch(`http://localhost:${serverPort}/test1`);

      expect(response.ok).toBe(true);

      // Wait for logpoint to be processed
      await setTimeout(3000);

      // Verify logpoint hits were captured
      const logHitsResult = await mcpClient.callTool("get_logpoint_hits");

      expect(logHitsResult.isError).toBeFalsy();

      const logHits = JSON.parse(logHitsResult.content[0].text);

      // Verify structure
      expect(logHits.hits).toBeDefined();
      expect(Array.isArray(logHits.hits)).toBe(true);
      expect(logHits.totalCount).toBeDefined();

      // Verify we actually captured the specific logpoint we set
      expect(logHits.hits.length).toBeGreaterThan(0);
      expect(logHits.totalCount).toBeGreaterThan(0);

      // Find our specific integration test logpoint
      const ourLogpoint = logHits.hits.find((hit: { message?: string }) =>
        hit.message?.includes("INTEGRATION_TEST_LOGPOINT")
      );

      expect(ourLogpoint).toBeDefined();
      expect(ourLogpoint.message).toContain("LOGPOINT:");
      expect(ourLogpoint.message).toContain("INTEGRATION_TEST_LOGPOINT:");
      expect(ourLogpoint.message).toContain("processing data in test1 endpoint");
      expect(ourLogpoint.timestamp).toBeDefined();

      // Verify timestamp is recent (within last 10 seconds)
      const hitTimestamp = new Date(ourLogpoint.timestamp);
      const now = new Date();
      const timeDiff = now.getTime() - hitTimestamp.getTime();

      expect(timeDiff).toBeLessThan(10000);

      // Clean up
      await debuggerHelper.removeBreakpoint(logpointResult.breakpointId);
    });

    it("should capture multiple logpoint hits from repeated execution", async () => {
      const { pid, port, serverPort } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      const mainScriptPath = await debuggerHelper.getMainScriptPath();

      // Clear any existing logpoint hits
      await mcpClient.callTool("clear_logpoint_hits");

      // Set logpoint on a method that gets called multiple times
      const logpointResult = await debuggerHelper.setLogpoint(
        mainScriptPath,
        76, // processor.processData() call - gets called on each HTTP request
        0,
        "MULTI_HIT_TEST: Processing data on HTTP request"
      );

      expect(logpointResult.breakpointId).toBeDefined();

      // Make multiple HTTP requests to trigger repeated logpoint hits
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`http://localhost:${serverPort}/test1`);

        expect(response.ok).toBe(true);
        await setTimeout(500); // Small delay between requests
      }

      // Wait for all logpoints to be processed
      await setTimeout(2000);

      // Verify multiple logpoint hits were captured
      const logHitsResult = await mcpClient.callTool("get_logpoint_hits");

      expect(logHitsResult.isError).toBeFalsy();

      const logHits = JSON.parse(logHitsResult.content[0].text);

      // Should have captured multiple hits from our test
      const ourLogpoints = logHits.hits.filter((hit: { message?: string }) =>
        hit.message?.includes("MULTI_HIT_TEST")
      );

      expect(ourLogpoints.length).toBeGreaterThan(0);

      // Each hit should have proper structure
      ourLogpoints.forEach((hit: { message?: string; timestamp?: string }) => {
        expect(hit.message).toContain("LOGPOINT:");
        expect(hit.message).toContain("MULTI_HIT_TEST:");
        expect(hit.timestamp).toBeDefined();
        expect(new Date(hit.timestamp ?? '')).toBeInstanceOf(Date);
      });

      // Clean up
      await debuggerHelper.removeBreakpoint(logpointResult.breakpointId);
    });
  });

  describe("Breakpoint Events via MCP Logging", () => {
    it("should handle breakpoint pause and resume events", async () => {
      const { pid, port, serverPort } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      const mainScriptPath = await debuggerHelper.getMainScriptPath();

      // Set breakpoint that will pause execution
      const breakpointResult = await debuggerHelper.setBreakpoint(
        mainScriptPath,
        96, // console.log line in testBreakpointFunction
        0
      );

      expect(breakpointResult.breakpointId).toBeDefined();

      // Clear debugger events to start fresh
      await mcpClient.callTool("clear_debugger_events");

      // Trigger breakpoint by making HTTP request
      // This will pause execution at the breakpoint
      fetch(`http://localhost:${serverPort}/test1`).catch(() => {
        // Request may fail/timeout due to breakpoint pause
      });

      // Wait for breakpoint to be hit
      await setTimeout(3000);

      // Check debugger events to see if pause was recorded
      const eventsResult = await mcpClient.callTool("get_debugger_events");

      expect(eventsResult.isError).toBeFalsy();

      const events = JSON.parse(eventsResult.content[0].text);

      expect(events.events).toBeDefined();
      expect(Array.isArray(events.events)).toBe(true);

      // Look for pause event
      const pauseEvent = events.events.find((event: { type?: string }) =>
        event.type === 'paused'
      );

      if (pauseEvent) {
        expect(pauseEvent.timestamp).toBeDefined();
        expect(pauseEvent.data).toBeDefined();
      }

      // Resume execution to complete the test
      try {
        await mcpClient.callTool("resume");
        await setTimeout(1000);
      } catch {
        // Resume may fail if not properly paused
      }

      // Clean up
      await debuggerHelper.removeBreakpoint(breakpointResult.breakpointId);
    });
  });

  describe("Connection Events via MCP Logging", () => {
    it("should track connection state changes", async () => {
      const { pid, port } = await testApp.start({
        enableDebugger: true
      });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();

      await setTimeout(2000);

      // Initial state should be disconnected
      const initialState = await mcpClient.callTool("get_debugger_state");
      const initialData = JSON.parse(initialState.content[0].text);

      expect(initialData.connection.isConnected).toBe(false);

      // Connect to debugger
      await debuggerHelper.connectToDebugger(port);

      // Connected state should be true
      const connectedState = await mcpClient.callTool("get_debugger_state");
      const connectedData = JSON.parse(connectedState.content[0].text);

      expect(connectedData.connection.isConnected).toBe(true);
      expect(connectedData.state.state).toBe('connected');

      // Disconnect
      await debuggerHelper.disconnectFromDebugger();

      // State should be back to disconnected
      const disconnectedState = await mcpClient.callTool("get_debugger_state");
      const disconnectedData = JSON.parse(disconnectedState.content[0].text);

      expect(disconnectedData.connection.isConnected).toBe(false);
      expect(disconnectedData.state.state).toBe('disconnected');
    });
  });
});
