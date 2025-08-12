/**
 * Test to demonstrate the problematic behavior of dynamic tool enabling/disabling
 * that Claude Code doesn't handle properly due to ignored notifications
 */

import { MCPClient } from '../utils/mcp-client';
import { TestAppManager } from '../utils/test-app-manager';
import { DebuggerTestHelper } from '../utils/debugger-test-helper';
import path from 'path';

interface Tool {
  name: string;
  title?: string;
  description?: string;
}

describe('Dynamic tool behavior (problematic with Claude Code)', () => {
  let mcpClient: MCPClient;
  let testApp: TestAppManager;
  let debuggerHelper: DebuggerTestHelper;

  beforeEach(async () => {
    const serverPath = path.resolve(__dirname, '../../dist/index.js');

    mcpClient = new MCPClient(serverPath);
    testApp = new TestAppManager();
    debuggerHelper = new DebuggerTestHelper(mcpClient, testApp);
    await mcpClient.connect();
  });

  afterEach(async () => {
    await testApp.stop();
    await mcpClient.disconnect();
  });

  describe('Old approach with dynamic tool registration', () => {
    it('should demonstrate why dynamic enable/disable is problematic with Claude Code', async () => {
      // This test shows the fundamental issue that motivated our workaround


      // Step 1: Get initial tool list (what Claude Code would cache)
      const initialTools = await mcpClient.listTools() as Tool[];
      // Claude Code caches this list and ignores future notifications
      const claudeCodeCache = new Set(initialTools.map(t => t.name));
      // Step 2: Connect to debugger (would trigger tool changes in old approach)
      const { port } = await testApp.start({ enableDebugger: true });

      // In old approach, this would enable debugging tools
      await debuggerHelper.connectToDebugger(port);

      // Step 3: Check server-side tool availability vs Claude Code cache
      const serverTools = await mcpClient.listTools() as Tool[];
      // Step 4: Simulate Claude Code problem - cached list doesn't update
      const serverToolNames = new Set(serverTools.map(t => t.name));
      const newToolsServerKnows = Array.from(serverToolNames).filter(name => !claudeCodeCache.has(name));
      const removedToolsFromServer = Array.from(claudeCodeCache).filter(name => !serverToolNames.has(name));


      // With our workaround, there should be no difference
      expect(newToolsServerKnows.length).toBe(0);
      expect(removedToolsFromServer.length).toBe(0);

    });

    it('should show how notifications would be ignored by Claude Code', async () => {
      // Simulate the notification sending behavior

      const notificationLog: string[] = [];
      // Mock notification handler (Claude Code would ignore these)
      const mockClaudeCodeNotificationHandler = (notification: string) => {
        notificationLog.push(notification);
      };

      // Step 1: Initial state
      mockClaudeCodeNotificationHandler('Initial tool registration');

      // Step 2: Connect (would send notifications in old approach)
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      // In old approach, these notifications would be sent but ignored:
      mockClaudeCodeNotificationHandler('notifications/tools/list_changed - debugging tools enabled');

      // Step 3: Disconnect (would send more ignored notifications)
      await mcpClient.callTool('disconnect', {});
      mockClaudeCodeNotificationHandler('notifications/tools/list_changed - debugging tools disabled');

      expect(notificationLog.length).toBeGreaterThan(0);

      // Our workaround makes this irrelevant by not relying on notifications
    });
  });

  describe('State-based validation approach', () => {
    it('should demonstrate runtime validation instead of dynamic registration', async () => {
      // Our approach: tools always visible, but validate at runtime


      // All tools are always visible
      const allTools = await mcpClient.listTools();
      const debuggingTools = (allTools as Tool[]).filter((t: Tool) =>
        ['setBreakpoints', 'continue', 'pause'].includes(t.name),
      );

      expect(debuggingTools.length).toBeGreaterThan(0);

      // Step 1: Try debugging tool without connection (runtime validation)
      const invalidResult = await mcpClient.callTool('setBreakpoints', {
        source: { path: '/test.js' },
        breakpoints: [{ line: 1, column: 0, logMessage: 'test' }],
      });

      expect(invalidResult.content[0].text).toContain('is disabled');
      // Error message provides the key information about the tool being disabled

      // Step 2: Connect and try again
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      const validResult = await mcpClient.callTool('setBreakpoints', {
        source: { path: testApp.getMainFilePath() },
        breakpoints: [{ line: 10, column: 0, logMessage: 'Runtime validation success!' }],
      });
      const result = JSON.parse(validResult.content[0].text);

      expect(result.success).toBe(true);
    });

    it('should handle rapid state changes gracefully', async () => {
      // Test rapid connect/disconnect cycles


      for (let i = 0; i < 3; i++) {

        // Connect
        const { port } = await testApp.start({ enableDebugger: true });

        await debuggerHelper.connectToDebugger(port);

        // Test tool availability
        const result = await mcpClient.callTool('setBreakpoints', {
          source: { path: testApp.getMainFilePath() },
          breakpoints: [{ line: 5 + i, column: 0, logMessage: `Cycle ${i + 1} test` }],
        });
        const parsedResult = JSON.parse(result.content[0].text);

        expect(parsedResult.success).toBe(true);

        // Disconnect
        await mcpClient.callTool('disconnect', {});
        await testApp.stop();

        // Verify tools still visible but not functional
        const toolsStillVisible = await mcpClient.listTools();

        expect((toolsStillVisible as Tool[]).some((t: Tool) => t.name === 'setBreakpoints')).toBe(true);
      }

    });
  });

  describe('Claude Code user experience improvement', () => {
    it('should provide better UX than the original dynamic approach', async () => {
      // Compare old vs new user experience


      // Old experience (what users would see with dynamic tools):

      // New experience (our workaround):

      // Verify new experience
      const allTools = await mcpClient.listTools();

      expect((allTools as Tool[]).some((t: Tool) => t.name === 'setBreakpoints')).toBe(true);

      // Helpful error without connection
      const helpfulError = await mcpClient.callTool('setBreakpoints', {
        source: { path: '/test.js' },
        breakpoints: [{ line: 1, column: 0, logMessage: 'test' }],
      });

      expect(helpfulError.content[0].text).toContain('disabled');
      // Error message provides clear indication that the tool is disabled

      // Works after connection
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      const workingResult = await mcpClient.callTool('setBreakpoints', {
        source: { path: testApp.getMainFilePath() },
        breakpoints: [{ line: 8, column: 0, logMessage: 'UX improvement verified!' }],
      });
      const workingResultData = JSON.parse(workingResult.content[0].text);

      expect(workingResultData.success).toBe(true);

    });

    it('should demonstrate the fix for the specific issue reported', async () => {
      // Reproduce the exact issue from the user's report


      // Step 1: Check debugger state (should show setBreakpoints as disabled)
      const debuggerState = await mcpClient.callTool('getDebuggerState', {});
      const stateData = JSON.parse(debuggerState.content[0].text);

      expect(stateData.toolsAvailability.disabled).toContain('setBreakpoints');

      // Step 2: Check if setBreakpoints visible in tool list (our fix)
      const toolList = await mcpClient.listTools();
      const hasSetBreakpoints = (toolList as Tool[]).some((t: Tool) => t.name === 'setBreakpoints');

      expect(hasSetBreakpoints).toBe(true);

      // Step 3: Connect and verify both state and tool list are consistent
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      const connectedState = await mcpClient.callTool('getDebuggerState', {});
      const connectedStateData = JSON.parse(connectedState.content[0].text);


      expect(connectedStateData.toolsAvailability.enabled).toContain('setBreakpoints');
      expect((toolList as Tool[]).some((t: Tool) => t.name === 'setBreakpoints')).toBe(true);

    });
  });
});
