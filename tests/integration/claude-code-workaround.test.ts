/**
 * Integration test verifying our workaround for Claude Code's ignored tool list change notifications
 * This test demonstrates that setBreakpoints (which handles logpoints) is always visible, solving the original issue
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

describe('Claude Code workaround verification', () => {
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

  it('should always show setBreakpoints in tool list (main issue fix)', async () => {
    // This is the core issue that was reported: debugging tools not visible in Claude Code


    // Check that setBreakpoints is immediately visible
    const allTools = await mcpClient.listTools() as Tool[];
    const toolNames = allTools.map(t => t.name);

    expect(toolNames).toContain('setBreakpoints');

    // Verify this persists across connection state changes
    const { port } = await testApp.start({ enableDebugger: true });

    await debuggerHelper.connectToDebugger(port);

    const toolsAfterConnection = await mcpClient.listTools() as Tool[];

    expect(toolsAfterConnection.map(t => t.name)).toContain('setBreakpoints');

    await mcpClient.callTool('disconnect', {});

    const toolsAfterDisconnection = await mcpClient.listTools() as Tool[];

    expect(toolsAfterDisconnection.map(t => t.name)).toContain('setBreakpoints');

  });

  it('should provide helpful error messages when tools are unavailable', async () => {
    // Test runtime validation approach


    // Try setBreakpoints without connection
    const errorResult = await mcpClient.callTool('setBreakpoints', {
      source: { path: '/test/file.js' },
      breakpoints: [{ line: 10, logMessage: 'test' }],
    });

    expect(errorResult.content[0].text).toContain('disabled');
    // Error message indicates the tool is disabled, which is the key information

  });

  it('should work correctly after connection', async () => {
    // Test that tools work properly when conditions are met


    const { port } = await testApp.start({ enableDebugger: true });

    await debuggerHelper.connectToDebugger(port);

    const logpointResult = await mcpClient.callTool('setBreakpoints', {
      source: { path: path.resolve(__dirname, '../fixtures/test-app/src/index.ts') },
      breakpoints: [{
        line: 17,
        column: 4,
        logMessage: 'Integration test logpoint: counter = {counter}',
      }],
    });
    const result = JSON.parse(logpointResult.content[0].text);

    expect(result.success).toBe(true);
  });

  it('should demonstrate the problem that was solved', async () => {
    // Show what the old behavior would look like vs new behavior



    const allTools = await mcpClient.listTools() as Tool[];
    const debuggingTools = allTools.filter(t =>
      ['setBreakpoints', 'removeBreakpoint', 'continue', 'pause', 'next', 'stepIn', 'stepOut'].includes(t.name),
    );


    expect(debuggingTools.length).toBeGreaterThan(5);
    expect(debuggingTools.some(t => t.name === 'setBreakpoints')).toBe(true);

  });

  it('should verify tool count consistency', async () => {
    // Ensure our workaround doesn't break anything else


    const initialCount = (await mcpClient.listTools()).length;
    // Connect
    const { port } = await testApp.start({ enableDebugger: true });

    await debuggerHelper.connectToDebugger(port);

    const connectedCount = (await mcpClient.listTools()).length;

    // Disconnect
    await mcpClient.callTool('disconnect', {});

    const disconnectedCount = (await mcpClient.listTools()).length;

    // All should be the same (our workaround)
    expect(connectedCount).toBe(initialCount);
    expect(disconnectedCount).toBe(initialCount);

  });

  it('should validate the specific issue mentioned in the bug report', async () => {
    // Reproduce the exact scenario from the bug report


    // Get debugger state
    const debuggerState = await mcpClient.callTool('getDebuggerState', {});
    const stateData = JSON.parse(debuggerState.content[0].text);

    expect(stateData.toolsAvailability.disabled).toContain('setBreakpoints');

    // Check tool list
    const toolList = await mcpClient.listTools() as Tool[];
    const hasSetBreakpoints = toolList.some(t => t.name === 'setBreakpoints');

    expect(hasSetBreakpoints).toBe(true);

  });
});
