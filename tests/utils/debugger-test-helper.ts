import type { MCPClient } from "./mcp-client";
import type { TestAppManager } from "./test-app-manager";

export interface ScriptInfo {
  scriptId: string;
  url: string;
  lineCount?: number;
}

export interface BreakpointInfo {
  id: number;
  verified: boolean;
  line: number;
  column?: number;
  source?: {
    name: string;
    path: string;
  };
}

interface PendingBreakpoint {
  id?: number;
  line: number;
  column?: number;
  condition?: string;
  logMessage?: string;
}

export class DebuggerTestHelper {
  // Per-source list of breakpoints we have asked the server to set. DAP setBreakpoints
  // replaces ALL breakpoints for the source, so each add/remove must re-send the full list
  // -- mirroring how real DAP clients (VS Code) work. The previous helper sent one BP at a
  // time and accidentally relied on the broken removeBreakpoint to clear the survivors.
  private readonly breakpointsBySource = new Map<string, PendingBreakpoint[]>();
  private readonly idToSource = new Map<number, string>();

  constructor(
    private readonly mcpClient: MCPClient,
    private readonly testApp: TestAppManager,
  ) {}

  private async syncBreakpointsForFile(filePath: string): Promise<BreakpointInfo[]> {
    const list = this.breakpointsBySource.get(filePath) ?? [];
    const breakpoints = list.map(bp => {
      const out: { line: number; column?: number; condition?: string; logMessage?: string } = { line: bp.line };

      if (bp.column !== undefined) out.column = bp.column;
      if (bp.condition !== undefined) out.condition = bp.condition;
      if (bp.logMessage !== undefined) out.logMessage = bp.logMessage;

      return out;
    });
    const result = await this.mcpClient.callTool("setBreakpoints", {
      source: { path: filePath },
      breakpoints,
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to set breakpoints");
    }

    try {
      const response = JSON.parse(result.content[0].text);

      if (response.error || (response.success === false)) {
        throw new Error(response.message ?? response.error);
      }

      const data = response.success ? response.data : response;
      const returned: BreakpointInfo[] = data.breakpoints ?? [];

      // Update id mapping and refresh internal state with server-assigned ids.
      for (let i = 0; i < returned.length; i++) {
        const local = list[i];
        const remote = returned[i];

        local.id = remote.id;
        this.idToSource.set(remote.id, filePath);
      }

      return returned;
    } catch (error) {
      throw new Error(`Failed to parse breakpoint response: ${error}`, { cause: error });
    }
  }

  async connectToDebugger(port?: number): Promise<void> {
    let result;

    if (port && port !== 9229) {
      // For custom ports, we need to use attach as the debugger is already running
      // on the specified port from the --inspect=port flag at startup
      // First, we need to get the WebSocket URL from the debugging target list
      try {
        const http = await import('http');
        const targetListUrl = `http://127.0.0.1:${port}/json/list`;
        // Get the debugging targets
        const response = await new Promise<string>((resolve, reject) => {
          const req = http.get(targetListUrl, (res) => {
            let data = '';

            res.on('data', (chunk) => data += chunk);
            res.on('end', () => { resolve(data); });
          });

          req.on('error', reject);
          req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
          });
        });
        const targets = JSON.parse(response);

        if (targets.length === 0) {
          throw new Error('No debugging targets found');
        }

        // Use the first available target's WebSocket URL
        const webSocketUrl = targets[0].webSocketDebuggerUrl;

        if (!webSocketUrl) {
          throw new Error('No WebSocket debugger URL found');
        }

        result = await this.mcpClient.callTool("attach", { address: "localhost", port });
      } catch (error) {
        throw new Error(`Failed to connect to debugger on port ${port}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    } else if (port === 9229) {
      // For default port, use connect_default
      result = await this.mcpClient.callTool("attach");
    } else {
      // No port specified, try default
      result = await this.mcpClient.callTool("attach");
    }

    if (result.isError || !result.content[0]) {
      throw new Error(`Failed to connect to debugger: ${result.isError ? 'isError=true' : 'no content'}`);
    }

    const responseText = result.content[0].text;

    try {
      const response = JSON.parse(responseText);

      if (response.error) {
        throw new Error(response.message ?? response.error);
      }
    } catch {
      // If response is not JSON, check if it contains error text
      if (responseText.includes("Failed to connect")) {
        throw new Error(`Failed to connect to debugger: ${responseText}`);
      }
      // If response text contains success message, connection is OK
      if (responseText.includes("Successfully connected")) {
        return; // Connection successful
      }
      // Unknown response format
      throw new Error(`Unexpected connection response: ${responseText}`);
    }
  }

  async disconnectFromDebugger(): Promise<void> {
    try {
      await this.mcpClient.callTool("disconnect");
    } catch (error) {
      // If disconnect tool is disabled, it might mean we're already disconnected
      // or in a state where disconnection is not possible
      if (error instanceof Error && error.message.includes('disabled')) {
        // Silently ignore if disconnect tool is disabled
        return;
      }
      throw error;
    }
  }

  async enableDebuggerByPid(pid: number, port?: number): Promise<void> {
    await this.mcpClient.callTool("attach", {
      processId: pid,
      port: port ?? 9229,
    });
  }

  async setBreakpoint(
    filePath: string,
    lineNumber: number,
    columnNumber: number,
    condition?: string,
  ): Promise<BreakpointInfo> {
    // MCP schema enforces 1-based columns. Older tests pass `0` to mean "any column" — translate
    // that to omitting the field, keeping the tests working without weakening server validation.
    const pending: PendingBreakpoint = { line: lineNumber, condition };

    if (columnNumber >= 1) {
      pending.column = columnNumber;
    }

    const list = this.breakpointsBySource.get(filePath) ?? [];

    list.push(pending);
    this.breakpointsBySource.set(filePath, list);

    const returned = await this.syncBreakpointsForFile(filePath);

    if (returned.length < list.length) {
      throw new Error("setBreakpoints did not return the newly added breakpoint");
    }

    return returned[list.length - 1];
  }

  async setLogpoint(
    filePath: string,
    lineNumber: number,
    columnNumber: number,
    logMessage: string,
  ): Promise<BreakpointInfo> {
    const pending: PendingBreakpoint = { line: lineNumber, logMessage };

    if (columnNumber >= 1) {
      pending.column = columnNumber;
    }

    const list = this.breakpointsBySource.get(filePath) ?? [];

    list.push(pending);
    this.breakpointsBySource.set(filePath, list);

    const returned = await this.syncBreakpointsForFile(filePath);

    if (returned.length < list.length) {
      throw new Error("setBreakpoints did not return the newly added logpoint");
    }

    return returned[list.length - 1];
  }

  async removeBreakpoint(breakpointId: number): Promise<void> {
    const result = await this.mcpClient.callTool("removeBreakpoint", {
      breakpointId,
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to remove breakpoint");
    }

    try {
      const response = JSON.parse(result.content[0].text);

      if (response.error || (response.success === false)) {
        throw new Error(response.message ?? response.error);
      }
    } catch (error) {
      throw new Error(`Failed to parse remove breakpoint response: ${error}`, { cause: error });
    }

    // Drop from the helper's per-source list so subsequent setBreakpoint calls don't
    // re-send the removed breakpoint.
    const filePath = this.idToSource.get(breakpointId);

    if (filePath) {
      this.idToSource.delete(breakpointId);

      const list = this.breakpointsBySource.get(filePath);

      if (list) {
        const idx = list.findIndex(bp => bp.id === breakpointId);

        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.breakpointsBySource.delete(filePath);
      }
    }
  }

  async resume(): Promise<void> {
    await this.mcpClient.callTool("continue");
  }

  async pause(): Promise<void> {
    await this.mcpClient.callTool("pause");
  }

  async stepOver(): Promise<void> {
    await this.mcpClient.callTool("next");
  }

  async stepInto(): Promise<void> {
    await this.mcpClient.callTool("stepIn");
  }

  async stepOut(): Promise<void> {
    await this.mcpClient.callTool("stepOut");
  }

  async evaluate(expression: string, frameId?: number): Promise<{ value: unknown; type: string; className?: string }> {
    const result = await this.mcpClient.callTool("evaluate", {
      expression,
      frameId,
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to evaluate expression");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse evaluation result: ${error}`, { cause: error });
    }
  }

  async getCallStack(): Promise<Array<{ id: number; name: string; line: number; column?: number; source?: { path?: string } }>> {
    const result = await this.mcpClient.callTool("stackTrace");

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get call stack");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse call stack: ${error}`, { cause: error });
    }
  }

  async getScopeVariables(variablesReference: number): Promise<Array<{ name: string; value: string; type?: string; variablesReference: number }>> {
    const result = await this.mcpClient.callTool("variables", {
      variablesReference,
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get scope variables");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse scope variables: ${error}`, { cause: error });
    }
  }

  async waitForPause(timeout: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkPause = async () => {
        if (Date.now() - startTime > timeout) {
          reject(new Error("Timeout waiting for pause"));

          return;
        }

        try {
          const callStack = await this.getCallStack();

          if (callStack.length > 0) {
            resolve();

            return;
          }
        } catch {
          // Continue checking
        }

        setTimeout(checkPause, 100);
      };

      checkPause();
    });
  }

  async triggerTestSignal(): Promise<void> {
    await this.testApp.sendSignal("SIGUSR2");
  }

  async getLogpointHits(): Promise<Array<{ timestamp: number; message: string; level: string }>> {
    const result = await this.mcpClient.callTool("getLogpointHits");

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get logpoint hits");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse logpoint hits: ${error}`, { cause: error });
    }
  }

  async clearLogpointHits(): Promise<void> {
    await this.mcpClient.callTool("clearLogpointHits");
  }

  async getDebuggerEvents(): Promise<Array<{ timestamp: string; type: string; data: unknown }>> {
    const result = await this.mcpClient.callTool("getDebuggerEvents");

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get debugger events");
    }

    try {
      const response = JSON.parse(result.content[0].text);

      return response.events ?? [];
    } catch (error) {
      throw new Error(`Failed to parse debugger events: ${error}`, { cause: error });
    }
  }

  async clearDebuggerEvents(): Promise<void> {
    const result = await this.mcpClient.callTool("clearDebuggerEvents");

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to clear debugger events");
    }
  }

  async getMainScriptPath(): Promise<string> {
    // Get the main file path from the test app manager
    const mainFilePath = this.testApp.getMainFilePath();
    // Check if file exists
    const fs = await import("fs");

    if (!fs.existsSync(mainFilePath)) {
      throw new Error(`Main test script not found at: ${mainFilePath}`);
    }

    return mainFilePath;
  }
}
