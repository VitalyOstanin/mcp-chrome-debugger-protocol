import { MCPClient } from "./mcp-client";
import { TestAppManager } from "./test-app-manager";

export interface ScriptInfo {
  scriptId: string;
  url: string;
  lineCount?: number;
}

export interface BreakpointInfo {
  breakpointId: string;
  actualLocation: {
    scriptId: string;
    lineNumber: number;
    columnNumber?: number;
  };
  originalRequest: {
    filePath: string;
    lineNumber: number;
    columnNumber?: number;
    condition?: string;
    logMessage?: string;
  };
  sourceMapResolution: {
    used: boolean;
    sourceMapFile?: string;
    matchedSource?: string;
    targetFile?: string;
    targetLocation?: {
      lineNumber: number;
      columnNumber: number;
    };
    reason?: string;
  };
}

export class DebuggerTestHelper {
  constructor(
    private mcpClient: MCPClient,
    private testApp: TestAppManager
  ) {}

  async connectToDebugger(port?: number): Promise<void> {
    let result;

    if (port && port !== 9229) {
      // For custom ports, we need to use connect_url as the debugger is already running
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
            res.on('end', () => resolve(data));
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

        result = await this.mcpClient.callTool("connect_url", { url: webSocketUrl });
      } catch (error) {
        throw new Error(`Failed to connect to debugger on port ${port}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (port === 9229) {
      // For default port, use connect_default
      result = await this.mcpClient.callTool("connect_default");
    } else {
      // No port specified, try default
      result = await this.mcpClient.callTool("connect_default");
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
    await this.mcpClient.callTool("enable_debugger_pid", {
      pid,
      port: port ?? 9229
    });
  }

  async setBreakpoint(
    filePath: string,
    lineNumber: number,
    columnNumber: number,
    condition?: string
  ): Promise<BreakpointInfo> {
    const result = await this.mcpClient.callTool("set_breakpoint", {
      filePath,
      lineNumber,
      columnNumber,
      condition,
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to set breakpoint");
    }

    try {
      const response = JSON.parse(result.content[0].text);

      // Check if response contains an error (old format) or is a failed response (new format)
      if (response.error || (response.success === false)) {
        throw new Error(response.message ?? response.error);
      }

      // Handle new standardized response format
      const breakpointData = response.success ? response.data : response;

      const { breakpointId, actualLocation, originalRequest, sourceMapResolution } = breakpointData as {
        breakpointId: string;
        actualLocation: { scriptId: string; lineNumber: number; columnNumber?: number };
        originalRequest: { filePath: string; lineNumber: number; columnNumber?: number; condition?: string };
        sourceMapResolution: { used: boolean; [key: string]: unknown };
      };

      return {
        breakpointId,
        actualLocation,
        originalRequest,
        sourceMapResolution,
      };
    } catch (error) {
      throw new Error(`Failed to parse breakpoint response: ${error}`);
    }
  }

  async setLogpoint(
    filePath: string,
    lineNumber: number,
    columnNumber: number,
    logMessage: string
  ): Promise<BreakpointInfo> {
    const result = await this.mcpClient.callTool("set_logpoint", {
      filePath,
      lineNumber,
      columnNumber,
      logMessage,
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to set logpoint");
    }

    try {
      const response = JSON.parse(result.content[0].text);

      // Check if response contains an error (old format) or is a failed response (new format)
      if (response.error || (response.success === false)) {
        throw new Error(response.message ?? response.error);
      }

      // Handle new standardized response format
      const logpointData = response.success ? response.data : response;

      const { breakpointId, actualLocation, originalRequest, sourceMapResolution } = logpointData as {
        breakpointId: string;
        actualLocation: { scriptId: string; lineNumber: number; columnNumber?: number };
        originalRequest: { filePath: string; lineNumber: number; columnNumber?: number; logMessage?: string };
        sourceMapResolution: { used: boolean; [key: string]: unknown };
      };

      return {
        breakpointId,
        actualLocation,
        originalRequest,
        sourceMapResolution,
      };
    } catch (error) {
      throw new Error(`Failed to parse logpoint response: ${error}`);
    }
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    const result = await this.mcpClient.callTool("remove_breakpoint", {
      breakpointId
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to remove breakpoint");
    }

    try {
      const response = JSON.parse(result.content[0].text);

      // Check if response contains an error
      if (response.error) {
        throw new Error(response.message ?? response.error);
      }
    } catch (error) {
      throw new Error(`Failed to parse remove breakpoint response: ${error}`);
    }
  }

  async resume(): Promise<void> {
    await this.mcpClient.callTool("resume");
  }

  async pause(): Promise<void> {
    await this.mcpClient.callTool("pause");
  }

  async stepOver(): Promise<void> {
    await this.mcpClient.callTool("step_over");
  }

  async stepInto(): Promise<void> {
    await this.mcpClient.callTool("step_into");
  }

  async stepOut(): Promise<void> {
    await this.mcpClient.callTool("step_out");
  }

  async evaluate(expression: string, callFrameId?: string): Promise<{ value: unknown; type: string; className?: string }> {
    const result = await this.mcpClient.callTool("evaluate", {
      expression,
      callFrameId,
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to evaluate expression");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse evaluation result: ${error}`);
    }
  }

  async getCallStack(): Promise<Array<{ callFrameId: string; functionName?: string; location: { scriptId: string; lineNumber: number; columnNumber?: number } }>> {
    const result = await this.mcpClient.callTool("get_call_stack");

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get call stack");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse call stack: ${error}`);
    }
  }

  async getScopeVariables(callFrameId: string): Promise<Array<{ name: string; value: { type: string; value?: unknown }; scope?: { type: string } }>> {
    const result = await this.mcpClient.callTool("get_scope_variables", {
      callFrameId
    });

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get scope variables");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse scope variables: ${error}`);
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

          if (callStack && callStack.length > 0) {
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
    const result = await this.mcpClient.callTool("get_logpoint_hits");

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get logpoint hits");
    }

    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`Failed to parse logpoint hits: ${error}`);
    }
  }

  async clearLogpointHits(): Promise<void> {
    await this.mcpClient.callTool("clear_logpoint_hits");
  }

  async getDebuggerEvents(): Promise<Array<{ timestamp: string; type: string; data: unknown }>> {
    const result = await this.mcpClient.callTool("get_debugger_events");

    if (result.isError || !result.content[0]) {
      throw new Error("Failed to get debugger events");
    }

    try {
      const response = JSON.parse(result.content[0].text);

      return response.events ?? [];
    } catch (error) {
      throw new Error(`Failed to parse debugger events: ${error}`);
    }
  }

  async clearDebuggerEvents(): Promise<void> {
    const result = await this.mcpClient.callTool("clear_debugger_events");

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
