import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DAPClient } from "./dap-client.js";
import { DAPDebuggerManager } from "./dap-debugger-manager.js";
import { ToolStateManager } from "./tool-state-manager.js";

type ToolCategory = 'connection' | 'disconnection' | 'debugging' | 'inspection' | 'data';

interface CategorizedTool {
  tool: RegisteredTool;
  category: ToolCategory;
}

export class NodeDebuggerMCPServer {
  private readonly server: McpServer;
  private readonly dapClient: DAPClient;
  private readonly debuggerManager: DAPDebuggerManager;
  private readonly toolStateManager: ToolStateManager;
  private readonly tools: Map<string, CategorizedTool> = new Map();


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
      reason: toolState.reason,
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
        ...data,
      },
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
      },
    );

    this.dapClient = new DAPClient();
    this.debuggerManager = new DAPDebuggerManager(this.dapClient);
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
    this.dapClient.on('logpointHit', (logpointHit) => {
      this.server.server.sendLoggingMessage({
        level: 'info',
        logger: 'debugger-logpoint',
        data: {
          type: 'logpoint_hit',
          message: logpointHit.message,
          timestamp: logpointHit.timestamp.toISOString(),
          executionContextId: logpointHit.executionContextId,
          stackTrace: logpointHit.stackTrace,
          payloadRaw: logpointHit.payloadRaw,
          payload: logpointHit.payload,
        },
      }).catch((error: unknown) => {
        console.error('Failed to send logpoint hit notification:', error);
      });
    });

    // Forward debugger pause events to MCP client
    this.dapClient.on('debuggerPaused', (debuggerEvent) => {
      this.server.server.sendLoggingMessage({
        level: 'notice',
        logger: 'debugger-events',
        data: {
          type: 'debugger_paused',
          timestamp: debuggerEvent.timestamp.toISOString(),
          data: debuggerEvent.data,
        },
      }).catch((error: unknown) => {
        console.error('Failed to send debugger paused notification:', error);
      });
    });

    // Forward debugger resume events to MCP client
    this.dapClient.on('debuggerResumed', (debuggerEvent) => {
      this.server.server.sendLoggingMessage({
        level: 'notice',
        logger: 'debugger-events',
        data: {
          type: 'debugger_resumed',
          timestamp: debuggerEvent.timestamp.toISOString(),
          data: debuggerEvent.data,
        },
      }).catch((error: unknown) => {
        console.error('Failed to send debugger resumed notification:', error);
      });
    });

    // Forward connection state changes to MCP client
    this.dapClient.onStateChange((connected) => {
      this.server.server.sendLoggingMessage({
        level: 'info',
        logger: 'debugger-connection',
        data: {
          type: 'connection_changed',
          connected,
          timestamp: new Date().toISOString(),
        },
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

    // Listen for DAP events to update state
    this.dapClient.onStateChange((connected: boolean) => {
      this.toolStateManager.setConnection(connected);
    });

    // Listen for debugger pause/resume events
    this.dapClient.onDebuggerPause(() => {
      this.toolStateManager.setPaused(true);
    });

    this.dapClient.onDebuggerResume(() => {
      this.toolStateManager.setPaused(false);
    });
  }

  // Removed requireConnection method as tools are now dynamically enabled/disabled

  private setupConnectionTools() {
    // Connection tools - available when NOT connected
    const attachTool = this.server.registerTool(
      "attach",
      {
        title: "Attach to Node.js Process",
        description: "Attach to Node.js debugger process using DAP",
        inputSchema: {
          url: z.string().optional().describe("WebSocket URL of the debugger (e.g., ws://127.0.0.1:9229/...)"),
          port: z.number().optional().default(9229).describe("Debug port (default: 9229)"),
          address: z.string().optional().default("localhost").describe("Debug address (default: localhost)"),
          processId: z.number().optional().describe("Process ID to attach to"),
          discoverTimeoutMs: z.number().optional().default(8000).describe("Max time to discover inspector port (ms)"),
          probeTimeoutMs: z.number().optional().default(400).describe("Timeout for /json/version probe (ms)"),
          ports: z.array(z.number()).optional().describe("Explicit list of ports to probe when enabling by PID (defaults 9229..9250)"),
        },
      },
      async ({ url, port = 9229, address = "localhost", processId, discoverTimeoutMs = 8000, probeTimeoutMs = 400, ports }) => {
        const availability = this.validateToolAvailability("attach");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("attach", availability.reason!);
        }

        let result;

        if (url) {
          result = await this.dapClient.connectUrl(url);
        } else if (processId) {
          // For PID-based enablement, Node will choose the inspector port; auto-discover it with configured timeouts.
          result = await this.dapClient.enableDebuggerPid(processId, {
            discoverTimeoutMs,
            probeTimeoutMs,
            ports,
          });
        } else if (port === 9229 && address === "localhost") {
          result = await this.dapClient.connectDefault();
        } else {
          const url = `ws://${address}:${port}`;

          result = await this.dapClient.connectUrl(url);
        }

        const processedResult = this.fixContentTypes(result);

        return processedResult;
      },
    );

    this.tools.set("attach", { tool: attachTool, category: 'connection' });

    // attach tool above now handles all connection scenarios

    // enableDebuggerPid functionality moved to attach tool

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
        const processedResult = this.fixContentTypes(result);

        return processedResult;
      },
    );

    this.tools.set("disconnect", { tool: disconnectTool, category: 'disconnection' });
  }

  private registerDebuggingTools() {
    // Register all debugging tools but they will be enabled/disabled based on connection state

    // Breakpoint management tools
    const setBreakpointsTool = this.server.registerTool(
      "setBreakpoints",
      {
        title: "Set Breakpoints",
        description: "Set breakpoints and logpoints in a source file (DAP standard). Tips: (1) when using logMessage with {expr}, place the logpoint at the next executable statement after the variables used in {expr} are assigned/updated; (2) conditions are evaluated at the breakpoint line as well — place the breakpoint after variables referenced in condition are assigned/updated.",
        inputSchema: {
          source: z.object({
            path: z.string().describe("Absolute file path to source code file"),
          }).describe("Source file information"),
          breakpoints: z.array(z.object({
            line: z.number().describe("Line number in source file (1-based)"),
            column: z.number().optional().describe("Column number in source file (1-based, optional)"),
            condition: z.string().optional().describe("Conditional expression for breakpoint (optional). Evaluated at the breakpoint line; place the breakpoint at the next executable statement after variables referenced here are assigned/updated to avoid undefined values."),
            logMessage: z.string().optional().describe("Log message for logpoint (optional). Supports {expr} placeholders evaluated at the logpoint line. Place the logpoint at the next executable statement after variables used in {expr} are assigned; placing it earlier may yield undefined."),
          })).optional().describe("Array of breakpoints to set"),
          lines: z.array(z.number()).optional().describe("Simple array of line numbers (alternative to breakpoints array)"),
        },
      },
      async ({ source, breakpoints, lines }) => {
        const availability = this.validateToolAvailability("setBreakpoints");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("setBreakpoints", availability.reason!);
        }

        const result = await this.debuggerManager.setBreakpoints(source, breakpoints, lines);

        // Send notification about breakpoints creation
        // Extract breakpoints from the response
        try {
          const parsedResult = JSON.parse(result.content[0].text);

          if (parsedResult.success && parsedResult.data?.breakpoints) {
            this.sendBreakpointNotification('breakpoint_set', {
              source: source.path,
              breakpoints: parsedResult.data.breakpoints,
            });
          }
        } catch {
          // If parsing fails, still send notification without details
          this.sendBreakpointNotification('breakpoint_set', {
            source: source.path,
            count: breakpoints?.length ?? lines?.length ?? 0,
          });
        }

        const processedResult = this.fixContentTypes(result);

        return processedResult;
      },
    );

    this.tools.set("setBreakpoints", { tool: setBreakpointsTool, category: 'debugging' });

    // Logpoints are now handled by setBreakpoints tool with logMessage parameter

    const removeBreakpointTool = this.server.registerTool(
      "removeBreakpoint",
      {
        title: "Remove Breakpoint",
        description: "Remove a breakpoint",
        inputSchema: {
          breakpointId: z.number().describe("Breakpoint ID to remove"),
        },
      },
      async ({ breakpointId }) => {
        const result = await this.debuggerManager.removeBreakpoint(breakpointId);

        // Send notification about breakpoint removal
        this.sendBreakpointNotification('breakpoint_removed', {
          breakpointId,
        });

        const processedResult = this.fixContentTypes(result);

        return processedResult;
      },
    );

    this.tools.set("removeBreakpoint", { tool: removeBreakpointTool, category: 'debugging' });

    const getBreakpointsTool = this.server.registerTool(
      "getBreakpoints",
      {
        title: "Get Breakpoints",
        description: "Get all active breakpoints and logpoints with source code context",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("getBreakpoints");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("getBreakpoints", availability.reason!);
        }

        const breakpointsData = await this.debuggerManager.getBreakpoints();
        const processedResult = this.fixContentTypes(breakpointsData);

        return processedResult;
      },
    );

    this.tools.set("getBreakpoints", { tool: getBreakpointsTool, category: 'debugging' });

    // Execution control tools
    const continueTool = this.server.registerTool(
      "continue",
      {
        title: "Continue Execution",
        description: "Continue execution (DAP standard name for resume)",
        inputSchema: {
          threadId: z.number().optional().describe("Thread ID to continue (optional)"),
        },
      },
      async ({ threadId }) => {
        const availability = this.validateToolAvailability("continue");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("continue", availability.reason!);
        }

        const continueResult = await this.debuggerManager.continue(threadId);
        const processedResult = this.fixContentTypes(continueResult);

        return processedResult;
      },
    );

    this.tools.set("continue", { tool: continueTool, category: 'debugging' });

    const pauseTool = this.server.registerTool(
      "pause",
      {
        title: "Pause Execution",
        description: "Pause execution",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("pause");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("pause", availability.reason!);
        }

        const pauseResult = await this.debuggerManager.pause();
        const processedResult = this.fixContentTypes(pauseResult);

        return processedResult;
      },
    );

    this.tools.set("pause", { tool: pauseTool, category: 'debugging' });

    const nextTool = this.server.registerTool(
      "next",
      {
        title: "Step Over (Next)",
        description: "Step over to next line (DAP standard name for step over)",
        inputSchema: {
          threadId: z.number().optional().describe("Thread ID to step (optional)"),
        },
      },
      async ({ threadId }) => {
        const availability = this.validateToolAvailability("next");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("next", availability.reason!);
        }

        const stepResult = await this.debuggerManager.next(threadId);
        const processedResult = this.fixContentTypes(stepResult);

        return processedResult;
      },
    );

    this.tools.set("next", { tool: nextTool, category: 'debugging' });

    const stepInTool = this.server.registerTool(
      "stepIn",
      {
        title: "Step Into",
        description: "Step into function call (DAP standard name)",
        inputSchema: {
          threadId: z.number().optional().describe("Thread ID to step (optional)"),
        },
      },
      async ({ threadId }) => {
        const availability = this.validateToolAvailability("stepIn");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("stepIn", availability.reason!);
        }

        const stepInResult = await this.debuggerManager.stepIn(threadId);
        const processedResult = this.fixContentTypes(stepInResult);

        return processedResult;
      },
    );

    this.tools.set("stepIn", { tool: stepInTool, category: 'debugging' });

    const stepOutTool = this.server.registerTool(
      "stepOut",
      {
        title: "Step Out",
        description: "Step out of current function (DAP standard name)",
        inputSchema: {
          threadId: z.number().optional().describe("Thread ID to step (optional)"),
        },
      },
      async () => {
        const availability = this.validateToolAvailability("stepOut");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("stepOut", availability.reason!);
        }

        const stepOutResult = await this.debuggerManager.stepOut();
        const processedResult = this.fixContentTypes(stepOutResult);

        return processedResult;
      },
    );

    this.tools.set("stepOut", { tool: stepOutTool, category: 'debugging' });

    // Variable inspection tools
    const evaluateTool = this.server.registerTool(
      "evaluate",
      {
        title: "Evaluate Expression",
        description: "Evaluate JavaScript expression in debug context (DAP standard name)",
        inputSchema: {
          expression: z.string().describe("JavaScript expression to evaluate"),
          frameId: z.number().optional().describe("Stack frame ID for context (optional)"),
          context: z.enum(['watch', 'repl', 'hover']).optional().describe("Context for the evaluation (optional)"),
          maxLength: z.number().optional().describe("Maximum response length in characters (default: 20000)"),
          maxDepth: z.number().optional().describe("Maximum object depth (default: 10)"),
          maxArrayItems: z.number().optional().describe("Maximum array items to show (default: 50)"),
          maxObjectKeys: z.number().optional().describe("Maximum object keys to show (default: 50)"),
          summary: z.boolean().optional().describe("Return summary mode (types only, default: false)"),
        },
      },
      async ({ expression, frameId, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const availability = this.validateToolAvailability("evaluate");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("evaluate", availability.reason!);
        }

        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };
        const evaluationResult = await this.debuggerManager.evaluate(expression, frameId?.toString(), options);
        const processedResult = this.fixContentTypes(evaluationResult);

        return processedResult;
      },
    );

    this.tools.set("evaluate", { tool: evaluateTool, category: 'inspection' });

    const stackTraceTool = this.server.registerTool(
      "stackTrace",
      {
        title: "Stack Trace",
        description: "Get current call stack (DAP standard name)",
        inputSchema: {
          threadId: z.number().optional().describe("Thread ID to get stack for (optional)"),
          startFrame: z.number().optional().describe("Start frame index (default: 0)"),
          levels: z.number().optional().describe("Number of frames to return (default: all)"),
          maxLength: z.number().optional().describe("Maximum response length in characters (default: 20000)"),
          maxDepth: z.number().optional().describe("Maximum object depth (default: 10)"),
          maxArrayItems: z.number().optional().describe("Maximum array items to show (default: 50)"),
          maxObjectKeys: z.number().optional().describe("Maximum object keys to show (default: 50)"),
          summary: z.boolean().optional().describe("Return summary mode (types only, default: false)"),
        },
      },
      async ({ threadId, startFrame, levels, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const availability = this.validateToolAvailability("stackTrace");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("stackTrace", availability.reason!);
        }

        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };
        const stackTraceResult = await this.debuggerManager.stackTrace(threadId, startFrame, levels, options);
        const processedResult = this.fixContentTypes(stackTraceResult);

        return processedResult;
      },
    );

    this.tools.set("stackTrace", { tool: stackTraceTool, category: 'inspection' });

    const variablesTool = this.server.registerTool(
      "variables",
      {
        title: "Variables",
        description: "Get variables in scope (DAP standard name)",
        inputSchema: {
          variablesReference: z.number().describe("Variable reference to get children for"),
          filter: z.enum(['indexed', 'named']).optional().describe("Filter for variable types (optional)"),
          start: z.number().optional().describe("Start index for indexed variables (optional)"),
          count: z.number().optional().describe("Number of variables to return (optional)"),
          maxLength: z.number().optional().describe("Maximum response length in characters (default: 20000)"),
          maxDepth: z.number().optional().describe("Maximum object depth (default: 10)"),
          maxArrayItems: z.number().optional().describe("Maximum array items to show (default: 50)"),
          maxObjectKeys: z.number().optional().describe("Maximum object keys to show (default: 50)"),
          summary: z.boolean().optional().describe("Return summary mode (types only, default: false)"),
        },
      },
      async ({ variablesReference, filter, start, count, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const availability = this.validateToolAvailability("variables");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("variables", availability.reason!);
        }

        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };
        const variablesResult = await this.debuggerManager.variables(variablesReference, filter, start, count, options);
        const processedResult = this.fixContentTypes(variablesResult);

        return processedResult;
      },
    );

    this.tools.set("variables", { tool: variablesTool, category: 'inspection' });

    const getLogpointHitsTool = this.server.registerTool(
      "getLogpointHits",
      {
        title: "Get Logpoint Hits",
        description: "Get all captured logpoint hits from console API calls",
        inputSchema: {},
      },
      async () => {
        const logpointHits = await this.debuggerManager.getLogpointHits();
        const processedResult = this.fixContentTypes(logpointHits);

        return processedResult;
      },
    );

    this.tools.set("getLogpointHits", { tool: getLogpointHitsTool, category: 'data' });

    const clearLogpointHitsTool = this.server.registerTool(
      "clearLogpointHits",
      {
        title: "Clear Logpoint Hits",
        description: "Clear all captured logpoint hits from memory",
        inputSchema: {},
      },
      async () => {
        const clearResult = await this.debuggerManager.clearLogpointHits();
        const processedResult = this.fixContentTypes(clearResult);

        return processedResult;
      },
    );

    this.tools.set("clearLogpointHits", { tool: clearLogpointHitsTool, category: 'data' });


    const getDebuggerEventsTool = this.server.registerTool(
      "getDebuggerEvents",
      {
        title: "Get Debugger Events",
        description: "Get all captured debugger pause/resume events",
        inputSchema: {},
      },
      async () => {
        const debuggerEvents = await this.debuggerManager.getDebuggerEvents();
        const processedResult = this.fixContentTypes(debuggerEvents);

        return processedResult;
      },
    );

    this.tools.set("getDebuggerEvents", { tool: getDebuggerEventsTool, category: 'data' });

    const clearDebuggerEventsTool = this.server.registerTool(
      "clearDebuggerEvents",
      {
        title: "Clear Debugger Events",
        description: "Clear all captured debugger events from memory",
        inputSchema: {},
      },
      async () => {
        const clearResult = await this.debuggerManager.clearDebuggerEvents();
        const processedResult = this.fixContentTypes(clearResult);

        return processedResult;
      },
    );

    this.tools.set("clearDebuggerEvents", { tool: clearDebuggerEventsTool, category: 'data' });

    const getDebuggerStateTool = this.server.registerTool(
      "getDebuggerState",
      {
        title: "Get Debugger State",
        description: "Get current debugger connection state and tool availability",
        inputSchema: {},
      },
      async () => {
        const debugInfo = this.toolStateManager.getDebugInfo();
        const connectionInfo = {
          isConnected: this.dapClient.isConnected,
          webSocketUrl: this.dapClient.webSocketUrl,
        };
        const stateData = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                connection: connectionInfo,
                state: debugInfo,
                toolsAvailability: {
                  enabled: debugInfo.enabledTools,
                  disabled: debugInfo.disabledTools,
                },
              }, null, 2),
            },
          ],
        };
        const processedResult = this.fixContentTypes(stateData);

        return processedResult;
      },
    );

    this.tools.set("getDebuggerState", { tool: getDebuggerStateTool, category: 'inspection' });

    const resolveOriginalPositionTool = this.server.registerTool(
      "resolveOriginalPosition",
      {
        title: "Resolve Original Position",
        description: "Map from compiled JavaScript location to original TypeScript source location using source maps",
        inputSchema: {
          generatedLine: z.number().describe("Line number in compiled JavaScript file (1-based)"),
          generatedColumn: z.number().describe("Column number in compiled JavaScript file (1-based)"),
          sourceMapPaths: z.array(z.string()).optional().describe("Optional array of .map file paths (defaults to build directory search)"),
        },
      },
      async ({ generatedLine, generatedColumn, sourceMapPaths }) => {
        const originalPosition = await this.debuggerManager.resolveOriginalPosition(generatedLine, generatedColumn, sourceMapPaths);
        const processedResult = this.fixContentTypes(originalPosition);

        return processedResult;
      },
    );

    this.tools.set("resolveOriginalPosition", { tool: resolveOriginalPositionTool, category: 'data' });

    const resolveGeneratedPositionTool = this.server.registerTool(
      "resolveGeneratedPosition",
      {
        title: "Resolve Generated Position",
        description: "Map from original TypeScript source location to compiled JavaScript location using source maps",
        inputSchema: {
          originalSource: z.string().describe("Original TypeScript source file name (as it appears in source map)"),
          originalLine: z.number().describe("Line number in original TypeScript source file (1-based)"),
          originalColumn: z.number().describe("Column number in original TypeScript source file (1-based)"),
          sourceMapPaths: z.array(z.string()).optional().describe("Optional array of .map file paths (defaults to build directory search)"),
          originalSourcePath: z.string().optional().describe("Absolute path to the TS source; enables auto-discovery of source maps in project build dirs"),
        },
      },
      async ({ originalSource, originalLine, originalColumn, sourceMapPaths, originalSourcePath }) => {
        const generatedPosition = await this.debuggerManager.resolveGeneratedPosition(
          originalSource,
          originalLine,
          originalColumn,
          sourceMapPaths,
          originalSourcePath,
        );
        const processedResult = this.fixContentTypes(generatedPosition);

        return processedResult;
      },
    );

    this.tools.set("resolveGeneratedPosition", { tool: resolveGeneratedPositionTool, category: 'data' });

    // Additional DAP tools for complete protocol coverage

    const launchTool = this.server.registerTool(
      "launch",
      {
        title: "Launch Program",
        description: "Launch a Node.js program with debugging enabled (DAP standard)",
        inputSchema: {
          program: z.string().describe("Path to the Node.js program to launch"),
          args: z.array(z.string()).optional().describe("Command line arguments for the program"),
          cwd: z.string().optional().describe("Working directory for the program"),
          env: z.record(z.string()).optional().describe("Environment variables"),
        },
      },
      async ({ program, args, cwd, env }) => {
        const availability = this.validateToolAvailability("launch");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("launch", availability.reason!);
        }

        const launchResult = await this.debuggerManager.launch({ program, args, cwd, env });
        const processedResult = this.fixContentTypes(launchResult);

        return processedResult;
      },
    );

    this.tools.set("launch", { tool: launchTool, category: 'connection' });

    const threadsTool = this.server.registerTool(
      "threads",
      {
        title: "Get Threads",
        description: "Get information about all threads (DAP standard)",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("threads");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("threads", availability.reason!);
        }

        const threadsResult = await this.debuggerManager.threads();
        const processedResult = this.fixContentTypes(threadsResult);

        return processedResult;
      },
    );

    this.tools.set("threads", { tool: threadsTool, category: 'inspection' });

    const scopesTool = this.server.registerTool(
      "scopes",
      {
        title: "Get Scopes",
        description: "Get variable scopes for a stack frame (DAP standard)",
        inputSchema: {
          frameId: z.number().describe("Stack frame ID to get scopes for"),
        },
      },
      async ({ frameId }) => {
        const availability = this.validateToolAvailability("scopes");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("scopes", availability.reason!);
        }

        const scopesResult = await this.debuggerManager.scopes(frameId);
        const processedResult = this.fixContentTypes(scopesResult);

        return processedResult;
      },
    );

    this.tools.set("scopes", { tool: scopesTool, category: 'inspection' });

    const setVariableTool = this.server.registerTool(
      "setVariable",
      {
        title: "Set Variable",
        description: "Set the value of a variable (DAP standard)",
        inputSchema: {
          variablesReference: z.number().describe("Variable reference containing the variable"),
          name: z.string().describe("Name of the variable to set"),
          value: z.string().describe("New value for the variable"),
        },
      },
      async ({ variablesReference, name, value }) => {
        const availability = this.validateToolAvailability("setVariable");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("setVariable", availability.reason!);
        }

        const setVariableResult = await this.debuggerManager.setVariable(variablesReference, name, value);
        const processedResult = this.fixContentTypes(setVariableResult);

        return processedResult;
      },
    );

    this.tools.set("setVariable", { tool: setVariableTool, category: 'inspection' });

    const loadedSourcesTool = this.server.registerTool(
      "loadedSources",
      {
        title: "Get Loaded Sources",
        description: "Get all loaded source files (DAP standard)",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("loadedSources");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("loadedSources", availability.reason!);
        }

        const loadedSourcesResult = await this.debuggerManager.loadedSources();
        const processedResult = this.fixContentTypes(loadedSourcesResult);

        return processedResult;
      },
    );

    this.tools.set("loadedSources", { tool: loadedSourcesTool, category: 'inspection' });

    const restartTool = this.server.registerTool(
      "restart",
      {
        title: "Restart Debugging Session",
        description: "Restart the debugging session (DAP standard)",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("restart");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("restart", availability.reason!);
        }

        const restartResult = await this.debuggerManager.restart();
        const processedResult = this.fixContentTypes(restartResult);

        return processedResult;
      },
    );

    this.tools.set("restart", { tool: restartTool, category: 'connection' });

    const terminateTool = this.server.registerTool(
      "terminate",
      {
        title: "Terminate Process",
        description: "Terminate the debuggee process (DAP standard)",
        inputSchema: {},
      },
      async () => {
        const availability = this.validateToolAvailability("terminate");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("terminate", availability.reason!);
        }

        const terminateResult = await this.debuggerManager.terminate();
        const processedResult = this.fixContentTypes(terminateResult);

        return processedResult;
      },
    );

    this.tools.set("terminate", { tool: terminateTool, category: 'connection' });

    const exceptionInfoTool = this.server.registerTool(
      "exceptionInfo",
      {
        title: "Get Exception Information",
        description: "Get detailed information about an exception (DAP standard)",
        inputSchema: {
          threadId: z.number().describe("Thread ID where the exception occurred"),
        },
      },
      async ({ threadId }) => {
        const availability = this.validateToolAvailability("exceptionInfo");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("exceptionInfo", availability.reason!);
        }

        const exceptionInfoResult = await this.debuggerManager.exceptionInfo(threadId);
        const processedResult = this.fixContentTypes(exceptionInfoResult);

        return processedResult;
      },
    );

    this.tools.set("exceptionInfo", { tool: exceptionInfoTool, category: 'inspection' });

    const setExceptionBreakpointsTool = this.server.registerTool(
      "setExceptionBreakpoints",
      {
        title: "Set Exception Breakpoints",
        description: "Configure exception breakpoint filters (DAP standard)",
        inputSchema: {
          filters: z.array(z.string()).describe("Exception filter IDs (e.g., 'uncaught', 'all')"),
          exceptionOptions: z.array(z.object({
            filterId: z.string().describe("Filter ID"),
            condition: z.string().optional().describe("Optional condition"),
          })).optional().describe("Advanced exception options"),
        },
      },
      async ({ filters, exceptionOptions }) => {
        const availability = this.validateToolAvailability("setExceptionBreakpoints");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("setExceptionBreakpoints", availability.reason!);
        }

        const exceptionBreakpointsResult = await this.debuggerManager.setExceptionBreakpoints(filters, exceptionOptions);
        const processedResult = this.fixContentTypes(exceptionBreakpointsResult);

        return processedResult;
      },
    );

    this.tools.set("setExceptionBreakpoints", { tool: setExceptionBreakpointsTool, category: 'debugging' });

    const breakpointLocationsTool = this.server.registerTool(
      "breakpointLocations",
      {
        title: "Get Breakpoint Locations",
        description: "Get valid breakpoint locations in source file (DAP standard)",
        inputSchema: {
          source: z.object({
            path: z.string().describe("Path to source file"),
          }).describe("Source file information"),
          line: z.number().describe("Line number to check for breakpoint locations"),
          column: z.number().optional().describe("Optional column number"),
          endLine: z.number().optional().describe("Optional end line for range"),
          endColumn: z.number().optional().describe("Optional end column for range"),
        },
      },
      async ({ source, line, column, endLine, endColumn }) => {
        const availability = this.validateToolAvailability("breakpointLocations");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("breakpointLocations", availability.reason!);
        }

        const breakpointLocationsResult = await this.debuggerManager.breakpointLocations(source, line, column, endLine, endColumn);
        const processedResult = this.fixContentTypes(breakpointLocationsResult);

        return processedResult;
      },
    );

    this.tools.set("breakpointLocations", { tool: breakpointLocationsTool, category: 'debugging' });

    const gotoTool = this.server.registerTool(
      "goto",
      {
        title: "Go To Target",
        description: "Jump to a specific line or target (DAP standard)",
        inputSchema: {
          threadId: z.number().describe("Thread ID to perform goto on"),
          targetId: z.number().describe("Target ID to jump to"),
        },
      },
      async ({ threadId, targetId }) => {
        const availability = this.validateToolAvailability("goto");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("goto", availability.reason!);
        }

        const gotoResult = await this.debuggerManager.goto(threadId, targetId);
        const processedResult = this.fixContentTypes(gotoResult);

        return processedResult;
      },
    );

    this.tools.set("goto", { tool: gotoTool, category: 'debugging' });

    const restartFrameTool = this.server.registerTool(
      "restartFrame",
      {
        title: "Restart Frame",
        description: "Restart execution from a specific stack frame (DAP standard)",
        inputSchema: {
          frameId: z.number().describe("Stack frame ID to restart from"),
        },
      },
      async ({ frameId }) => {
        const availability = this.validateToolAvailability("restartFrame");

        if (!availability.isEnabled) {
          return this.createToolUnavailableError("restartFrame", availability.reason!);
        }

        const restartFrameResult = await this.debuggerManager.restartFrame(frameId);
        const processedResult = this.fixContentTypes(restartFrameResult);

        return processedResult;
      },
    );

    this.tools.set("restartFrame", { tool: restartFrameTool, category: 'debugging' });
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
    await this.dapClient.disconnect();

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
