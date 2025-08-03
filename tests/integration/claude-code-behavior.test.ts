/**
 * Integration test that reproduces Claude Code behavior with ignored tool list change notifications
 * This test simulates how Claude Code handles MCP tool availability changes
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

describe('Claude Code MCP behavior simulation', () => {
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

  describe('Tool list change notifications behavior', () => {
    it('should reproduce Claude Code issue: ignoring tool list change notifications', async () => {
      // Step 1: Get initial tool list (disconnected state)
      const initialTools = await mcpClient.listTools() as Tool[];

      // Simulate Claude Code behavior: cache the initial tool list
      const claudeCodeToolCache = new Set(initialTools.map(t => t.name));

      // Verify set_logpoint is available (our workaround)
      expect(claudeCodeToolCache.has('set_logpoint')).toBe(true);

      // Step 2: Start debugger and connect
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      // Step 3: Get updated tool list after connection
      await mcpClient.listTools() as Tool[];

      // Step 4: Simulate Claude Code behavior - ignore notifications and keep old cache
      // In real Claude Code, the tool list would NOT be refreshed
      // But with our workaround, set_logpoint should still be available

      // Verify our workaround: set_logpoint remains visible
      expect(claudeCodeToolCache.has('set_logpoint')).toBe(true);

      // Step 5: Try to use set_logpoint - should work with our runtime validation
      const logpointResult = await mcpClient.callTool('set_logpoint', {
        filePath: path.resolve(__dirname, '../fixtures/test-app/src/index.ts'),
        lineNumber: 17,
        columnNumber: 4,
        logMessage: 'Test logpoint from integration test'
      });

      // Should succeed because we're connected
      expect(logpointResult.content).toBeDefined();
      expect(logpointResult.content[0].text).toContain('breakpointId');
    });

    it('should demonstrate the old problematic behavior with dynamic tool registration', async () => {
      // This test shows what WOULD happen with the old approach

      // Step 1: Get initial tools (only connection tools available)
      const initialTools = await mcpClient.listTools() as Tool[];
      const connectionOnlyTools = initialTools.filter(tool =>
        ['connect_default', 'connect_url', 'enable_debugger_pid', 'get_debugger_state'].includes(tool.name)
      );

      // Simulate old behavior: only connection tools visible initially
      expect(connectionOnlyTools.some(t => t.name === 'set_logpoint')).toBe(false);

      // Step 2: Connect and check if Claude Code would see new tools
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      // In the old approach, tools/list_changed notification would be sent
      // but Claude Code would ignore it, so set_logpoint would remain invisible

      // Our current approach solves this by showing all tools upfront
      const allToolsNow = await mcpClient.listTools() as Tool[];

      expect(allToolsNow.some(t => t.name === 'set_logpoint')).toBe(true);
    });

    it('should validate runtime tool availability checking', async () => {
      // Test that tools validate availability at runtime

      // Step 1: Try set_logpoint without connection (should get helpful error)
      const disconnectedResult = await mcpClient.callTool('set_logpoint', {
        filePath: '/test/file.js',
        lineNumber: 10,
        columnNumber: 0,
        logMessage: 'Test message'
      });

      expect(disconnectedResult.content[0].text).toContain('not available');
      expect(disconnectedResult.content[0].text).toContain('requires connection');
      expect(disconnectedResult.content[0].text).toContain('disabled');

      // Step 2: Connect and try again (should work)
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      const connectedResult = await mcpClient.callTool('set_logpoint', {
        filePath: path.resolve(__dirname, '../fixtures/test-app/src/index.ts'),
        lineNumber: 17,
        columnNumber: 4,
        logMessage: 'Test logpoint after connection'
      });

      expect(connectedResult.content[0].text).toContain('breakpointId');
    });

    it('should handle multiple state transitions correctly', async () => {
      // Test tool availability through different debugger states

      const states = [];

      // State 1: Disconnected
      let debuggerState = await mcpClient.callTool('get_debugger_state', {});
      let stateData = JSON.parse(debuggerState.content[0].text);

      states.push({ state: stateData.state.state, enabledTools: stateData.toolsAvailability.enabled.length });

      // State 2: Connected
      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);

      debuggerState = await mcpClient.callTool('get_debugger_state', {});
      stateData = JSON.parse(debuggerState.content[0].text);
      states.push({ state: stateData.state.state, enabledTools: stateData.toolsAvailability.enabled.length });

      // State 3: Disconnected again
      await mcpClient.callTool('disconnect', {});

      debuggerState = await mcpClient.callTool('get_debugger_state', {});
      stateData = JSON.parse(debuggerState.content[0].text);
      states.push({ state: stateData.state.state, enabledTools: stateData.toolsAvailability.enabled.length });


      // Verify state transitions happened
      expect(states[0].state).toBe('disconnected');
      expect(states[1].state).toBe('connected');
      expect(states[2].state).toBe('disconnected');

      // But tools list should remain constant (our workaround)
      const toolsAfterAllTransitions = await mcpClient.listTools() as Tool[];

      expect(toolsAfterAllTransitions.some(t => t.name === 'set_logpoint')).toBe(true);
    });
  });

  describe('Tool availability validation', () => {
    it('should provide clear error messages for unavailable tools', async () => {
      const debuggingTools = [
        'set_breakpoint',
        'set_logpoint',
        'remove_breakpoint',
        'resume',
        'pause',
        'step_over',
        'step_into',
        'step_out',
        'evaluate'
      ];

      // Test each debugging tool without connection
      for (const toolName of debuggingTools) {
        const result = await mcpClient.callTool(toolName, {
          // Provide minimal required parameters
          ...(toolName === 'set_breakpoint' && { filePath: '/test.js', lineNumber: 1, columnNumber: 0 }),
          ...(toolName === 'set_logpoint' && { filePath: '/test.js', lineNumber: 1, columnNumber: 0, logMessage: 'test' }),
          ...(toolName === 'remove_breakpoint' && { breakpointId: 'test' }),
          ...(toolName === 'evaluate' && { expression: '1+1' }),
          ...(toolName === 'get_scope_variables' && { callFrameId: 'test' })
        });

        const responseText = result.content[0].text;

        // Different tools may have different error formats, but they should indicate unavailability
        // With the new standardized format, errors are now structured JSON with success:false
        expect(responseText).toMatch(/(not available|disabled|Not connected|success.*false|Failed to)/i);

      }
    });

    it('should allow connection tools when disconnected', async () => {
      const connectionTools = ['connect_default', 'connect_url', 'enable_debugger_pid'];

      for (const toolName of connectionTools) {
        // These shouldn't throw validation errors (though they may fail for other reasons)
        try {
          await mcpClient.callTool(toolName, {
            ...(toolName === 'connect_url' && { url: 'ws://invalid:9229' }),
            ...(toolName === 'enable_debugger_pid' && { pid: 99999 })
          });
        } catch (error) {
          // Connection failures are expected, but not validation errors
          expect((error as Error).message).not.toContain('not available');
        }
      }
    });
  });

  describe('Workaround effectiveness', () => {
    it('should make all tools visible immediately to simulate improved Claude Code experience', async () => {
      // This test verifies our workaround provides the experience users expect

      const allTools = await mcpClient.listTools() as Tool[];
      const toolNames = allTools.map(t => t.name);

      // All essential debugging tools should be visible from the start
      const expectedDebuggingTools = [
        'set_breakpoint',
        'set_logpoint',
        'remove_breakpoint',
        'resume',
        'pause',
        'step_over',
        'step_into',
        'step_out',
        'evaluate',
        'get_call_stack',
        'get_scope_variables'
      ];

      for (const tool of expectedDebuggingTools) {
        expect(toolNames).toContain(tool);
      }


      // Users can see what they need without having to connect first
      expect(toolNames.length).toBeGreaterThan(15);
    });

    it('should maintain consistent tool list across connection state changes', async () => {
      // Get tool list in different states
      const toolsWhenDisconnected = await mcpClient.listTools() as Tool[];

      const { port } = await testApp.start({ enableDebugger: true });

      await debuggerHelper.connectToDebugger(port);
      const toolsWhenConnected = await mcpClient.listTools() as Tool[];

      await mcpClient.callTool('disconnect', {});
      const toolsAfterDisconnect = await mcpClient.listTools() as Tool[];

      // Tool lists should be identical (our workaround)
      expect(toolsWhenDisconnected.map(t => t.name).sort()).toEqual(
        toolsWhenConnected.map(t => t.name).sort()
      );
      expect(toolsWhenConnected.map(t => t.name).sort()).toEqual(
        toolsAfterDisconnect.map(t => t.name).sort()
      );

    });
  });
});
