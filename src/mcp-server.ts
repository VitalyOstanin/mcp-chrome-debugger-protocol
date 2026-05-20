import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DAPClient } from "./dap-client.js";
import { DAPDebuggerManager } from "./dap-debugger-manager.js";
import { ToolStateManager } from "./tool-state-manager.js";
import { DEFAULTS, INSPECTOR_PORT_RANGE } from "./constants.js";
import { logError } from "./logger.js";

// Shared Zod schemas. MCP/DAP coordinate system is 1-based for both lines and columns.
const lineNumberSchema = z.number().int().min(1).describe("Line number (1-based)");
const columnNumberSchema = z.number().int().min(1).describe("Column number (1-based)");
const portSchema = z.number().int().min(1).max(65535);
const idSchema = z.number().int().min(1);
// Truncation options shared by evaluate / stackTrace / variables tools.
// Spread into each tool's inputSchema so a change here propagates to all three.
const truncationOptionsSchema = {
  maxLength: z.number().int().min(100).optional().describe("Maximum response length in characters (default: 20000, min: 100)"),
  maxDepth: z.number().int().min(0).optional().describe("Maximum object depth (default: 10)"),
  maxArrayItems: z.number().int().min(1).optional().describe("Maximum array items to show (default: 50, min: 1)"),
  maxObjectKeys: z.number().int().min(0).optional().describe("Maximum object keys to show (default: 50)"),
  summary: z.boolean().optional().describe("Return summary mode (types only, default: false)"),
} as const;

interface PackageManifest {
  name: string;
  version: string;
}

const packageManifest: PackageManifest = (() => {
  // Resolve from dist/index.js or dist/mcp-server.js up to the project root.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')];

  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as PackageManifest;
    } catch {
      // try next candidate
    }
  }

  return { name: '@vitalyostanin/mcp-chrome-debugger-protocol', version: '0.0.0' };
})();

export class NodeDebuggerMCPServer {
  private readonly server: McpServer;
  private readonly dapClient: DAPClient;
  private readonly debuggerManager: DAPDebuggerManager;
  private readonly toolStateManager: ToolStateManager;


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

  private validateToolAvailability(toolName: string): { isEnabled: boolean; reason?: string | undefined } {
    const toolState = this.toolStateManager.getToolState(toolName);

    return {
      isEnabled: toolState.isEnabled,
      reason: toolState.reason,
    };
  }

  private createToolUnavailableError(toolName: string, reason: string) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: `Tool "${toolName}" is disabled: ${reason}`,
      }],
    };
  }

  // Boilerplate around every gated tool: check availability, run work, normalise content types.
  private async runGatedTool(
    toolName: string,
    work: () => Promise<{ content?: Array<{ type: string; text: string; [key: string]: unknown }> }>,
  ) {
    const availability = this.validateToolAvailability(toolName);

    if (!availability.isEnabled) {
      return this.createToolUnavailableError(toolName, availability.reason!);
    }

    const result = await work();

    return this.fixContentTypes(result);
  }

  // For tools that are always available (no gating). Just normalises content types.
  private async runOpenTool(
    work: () => Promise<{ content?: Array<{ type: string; text: string; [key: string]: unknown }> }>,
  ) {
    const result = await work();

    return this.fixContentTypes(result);
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
      logError(`Failed to send ${type} notification`, error);
    });
  }

  constructor() {
    this.server = new McpServer(
      {
        name: packageManifest.name,
        version: packageManifest.version,
      },
      {
        capabilities: {
          tools: {},
          logging: {},
        },
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
        logError('Failed to send logpoint hit notification', error);
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
        logError('Failed to send debugger paused notification', error);
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
        logError('Failed to send debugger resumed notification', error);
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
        logError('Failed to send connection state notification', error);
      });
    });
  }

  private setupStateManagement() {
    // Tool availability used to be propagated via tools/list_changed, but Claude
    // Code does not honour that notification (issue anthropics/claude-code#2722).
    // We register every tool upfront and gate at request time inside runGatedTool.

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

  private setupConnectionTools() {
    // Connection tools - available when NOT connected
    this.server.registerTool(
      "attach",
      {
        title: "Attach to Node.js Process",
        description: "Attach to Node.js debugger process using DAP",
        inputSchema: {
          url: z.string().optional().describe(`WebSocket URL of the debugger (e.g., ws://127.0.0.1:${DEFAULTS.INSPECTOR_PORT}/...)`),
          port: portSchema.optional().default(DEFAULTS.INSPECTOR_PORT).describe(`Debug port (default: ${DEFAULTS.INSPECTOR_PORT})`),
          address: z.string().optional().default(DEFAULTS.INSPECTOR_CLIENT_HOST).describe(`Debug address (default: ${DEFAULTS.INSPECTOR_CLIENT_HOST})`),
          processId: z.number().int().min(1).optional().describe("Process ID to attach to"),
          discoverTimeoutMs: z.number().int().min(0).optional().default(DEFAULTS.DISCOVER_TIMEOUT_MS).describe(`Max time (ms) to poll for the inspector port after sending SIGUSR1. 0 disables polling entirely (deadline = now), so attach returns immediately if strace did not detect the port. Pair with explicit ports=[] when you only want strace-based detection. Default ${DEFAULTS.DISCOVER_TIMEOUT_MS}.`),
          probeTimeoutMs: z.number().int().min(0).optional().default(DEFAULTS.PROBE_TIMEOUT_MS).describe(`Timeout (ms) for a single /json/version HTTP probe inside the polling loop. 0 collapses each probe round to "fail immediately"; the loop still iterates until discoverTimeoutMs elapses. Default ${DEFAULTS.PROBE_TIMEOUT_MS}.`),
          ports: z.array(portSchema).optional().describe(`Explicit list of ports to probe when enabling by PID (defaults ${INSPECTOR_PORT_RANGE.start}..${INSPECTOR_PORT_RANGE.end}). Pass [] to disable probing entirely (no polling) — useful when you only want strace detection or when discoverTimeoutMs is 0.`),
        },
      },
      async ({
        url,
        port = DEFAULTS.INSPECTOR_PORT,
        address = DEFAULTS.INSPECTOR_CLIENT_HOST,
        processId,
        discoverTimeoutMs = DEFAULTS.DISCOVER_TIMEOUT_MS,
        probeTimeoutMs = DEFAULTS.PROBE_TIMEOUT_MS,
        ports,
      }) => {
        return this.runGatedTool("attach", async () => {
          if (url) {
            return this.dapClient.connectUrl(url);
          }
          if (processId) {
            // For PID-based enablement, Node will choose the inspector port; auto-discover it with configured timeouts.
            return this.dapClient.enableDebuggerPid(processId, {
              discoverTimeoutMs,
              probeTimeoutMs,
              ports,
            });
          }
          if (port === DEFAULTS.INSPECTOR_PORT && address === DEFAULTS.INSPECTOR_CLIENT_HOST) {
            return this.dapClient.connectDefault();
          }

          return this.dapClient.connectUrl(`ws://${address}:${port}`);
        });
      },
    );

    // Disconnection tool - available when connected
    this.server.registerTool(
      "disconnect",
      {
        title: "Disconnect",
        description: "Disconnect from current debugger session",
        inputSchema: {},
      },
      async () => this.runGatedTool("disconnect", () => this.disconnect()),
    );
  }

  private registerDebuggingTools() {
    // Register all debugging tools upfront. Availability is enforced inside
    // runGatedTool via ToolStateManager; nothing here switches on the
    // connection state at registration time.

    // Breakpoint management tools
    this.server.registerTool(
      "setBreakpoints",
      {
        title: "Set Breakpoints",
        description: "Set breakpoints and logpoints in a source file (DAP standard). Tips: (1) when using logMessage with {expr}, place the logpoint at the next executable statement after the variables used in {expr} are assigned/updated; (2) conditions are evaluated at the breakpoint line as well — place the breakpoint after variables referenced in condition are assigned/updated.",
        inputSchema: {
          source: z.object({
            path: z.string().describe("Absolute file path to source code file"),
          }).describe("Source file information"),
          breakpoints: z.array(z.object({
            line: lineNumberSchema,
            column: columnNumberSchema.optional(),
            condition: z.string().optional().describe("Conditional expression for breakpoint (optional). Evaluated at the breakpoint line; place the breakpoint at the next executable statement after variables referenced here are assigned/updated to avoid undefined values."),
            logMessage: z.string().optional().describe("Log message for logpoint (optional). Supports {expr} placeholders evaluated at the logpoint line. Place the logpoint at the next executable statement after variables used in {expr} are assigned; placing it earlier may yield undefined."),
          })).optional().describe("Array of breakpoints to set"),
          lines: z.array(lineNumberSchema).optional().describe("Simple array of line numbers (alternative to breakpoints array)"),
        },
      },
      async ({ source, breakpoints, lines }) => {
        return this.runGatedTool("setBreakpoints", async () => {
          const result = await this.debuggerManager.setBreakpoints(source, breakpoints, lines);

          // Send notification about breakpoints creation
          try {
            const parsedResult = JSON.parse(result.content[0]!.text);

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

          return result;
        });
      },
    );

    this.server.registerTool(
      "removeBreakpoint",
      {
        title: "Remove Breakpoint",
        description: "Remove a breakpoint",
        inputSchema: {
          breakpointId: idSchema.describe("Breakpoint ID to remove"),
        },
      },
      async ({ breakpointId }) => {
        return this.runGatedTool("removeBreakpoint", async () => {
          const result = await this.debuggerManager.removeBreakpoint(breakpointId);

          // Only emit the notification when the manager confirmed the removal;
          // otherwise clients would see "breakpoint_removed" for breakpoints
          // that never existed or that couldn't be cleared at the adapter.
          try {
            const parsedResult = JSON.parse(result.content[0]!.text);

            if (parsedResult.success) {
              this.sendBreakpointNotification('breakpoint_removed', { breakpointId });
            }
          } catch {
            // Malformed payload -- skip the notification rather than lying about state.
          }

          return result;
        });
      },
    );

    this.server.registerTool(
      "getBreakpoints",
      {
        title: "Get Breakpoints",
        description: "Get all active breakpoints and logpoints with source code context",
        inputSchema: {},
      },
      async () => this.runGatedTool("getBreakpoints", () => this.debuggerManager.getBreakpoints()),
    );

    // Execution control tools
    this.server.registerTool(
      "continue",
      {
        title: "Continue Execution",
        description: "Continue execution (DAP standard name for resume)",
        inputSchema: {
          threadId: idSchema.optional().describe("Thread ID to continue (optional)"),
        },
      },
      async ({ threadId }) => this.runGatedTool("continue", () => this.debuggerManager.continue(threadId)),
    );

    this.server.registerTool(
      "pause",
      {
        title: "Pause Execution",
        description: "Pause execution",
        inputSchema: {},
      },
      async () => this.runGatedTool("pause", () => this.debuggerManager.pause()),
    );

    this.server.registerTool(
      "next",
      {
        title: "Step Over (Next)",
        description: "Step over to next line (DAP standard name for step over)",
        inputSchema: {
          threadId: idSchema.optional().describe("Thread ID to step (optional)"),
        },
      },
      async ({ threadId }) => this.runGatedTool("next", () => this.debuggerManager.next(threadId)),
    );

    this.server.registerTool(
      "stepIn",
      {
        title: "Step Into",
        description: "Step into function call (DAP standard name)",
        inputSchema: {
          threadId: idSchema.optional().describe("Thread ID to step (optional)"),
        },
      },
      async ({ threadId }) => this.runGatedTool("stepIn", () => this.debuggerManager.stepIn(threadId)),
    );

    this.server.registerTool(
      "stepOut",
      {
        title: "Step Out",
        description: "Step out of current function (DAP standard name)",
        inputSchema: {
          threadId: idSchema.optional().describe("Thread ID to step (optional)"),
        },
      },
      async ({ threadId }) => this.runGatedTool("stepOut", () => this.debuggerManager.stepOut(threadId)),
    );

    // Variable inspection tools
    this.server.registerTool(
      "evaluate",
      {
        title: "Evaluate Expression",
        description: "Evaluate JavaScript expression in debug context (DAP standard name)",
        inputSchema: {
          expression: z.string().describe("JavaScript expression to evaluate"),
          frameId: z.number().int().min(0).optional().describe("Stack frame ID for context (optional)"),
          context: z.enum(['watch', 'repl', 'hover']).optional().describe("Context for the evaluation (optional)"),
          ...truncationOptionsSchema,
        },
      },
      async ({ expression, frameId, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };

        return this.runGatedTool("evaluate", () => this.debuggerManager.evaluate(expression, frameId, options));
      },
    );

    this.server.registerTool(
      "stackTrace",
      {
        title: "Stack Trace",
        description: "Get current call stack (DAP standard name)",
        inputSchema: {
          threadId: idSchema.optional().describe("Thread ID to get stack for (optional)"),
          startFrame: z.number().int().min(0).optional().describe("Start frame index (default: 0)"),
          levels: z.number().int().min(0).optional().describe("Number of frames to return (default: all)"),
          ...truncationOptionsSchema,
        },
      },
      async ({ threadId, startFrame, levels, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };

        return this.runGatedTool("stackTrace", () => this.debuggerManager.stackTrace(threadId, startFrame, levels, options));
      },
    );

    this.server.registerTool(
      "variables",
      {
        title: "Variables",
        description: "Get variables in scope (DAP standard name)",
        inputSchema: {
          variablesReference: z.number().int().min(1).describe("Variable reference to get children for"),
          filter: z.enum(['indexed', 'named']).optional().describe("Filter for variable types (optional)"),
          start: z.number().int().min(0).optional().describe("Start index for indexed variables (optional)"),
          count: z.number().int().min(0).optional().describe("Number of variables to return (optional)"),
          ...truncationOptionsSchema,
        },
      },
      async ({ variablesReference, filter, start, count, maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary }) => {
        const options = { maxLength, maxDepth, maxArrayItems, maxObjectKeys, summary };

        return this.runGatedTool("variables", () => this.debuggerManager.variables(variablesReference, filter, start, count, options));
      },
    );

    this.server.registerTool(
      "getLogpointHits",
      {
        title: "Get Logpoint Hits",
        description: "Get all captured logpoint hits from console API calls",
        inputSchema: {},
      },
      async () => this.runOpenTool(() => this.debuggerManager.getLogpointHits()),
    );

    this.server.registerTool(
      "clearLogpointHits",
      {
        title: "Clear Logpoint Hits",
        description: "Clear all captured logpoint hits from memory",
        inputSchema: {},
      },
      async () => this.runOpenTool(() => this.debuggerManager.clearLogpointHits()),
    );

    this.server.registerTool(
      "getDebuggerEvents",
      {
        title: "Get Debugger Events",
        description: "Get all captured debugger pause/resume events",
        inputSchema: {},
      },
      async () => this.runOpenTool(() => this.debuggerManager.getDebuggerEvents()),
    );

    this.server.registerTool(
      "clearDebuggerEvents",
      {
        title: "Clear Debugger Events",
        description: "Clear all captured debugger events from memory",
        inputSchema: {},
      },
      async () => this.runOpenTool(() => this.debuggerManager.clearDebuggerEvents()),
    );

    this.server.registerTool(
      "getDebuggerState",
      {
        title: "Get Debugger State",
        description: "Get current debugger connection state and tool availability",
        inputSchema: {},
      },
      async () => this.runOpenTool(async () => {
        const debugInfo = this.toolStateManager.getDebugInfo();
        const connectionInfo = {
          isConnected: this.dapClient.isConnected,
          webSocketUrl: this.dapClient.webSocketUrl,
        };

        return {
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
      }),
    );

    this.server.registerTool(
      "resolveOriginalPosition",
      {
        title: "Resolve Original Position",
        description: "Map from compiled JavaScript location to original TypeScript source location using source maps",
        inputSchema: {
          generatedLine: lineNumberSchema.describe("Line number in compiled JavaScript file (1-based)"),
          generatedColumn: columnNumberSchema.describe("Column number in compiled JavaScript file (1-based)"),
          sourceMapPaths: z.array(z.string()).optional().describe("Optional array of .map file paths (defaults to build directory search). Pass [] to skip autodiscovery."),
          generatedSourcePath: z.string().optional().describe("Absolute path of the generated .js file. Used to anchor source-map autodiscovery to the right project root when sourceMapPaths is omitted."),
        },
      },
      async ({ generatedLine, generatedColumn, sourceMapPaths, generatedSourcePath }) =>
        this.runOpenTool(() =>
          this.debuggerManager.resolveOriginalPosition(generatedLine, generatedColumn, sourceMapPaths, generatedSourcePath),
        ),
    );

    this.server.registerTool(
      "resolveGeneratedPosition",
      {
        title: "Resolve Generated Position",
        description: "Map from original TypeScript source location to compiled JavaScript location using source maps",
        inputSchema: {
          originalSource: z.string().min(1).describe("Original TypeScript source file name (as it appears in source map)"),
          originalLine: lineNumberSchema.describe("Line number in original TypeScript source file (1-based)"),
          originalColumn: columnNumberSchema.describe("Column number in original TypeScript source file (1-based)"),
          sourceMapPaths: z.array(z.string()).optional().describe("Optional array of .map file paths (defaults to build directory search)"),
          originalSourcePath: z.string().optional().describe("Absolute path to the TS source; enables auto-discovery of source maps in project build dirs"),
        },
      },
      async ({ originalSource, originalLine, originalColumn, sourceMapPaths, originalSourcePath }) =>
        this.runOpenTool(() => this.debuggerManager.resolveGeneratedPosition(
          originalSource,
          originalLine,
          originalColumn,
          sourceMapPaths,
          originalSourcePath,
        )),
    );

    // Additional DAP tools for complete protocol coverage.
    //
    // The DAP `launch` request is intentionally not registered: this server
    // always attaches to an externally-spawned Node.js process (see attach
    // tool above). Exposing a launch tool that just throws would only confuse
    // tools/list consumers. If launch support is added later, it must (a)
    // validate `program` against an allow-list, (b) not inherit process.env
    // wholesale into the spawned child, and (c) only expose itself to clients
    // that explicitly opt in -- see security review notes for context.

    this.server.registerTool(
      "threads",
      {
        title: "Get Threads",
        description: "Get information about all threads (DAP standard)",
        inputSchema: {},
      },
      async () => this.runGatedTool("threads", () => this.debuggerManager.threads()),
    );

    this.server.registerTool(
      "scopes",
      {
        title: "Get Scopes",
        description: "Get variable scopes for a stack frame (DAP standard)",
        inputSchema: {
          frameId: z.number().int().min(0).describe("Stack frame ID to get scopes for"),
        },
      },
      async ({ frameId }) => this.runGatedTool("scopes", () => this.debuggerManager.scopes(frameId)),
    );

    this.server.registerTool(
      "setVariable",
      {
        title: "Set Variable",
        description: "Set the value of a variable (DAP standard)",
        inputSchema: {
          variablesReference: z.number().int().min(1).describe("Variable reference containing the variable"),
          name: z.string().describe("Name of the variable to set"),
          value: z.string().describe("New value for the variable"),
        },
      },
      async ({ variablesReference, name, value }) =>
        this.runGatedTool("setVariable", () => this.debuggerManager.setVariable(variablesReference, name, value)),
    );

    this.server.registerTool(
      "loadedSources",
      {
        title: "Get Loaded Sources",
        description: "Get all loaded source files (DAP standard)",
        inputSchema: {},
      },
      async () => this.runGatedTool("loadedSources", () => this.debuggerManager.loadedSources()),
    );

    this.server.registerTool(
      "restart",
      {
        title: "Restart Debugging Session",
        description: "Restart the debugging session (DAP standard)",
        inputSchema: {},
      },
      async () => this.runGatedTool("restart", () => this.debuggerManager.restart()),
    );

    this.server.registerTool(
      "terminate",
      {
        title: "Terminate Process",
        description: "Terminate the debuggee process (DAP standard)",
        inputSchema: {},
      },
      async () => this.runGatedTool("terminate", () => this.debuggerManager.terminate()),
    );

    this.server.registerTool(
      "exceptionInfo",
      {
        title: "Get Exception Information",
        description: "Get detailed information about an exception (DAP standard)",
        inputSchema: {
          threadId: idSchema.describe("Thread ID where the exception occurred"),
        },
      },
      async ({ threadId }) => this.runGatedTool("exceptionInfo", () => this.debuggerManager.exceptionInfo(threadId)),
    );

    this.server.registerTool(
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
      async ({ filters, exceptionOptions }) =>
        this.runGatedTool("setExceptionBreakpoints", () => this.debuggerManager.setExceptionBreakpoints(filters, exceptionOptions)),
    );

    this.server.registerTool(
      "breakpointLocations",
      {
        title: "Get Breakpoint Locations",
        description: "Get valid breakpoint locations in source file (DAP standard)",
        inputSchema: {
          source: z.object({
            path: z.string().describe("Path to source file"),
          }).describe("Source file information"),
          line: lineNumberSchema.describe("Line number to check for breakpoint locations"),
          column: columnNumberSchema.optional().describe("Optional column number"),
          endLine: lineNumberSchema.optional().describe("Optional end line for range"),
          endColumn: columnNumberSchema.optional().describe("Optional end column for range"),
        },
      },
      async ({ source, line, column, endLine, endColumn }) =>
        this.runGatedTool("breakpointLocations", () => this.debuggerManager.breakpointLocations(source, line, column, endLine, endColumn)),
    );

    this.server.registerTool(
      "goto",
      {
        title: "Go To Target",
        description: "Jump to a specific line or target (DAP standard)",
        inputSchema: {
          threadId: idSchema.describe("Thread ID to perform goto on"),
          targetId: idSchema.describe("Target ID to jump to"),
        },
      },
      async ({ threadId, targetId }) =>
        this.runGatedTool("goto", () => this.debuggerManager.goto(threadId, targetId)),
    );

    this.server.registerTool(
      "restartFrame",
      {
        title: "Restart Frame",
        description: "Restart execution from a specific stack frame (DAP standard)",
        inputSchema: {
          frameId: z.number().int().min(0).describe("Stack frame ID to restart from"),
        },
      },
      async ({ frameId }) =>
        this.runGatedTool("restartFrame", () => this.debuggerManager.restartFrame(frameId)),
    );

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
