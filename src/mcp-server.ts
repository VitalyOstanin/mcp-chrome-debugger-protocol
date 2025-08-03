import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CDPClient } from "./cdp-client.js";
import { DebuggerManager } from "./debugger-manager.js";
import { ToolStateManager } from "./tool-state-manager.js";
// import { ERROR_MESSAGES, createErrorResponse } from "./utils.js";

type ToolCategory = 'connection' | 'disconnection' | 'debugging' | 'inspection' | 'data';

interface CategorizedTool {
  tool: RegisteredTool;
  category: ToolCategory;
}

export class NodeDebuggerMCPServer {
  private server: McpServer;
  private cdpClient: CDPClient;
  private debuggerManager: DebuggerManager;
  private toolStateManager: ToolStateManager;
  private tools: Map<string, CategorizedTool> = new Map();


  private fixContentTypes(result: { content?: Array<{ type: string; text: string; [key: string]: unknown }> }) {
    return {
      ...result,
      content:
        result.content?.map((item) => ({
          ...item,
          type: "text" as const,
          text: item.text,
        })) ?? [],
    };
  }

  private validateToolAvailability(toolName: string): { isEnabled: boolean; reason?: string } {
    const toolState = this.toolStateManager.getToolState(toolName);

    return {
      isEnabled: toolState.isEnabled,
      reason: toolState.reason
    };
  }

  private createToolUnavailableError(toolName: string, reason: string): never {
    const errorMessage = `Tool "${toolName}" is disabled: ${reason}`;

    throw new Error(errorMessage);
  }

  // Method to send breakpoint notifications to MCP client
  private sendBreakpointNotification(type: 'breakpoint_set' | 'breakpoint_removed' | 'logpoint_set', data: Record<string, unknown>): void {
    this.server.server.sendLoggingMessage({
      level: 'info',
      logger: 'debugger-breakpoints',
      data: {
        type,
        timestamp: new Date().toISOString(),
        ...data
      }
    }).catch((error: unknown) => {
      console.error(`Failed to send ${type} notification:`, error);
    });
  }

  constructor() {
    this.server = new McpServer(
      {
        name: "@vitalyostanin/mcp-chrome-debugger-protocol",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
          logging: {},
        },
        // Enable debouncing for tool list change notifications
        debouncedNotificationMethods: ['notifications/tools/list_changed'],
      }
    );

    this.cdpClient = new CDPClient();
    this.debuggerManager = new DebuggerManager(this.cdpClient);
    this.toolStateManager = new ToolStateManager();

    this.setupEventLogging();
    this.setupStateManagement();

    // Register ALL tools upfront to work around Claude Code issue with tool list notifications
    // Tools will validate their availability at runtime
    this.setupConnectionTools();
    this.registerDebuggingTools();
  }

  private setupEventLogging() {
    // Forward logpoint hits to MCP client
    this.cdpClient.on('logpointHit', (logpointHit) => {
      this.server.server.sendLoggingMessage({
        level: 'info',
        logger: 'debugger-logpoint',
        data: {
          type: 'logpoint_hit',
          message: logpointHit.message,
          timestamp: logpointHit.timestamp.toISOString(),
          executionContextId: logpointHit.executionContextId,
          stackTrace: logpointHit.stackTrace
        }
      }).catch((error: unknown) => {
        console.error('Failed to send logpoint hit notification:', error);
      });
    });

    // Forward debugger pause events to MCP client
    this.cdpClient.on('debuggerPaused', (debuggerEvent) => {
      this.server.server.sendLoggingMessage({
        level: 'notice',
        logger: 'debugger-events',
        data: {
          type: 'debugger_paused',
          timestamp: debuggerEvent.timestamp.toISOString(),
          data: debuggerEvent.data
        }
      }).catch((error: unknown) => {
        console.error('Failed to send debugger paused notification:', error);
      });
    });

    // Forward debugger resume events to MCP client
    this.cdpClient.on('debuggerResumed', (debuggerEvent) => {
      this.server.server.sendLoggingMessage({
        level: 'notice',
        logger: 'debugger-events',
        data: {
          type: 'debugger_resumed',
          timestamp: debuggerEvent.timestamp.toISOString(),
          data: debuggerEvent.data
        }
      }).catch((error: unknown) => {
        console.error('Failed to send debugger resumed notification:', error);
      });
    });

    // Forward connection state changes to MCP client
    this.cdpClient.onStateChange((connected) => {
      this.server.server.sendLoggingMessage({
        level: 'info',
        logger: 'debugger-connection',
        data: {
          type: 'connection_changed',
          connected,
          timestamp: new Date().toISOString()
        }
      }).catch((error: unknown) => {
        console.error('Failed to send connection state notification:', error);
      });
    });
  }

  private setupStateManagement() {
    // Listen for state changes and update tool availability
    this.toolStateManager.onStateChange(() => {
      this.updateToolsAvailability();
    });

    // Listen for CDP events to update state
    this.cdpClient.onStateChange((connected: boolean) => {
      this.toolStateManager.setConnection(connected);

      if (connected) {
        // Auto-enable required domains for debugging
        this.toolStateManager.enableDomain('Debugger');
        this.toolStateManager.enableDomain('Runtime');
        this.toolStateManager.enableDomain('Console');

        // Force update tools availability after enabling domains
        this.updateToolsAvailability();
      }
    });

    // Listen for debugger pause/resume events
    this.cdpClient.onDebuggerPause(() => {
      this.toolStateManager.setPaused(true);
    });

    this.cdpClient.onDebuggerResume(() => {
      this.toolStateManager.setPaused(false);
    });
  }

  // Removed requireConnection method as tools are now dynamically enabled/disabled

  private setupConnectionTools() {
    // Connection tools - available when NOT connected
    const connectDefaultTool = this.server.registerTool(
      "connect_default",
      {
        title: "Connect to Default Port",
        description: "Connect to Node.js debugger on default port 9229",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("connect_default");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("connect_default", availability.reason!);
        }

        const result = await this.cdpClient.connectDefault();

        return this.fixContentTypes(result);
      }
    );

    this.tools.set("connect_default", { tool: connectDefaultTool, category: 'connection' });

    const connectUrlTool = this.server.registerTool(
      "connect_url",
      {
        title: "Connect to WebSocket URL",
        description: "Connect to Node.js debugger by WebSocket URL",
        inputSchema: {
          url: z.string().describe("WebSocket URL for debugger connection"),
        },
      },
      async ({ url }) => {
        const availability = this.validateToolAvailability("connect_url");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("connect_url", availability.reason!);
        }

        const result = await this.cdpClient.connectUrl(url);

        return this.fixContentTypes(result);
      }
    );

    this.tools.set("connect_url", { tool: connectUrlTool, category: 'connection' });

    const enableDebuggerPidTool = this.server.registerTool(
      "enable_debugger_pid",
      {
        title: "Enable Debugger by PID",
        description: "Enable debugger for Node.js process by PID using SIGUSR1",
        inputSchema: {
          pid: z.number().describe("Process ID of Node.js process"),
          port: z.number().optional().default(9229).describe("Port to use for debugger (default: 9229)"),
        },
      },
      async ({ pid, port = 9229 }) => {
        const availability = this.validateToolAvailability("enable_debugger_pid");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("enable_debugger_pid", availability.reason!);
        }

        const result = await this.cdpClient.enableDebuggerPid(pid, port);

        return this.fixContentTypes(result);
      }
    );

    this.tools.set("enable_debugger_pid", { tool: enableDebuggerPidTool, category: 'connection' });

    // Disconnection tool - available when connected
    const disconnectTool = this.server.registerTool(
      "disconnect",
      {
        title: "Disconnect",
        description: "Disconnect from current debugger session",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("disconnect");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("disconnect", availability.reason!);
        }

        const result = await this.disconnect();

        return this.fixContentTypes(result);
      }
    );

    this.tools.set("disconnect", { tool: disconnectTool, category: 'disconnection' });
  }

  private registerDebuggingTools() {
    // Register all debugging tools but they will be enabled/disabled based on connection state

    // Breakpoint management tools
    const setBreakpointTool = this.server.registerTool(
      "set_breakpoint",
      {
        title: "Set Breakpoint",
        description: "Set a breakpoint in the code with optional condition",
        inputSchema: {
          filePath: z.string().describe("Absolute file path (will be converted to relative path from project root)"),
          lineNumber: z.number().describe("Line number for breakpoint"),
          columnNumber: z.number().describe("Column number for breakpoint (CRITICAL: must be exact/correct column number for reliable source map resolution)"),
          condition: z.string().optional().describe("Conditional expression for breakpoint (optional)"),
        },
      },
      async ({ filePath, lineNumber, columnNumber, condition }) => {
        const availability = this.validateToolAvailability("set_breakpoint");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("set_breakpoint", availability.reason!);
        }

        const result = await this.debuggerManager.setBreakpoint(filePath, lineNumber, columnNumber, condition);

        // Send notification about breakpoint creation
        // Extract breakpointId from the response (it's JSON-serialized in content[0].text)
        try {
          const parsedResult = JSON.parse(result.content[0].text);

          if (parsedResult.success && parsedResult.data?.breakpointId) {
            this.sendBreakpointNotification('breakpoint_set', {
              filePath,
              lineNumber,
              columnNumber,
              condition,
              breakpointId: parsedResult.data.breakpointId
            });
          }
        } catch {
          // If parsing fails, still send notification without breakpointId
          this.sendBreakpointNotification('breakpoint_set', {
            filePath,
            lineNumber,
            columnNumber,
            condition
          });
        }

        return this.fixContentTypes(result);
      }
    );

    this.tools.set("set_breakpoint", { tool: setBreakpointTool, category: 'debugging' });

    const setLogpointTool = this.server.registerTool(
      "set_logpoint",
      {
        title: "Set Logpoint",
        description: "Set a logpoint that logs a message without stopping execution",
        inputSchema: {
          filePath: z.string().describe("Absolute file path (will be converted to relative path from project root)"),
          lineNumber: z.number().describe("Line number for logpoint"),
          columnNumber: z.number().describe("Column number for logpoint (CRITICAL: must be exact/correct column number for reliable source map resolution)"),
          logMessage: z.string().describe("Message to log (can include expressions in {})"),
        },
      },
      async ({ filePath, lineNumber, columnNumber, logMessage }) => {
        const availability = this.validateToolAvailability("set_logpoint");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("set_logpoint", availability.reason!);
        }

        const result = await this.debuggerManager.setLogpoint(filePath, lineNumber, columnNumber, logMessage);

        // Send notification about logpoint creation
        // Extract breakpointId from the response (it's JSON-serialized in content[0].text)
        try {
          const parsedResult = JSON.parse(result.content[0].text);

          if (parsedResult.success && parsedResult.data?.breakpointId) {
            this.sendBreakpointNotification('logpoint_set', {
              filePath,
              lineNumber,
              columnNumber,
              logMessage,
              breakpointId: parsedResult.data.breakpointId
            });
          }
        } catch {
          // If parsing fails, still send notification without breakpointId
          this.sendBreakpointNotification('logpoint_set', {
            filePath,
            lineNumber,
            columnNumber,
            logMessage
          });
        }

        return this.fixContentTypes(result);
      }
    );

    this.tools.set("set_logpoint", { tool: setLogpointTool, category: 'debugging' });

    const removeBreakpointTool = this.server.registerTool(
      "remove_breakpoint",
      {
        title: "Remove Breakpoint",
        description: "Remove a breakpoint",
        inputSchema: {
          breakpointId: z.string().describe("Breakpoint ID to remove"),
        },
      },
      async ({ breakpointId }) => {
        const result = await this.debuggerManager.removeBreakpoint(breakpointId);

        // Send notification about breakpoint removal
        this.sendBreakpointNotification('breakpoint_removed', {
          breakpointId
        });

        return this.fixContentTypes(result);
      }
    );

    this.tools.set("remove_breakpoint", { tool: removeBreakpointTool, category: 'debugging' });

    const listBreakpointsTool = this.server.registerTool(
      "list_breakpoints",
      {
        title: "List Breakpoints",
        description: "List all active breakpoints and logpoints with source code context",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("list_breakpoints");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("list_breakpoints", availability.reason!);
        }

        return this.fixContentTypes(await this.debuggerManager.listBreakpoints());
      }
    );

    this.tools.set("list_breakpoints", { tool: listBreakpointsTool, category: 'debugging' });

    // Execution control tools
    const resumeTool = this.server.registerTool(
      "resume",
      {
        title: "Resume Execution",
        description: "Resume execution",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.resume());
      }
    );

    this.tools.set("resume", { tool: resumeTool, category: 'debugging' });

    const pauseTool = this.server.registerTool(
      "pause",
      {
        title: "Pause Execution",
        description: "Pause execution",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.pause());
      }
    );

    this.tools.set("pause", { tool: pauseTool, category: 'debugging' });

    const stepOverTool = this.server.registerTool(
      "step_over",
      {
        title: "Step Over",
        description: "Step over to next line",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.stepOver());
      }
    );

    this.tools.set("step_over", { tool: stepOverTool, category: 'debugging' });

    const stepIntoTool = this.server.registerTool(
      "step_into",
      {
        title: "Step Into",
        description: "Step into function call",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.stepInto());
      }
    );

    this.tools.set("step_into", { tool: stepIntoTool, category: 'debugging' });

    const stepOutTool = this.server.registerTool(
      "step_out",
      {
        title: "Step Out",
        description: "Step out of current function",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.stepOut());
      }
    );

    this.tools.set("step_out", { tool: stepOutTool, category: 'debugging' });

    // Variable inspection tools
    const evaluateTool = this.server.registerTool(
      "evaluate",
      {
        title: "Evaluate Expression",
        description: "Evaluate JavaScript expression with optional response truncation",
        inputSchema: {
          expression: z.string().describe("JavaScript expression to evaluate"),
          callFrameId: z.string().optional().describe("Call frame ID for context (optional)"),
          maxLength: z.number().optional().describe("Maximum response length in characters (default: 20000)"),
          maxDepth: z.number().optional().describe("Maximum object depth (default: 10)"),
          maxArrayItems: z.number().optional().describe("Maximum array items to show (default: 50)"),
          maxObjectKeys: z.number().optional().describe("Maximum object keys to show (default: 50)"),
          summary: z.boolean().optional().describe("Return summary mode (types only, default: false)"),
        },
      },
      async ({ expression, callFrameId, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };

        return this.fixContentTypes(await this.debuggerManager.evaluate(expression, callFrameId, options));
      }
    );

    this.tools.set("evaluate", { tool: evaluateTool, category: 'inspection' });

    const getCallStackTool = this.server.registerTool(
      "get_call_stack",
      {
        title: "Get Call Stack",
        description: "Get current call stack with optional response truncation",
        inputSchema: {
          maxLength: z.number().optional().describe("Maximum response length in characters (default: 20000)"),
          maxDepth: z.number().optional().describe("Maximum object depth (default: 10)"),
          maxArrayItems: z.number().optional().describe("Maximum array items to show (default: 50)"),
          maxObjectKeys: z.number().optional().describe("Maximum object keys to show (default: 50)"),
          summary: z.boolean().optional().describe("Return summary mode (types only, default: false)"),
        },
      },
      async ({ maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };

        return this.fixContentTypes(await this.debuggerManager.getCallStack(options));
      }
    );

    this.tools.set("get_call_stack", { tool: getCallStackTool, category: 'inspection' });

    const getScopeVariablesTool = this.server.registerTool(
      "get_scope_variables",
      {
        title: "Get Scope Variables",
        description: "Get variables in scope with optional response truncation",
        inputSchema: {
          callFrameId: z.string().describe("Call frame ID to get variables for"),
          maxLength: z.number().optional().describe("Maximum response length in characters (default: 20000)"),
          maxDepth: z.number().optional().describe("Maximum object depth (default: 10)"),
          maxArrayItems: z.number().optional().describe("Maximum array items to show (default: 50)"),
          maxObjectKeys: z.number().optional().describe("Maximum object keys to show (default: 50)"),
          summary: z.boolean().optional().describe("Return summary mode (types only, default: false)"),
        },
      },
      async ({ callFrameId, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };

        return this.fixContentTypes(await this.debuggerManager.getScopeVariables(callFrameId, options));
      }
    );

    this.tools.set("get_scope_variables", { tool: getScopeVariablesTool, category: 'inspection' });

    const getLogpointHitsTool = this.server.registerTool(
      "get_logpoint_hits",
      {
        title: "Get Logpoint Hits",
        description: "Get all captured logpoint hits from console API calls",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.getLogpointHits());
      }
    );

    this.tools.set("get_logpoint_hits", { tool: getLogpointHitsTool, category: 'data' });

    const clearLogpointHitsTool = this.server.registerTool(
      "clear_logpoint_hits",
      {
        title: "Clear Logpoint Hits",
        description: "Clear all captured logpoint hits from memory",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.clearLogpointHits());
      }
    );

    this.tools.set("clear_logpoint_hits", { tool: clearLogpointHitsTool, category: 'data' });


    const getDebuggerEventsTool = this.server.registerTool(
      "get_debugger_events",
      {
        title: "Get Debugger Events",
        description: "Get all captured debugger pause/resume events",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.getDebuggerEvents());
      }
    );

    this.tools.set("get_debugger_events", { tool: getDebuggerEventsTool, category: 'data' });

    const clearDebuggerEventsTool = this.server.registerTool(
      "clear_debugger_events",
      {
        title: "Clear Debugger Events",
        description: "Clear all captured debugger events from memory",
        inputSchema: {},
      },
      async () => {
        return this.fixContentTypes(await this.debuggerManager.clearDebuggerEvents());
      }
    );

    this.tools.set("clear_debugger_events", { tool: clearDebuggerEventsTool, category: 'data' });

    const getDebuggerStateTool = this.server.registerTool(
      "get_debugger_state",
      {
        title: "Get Debugger State",
        description: "Get current debugger connection state and tool availability",
        inputSchema: {},
      },
      async () => {
        const debugInfo = this.toolStateManager.getDebugInfo();
        const connectionInfo = {
          isConnected: this.cdpClient.isConnected,
          webSocketUrl: this.cdpClient.webSocketUrl,
        };

        return this.fixContentTypes({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                connection: connectionInfo,
                state: debugInfo,
                toolsAvailability: {
                  enabled: debugInfo.enabledTools,
                  disabled: debugInfo.disabledTools,
                }
              }, null, 2)
            }
          ]
        });
      }
    );

    this.tools.set("get_debugger_state", { tool: getDebuggerStateTool, category: 'inspection' });

    const resolveOriginalPositionTool = this.server.registerTool(
      "resolve_original_position",
      {
        title: "Resolve Original Position",
        description: "Map from compiled code location to original source location using source maps",
        inputSchema: {
          generatedLine: z.number().describe("Line number in compiled code (1-based)"),
          generatedColumn: z.number().describe("Column number in compiled code (0-based)"),
          sourceMapPaths: z.array(z.string()).optional().describe("Optional array of .map file paths (defaults to build directory search)"),
        },
      },
      async ({ generatedLine, generatedColumn, sourceMapPaths }) => {
        return this.fixContentTypes(await this.debuggerManager.resolveOriginalPosition(generatedLine, generatedColumn, sourceMapPaths));
      }
    );

    this.tools.set("resolve_original_position", { tool: resolveOriginalPositionTool, category: 'data' });

    const resolveGeneratedPositionTool = this.server.registerTool(
      "resolve_generated_position",
      {
        title: "Resolve Generated Position",
        description: "Map from original source location to compiled code location using source maps",
        inputSchema: {
          originalSource: z.string().describe("Original source file name (as it appears in source map)"),
          originalLine: z.number().describe("Line number in original source code (1-based)"),
          originalColumn: z.number().describe("Column number in original source code (0-based)"),
          sourceMapPaths: z.array(z.string()).optional().describe("Optional array of .map file paths (defaults to build directory search)"),
        },
      },
      async ({ originalSource, originalLine, originalColumn, sourceMapPaths }) => {
        return this.fixContentTypes(await this.debuggerManager.resolveGeneratedPosition(originalSource, originalLine, originalColumn, sourceMapPaths));
      }
    );

    this.tools.set("resolve_generated_position", { tool: resolveGeneratedPositionTool, category: 'data' });
  }

  private updateToolsAvailability() {
    // Claude Code doesn't properly handle tools/list_changed notifications
    // The issue is known: https://github.com/anthropics/claude-code/issues/2722
    //
    // As a workaround, we register ALL tools upfront and use runtime validation
    // instead of dynamic enable/disable. This ensures all tools are always visible
    // to Claude Code, but unavailable tools return helpful error messages.

    // No-op: all tools are always registered and available in the tool list
    // Tool availability is enforced at runtime by validateToolAvailability()
  }

  private async disconnect() {
    await this.cdpClient.disconnect();

    return {
      content: [
        {
          type: "text",
          text: "Disconnected from debugger",
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();

    await this.server.connect(transport);
  }
}
