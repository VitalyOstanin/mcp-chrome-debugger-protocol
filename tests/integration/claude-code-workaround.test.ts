/**
 * Integration test verifying our workaround for Claude Code's ignored tool list change notifications
 * This test demonstrates that set_logpoint is always visible, solving the original issue
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

  it('should always show set_logpoint in tool list (main issue fix)', async () => {
    // This is the core issue that was reported: set_logpoint not visible in Claude Code


    // Check that set_logpoint is immediately visible
    const allTools = await mcpClient.listTools() as Tool[];
    const toolNames = allTools.map(t => t.name);

    expect(toolNames).toContain('set_logpoint');

    // Verify this persists across connection state changes
    const { port } = await testApp.start({ enableDebugger: true });

    await debuggerHelper.connectToDebugger(port);

    const toolsAfterConnection = await mcpClient.listTools() as Tool[];

    expect(toolsAfterConnection.map(t => t.name)).toContain('set_logpoint');

    await mcpClient.callTool('disconnect', {});

    const toolsAfterDisconnection = await mcpClient.listTools() as Tool[];

    expect(toolsAfterDisconnection.map(t => t.name)).toContain('set_logpoint');

  });

  it('should provide helpful error messages when tools are unavailable', async () => {
    // Test runtime validation approach


    // Try set_logpoint without connection
    const errorResult = await mcpClient.callTool('set_logpoint', {
      filePath: '/test/file.js',
      lineNumber: 10,
      columnNumber: 0,
      logMessage: 'test'
    });

    expect(errorResult.content[0].text).toContain('not available');
    // Error message indicates the tool is disabled, which is the key information

  });

  it('should work correctly after connection', async () => {
    // Test that tools work properly when conditions are met


    const { port } = await testApp.start({ enableDebugger: true });

    await debuggerHelper.connectToDebugger(port);

    const logpointResult = await mcpClient.callTool('set_logpoint', {
      filePath: path.resolve(__dirname, '../fixtures/test-app/src/index.ts'),
      lineNumber: 17,
      columnNumber: 4,
      logMessage: 'Integration test logpoint: counter = {counter}'
    });

    expect(logpointResult.content[0].text).toContain('breakpointId');
  });

  it('should demonstrate the problem that was solved', async () => {
    // Show what the old behavior would look like vs new behavior



    const allTools = await mcpClient.listTools() as Tool[];
    const debuggingTools = allTools.filter(t =>
      ['set_breakpoint', 'set_logpoint', 'remove_breakpoint', 'resume', 'pause', 'step_over', 'step_into', 'step_out'].includes(t.name)
    );


    expect(debuggingTools.length).toBeGreaterThan(5);
    expect(debuggingTools.some(t => t.name === 'set_logpoint')).toBe(true);

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
    const debuggerState = await mcpClient.callTool('get_debugger_state', {});
    const stateData = JSON.parse(debuggerState.content[0].text);

    expect(stateData.toolsAvailability.disabled).toContain('set_logpoint');

    // Check tool list
    const toolList = await mcpClient.listTools() as Tool[];
    const hasSetLogpoint = toolList.some(t => t.name === 'set_logpoint');

    expect(hasSetLogpoint).toBe(true);

  });
});
