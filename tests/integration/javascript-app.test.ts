import { MCPClient } from "../utils/mcp-client";
import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import path from "path";
import { setTimeout } from "node:timers/promises";

describe("MCP Chrome Debugger Protocol - JavaScript App Tests", () => {
  let mcpClient: MCPClient;
  let testApp: TestAppManager;
  let debuggerHelper: DebuggerTestHelper;
  const serverPath = path.resolve(__dirname, "../../dist/index.js");

  beforeEach(async () => {
    mcpClient = new MCPClient(serverPath);
    testApp = new TestAppManager('javascript');
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

    await setTimeout(100);
  });

  describe("JavaScript App Basic Functionality", () => {
    it("should start JavaScript test app successfully", async () => {
      const { pid, port, serverPort } = await testApp.start({
        enableDebugger: true,
        appType: 'javascript'
      });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();
      expect(serverPort).toBeDefined();

      // Verify the app path is pointing to JavaScript version
      const mainFilePath = testApp.getMainFilePath();

      expect(mainFilePath).toContain('test-app-js');
      expect(mainFilePath).toContain('src/index.js');
    });

    it("should connect to JavaScript app debugger", async () => {
      const { pid, port } = await testApp.start({
        enableDebugger: true,
        appType: 'javascript'
      });

      expect(pid).toBeDefined();
      expect(port).toBeDefined();

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      // Verify connection by trying to get call stack (this will succeed if connected)
      try {
        await debuggerHelper.getCallStack();
        // If we get here without error, we're connected
        expect(true).toBe(true);
      } catch {
        throw new Error("Failed to connect to debugger");
      }
    });

    it("should set breakpoint in JavaScript code without source maps", async () => {
      const { port } = await testApp.start({
        enableDebugger: true,
        appType: 'javascript'
      });

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      const mainScriptPath = await debuggerHelper.getMainScriptPath();

      expect(mainScriptPath).toBeDefined();

      // Set breakpoint in the testBreakpointFunction (around line 70 in JS version)
      const breakpointResult = await debuggerHelper.setBreakpoint(
        mainScriptPath,
        75, // Approximate line number for testBreakpointFunction
        0
      );

      expect(breakpointResult.breakpointId).toBeDefined();
      expect(breakpointResult.actualLocation).toBeDefined();

      // Verify no source map resolution was used for JavaScript app
      if (breakpointResult.sourceMapResolution) {
        expect(breakpointResult.sourceMapResolution.used).toBe(false);
      }
    });

    it("should set logpoint in JavaScript code", async () => {
      const { port } = await testApp.start({
        enableDebugger: true,
        appType: 'javascript'
      });

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      const mainScriptPath = await debuggerHelper.getMainScriptPath();

      // Set logpoint in the addData method (around line 15)
      const logpointResult = await debuggerHelper.setLogpoint(
        mainScriptPath,
        15,
        0,
        "Adding data item: {name}, {value}"
      );

      expect(logpointResult.breakpointId).toBeDefined();
      expect(logpointResult.actualLocation).toBeDefined();
    });

    it("should evaluate expressions in JavaScript context", async () => {
      const { port } = await testApp.start({
        enableDebugger: true,
        appType: 'javascript'
      });

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      // Test basic expression evaluation
      const result = await debuggerHelper.evaluate("2 + 2");

      expect(result).toBeDefined();
      // Check if the evaluation was successful (the exact format might vary)
      expect(typeof result).toBe("object");
    });

    it("should handle HTTP requests to JavaScript app", async () => {
      const { pid, serverPort } = await testApp.start({
        enableDebugger: false,
        appType: 'javascript'
      });

      expect(pid).toBeDefined();
      expect(serverPort).toBeDefined();

      // Wait for server to be ready
      await setTimeout(1000);

      // Make a request to the health endpoint
      const response = await fetch(`http://localhost:${serverPort}/health`);

      expect(response.ok).toBe(true);

      const healthData = await response.json() as { status: string; pid: number };

      expect(healthData.status).toBe("ok");
      expect(healthData.pid).toBe(pid);
    });
  });

  describe("JavaScript vs TypeScript Comparison", () => {
    it("should demonstrate difference in file paths between JS and TS apps", async () => {
      // Test JavaScript app
      const jsApp = new TestAppManager('javascript');
      const jsPath = jsApp.getMainFilePath();

      expect(jsPath).toContain('test-app-js');
      expect(jsPath).toContain('src/index.js');

      // Test TypeScript app
      const tsApp = new TestAppManager('typescript');
      const tsPath = tsApp.getMainFilePath();

      expect(tsPath).toContain('test-app');
      expect(tsPath).toContain('dist/index.js');

      // Verify they're different
      expect(jsPath).not.toBe(tsPath);
    });

    it("should handle breakpoints differently without source maps", async () => {
      const { port } = await testApp.start({
        enableDebugger: true,
        appType: 'javascript'
      });

      await setTimeout(2000);
      await debuggerHelper.connectToDebugger(port);

      const mainScriptPath = await debuggerHelper.getMainScriptPath();

      // Set multiple breakpoints to test JavaScript debugging
      const breakpoint1 = await debuggerHelper.setBreakpoint(mainScriptPath, 75, 0); // testBreakpointFunction
      const breakpoint2 = await debuggerHelper.setBreakpoint(mainScriptPath, 65, 0); // fibonacci function

      expect(breakpoint1.breakpointId).toBeDefined();
      expect(breakpoint2.breakpointId).toBeDefined();

      // Both breakpoints should have different IDs
      expect(breakpoint1.breakpointId).not.toBe(breakpoint2.breakpointId);
    });
  });
});
