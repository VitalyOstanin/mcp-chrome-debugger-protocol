import type { Tool } from '@modelcontextprotocol/sdk/types.js';

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Tool['inputSchema'];
}

export const TOOLS_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "connect_default",
    description: "Connect to Node.js debugger on default port 9229",
  },
  {
    name: "connect_url",
    description: "Connect to Node.js debugger by WebSocket URL",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "WebSocket URL for debugger connection",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "enable_debugger_pid",
    description: "Enable debugger for Node.js process by PID using SIGUSR1",
    inputSchema: {
      type: "object",
      properties: {
        pid: {
          type: "number",
          description: "Process ID of Node.js process",
        },
        port: {
          type: "number",
          description: "Port to use for debugger (default: 9229)",
          default: 9229,
        },
      },
      required: ["pid"],
    },
  },
  {
    name: "disconnect",
    description: "Disconnect from current debugger session",
  },
  {
    name: "set_breakpoint",
    description: "Set a breakpoint in the code with optional condition",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute file path (will be converted to relative path from project root)",
        },
        lineNumber: {
          type: "number",
          description: "Line number for breakpoint",
        },
        columnNumber: {
          type: "number",
          description: "Column number for breakpoint (CRITICAL: must be exact/correct column number for reliable source map resolution)",
        },
        condition: {
          type: "string",
          description: "Conditional expression for breakpoint (optional)",
        },
      },
      required: ["filePath", "lineNumber", "columnNumber"],
    },
  },
  {
    name: "set_logpoint",
    description: "Set a logpoint that logs a message without stopping execution",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute file path (will be converted to relative path from project root)",
        },
        lineNumber: {
          type: "number",
          description: "Line number for logpoint",
        },
        columnNumber: {
          type: "number",
          description: "Column number for logpoint (CRITICAL: must be exact/correct column number for reliable source map resolution)",
        },
        logMessage: {
          type: "string",
          description: "Message to log (can include expressions in {})",
        },
      },
      required: ["filePath", "lineNumber", "columnNumber", "logMessage"],
    },
  },
  {
    name: "remove_breakpoint",
    description: "Remove a breakpoint",
    inputSchema: {
      type: "object",
      properties: {
        breakpointId: {
          type: "string",
          description: "Breakpoint ID to remove",
        },
      },
      required: ["breakpointId"],
    },
  },
  {
    name: "resume",
    description: "Resume execution",
  },
  {
    name: "pause",
    description: "Pause execution",
  },
  {
    name: "step_over",
    description: "Step over to next line",
  },
  {
    name: "step_into",
    description: "Step into function call",
  },
  {
    name: "step_out",
    description: "Step out of current function",
  },
  {
    name: "evaluate",
    description: "Evaluate JavaScript expression",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "JavaScript expression to evaluate",
        },
        callFrameId: {
          type: "string",
          description: "Call frame ID for context (optional)",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "get_call_stack",
    description: "Get current call stack",
  },
  {
    name: "get_scope_variables",
    description: "Get variables in scope",
    inputSchema: {
      type: "object",
      properties: {
        callFrameId: {
          type: "string",
          description: "Call frame ID to get variables for",
        },
      },
      required: ["callFrameId"],
    },
  },
  {
    name: "list_breakpoints",
    description: "List all active breakpoints and logpoints with source code context",
  },
] as const;
