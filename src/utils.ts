// Utility functions and constants for MCP DAP Debugger Protocol
import { setTimeout } from "node:timers/promises";

// Common error messages
export const ERROR_MESSAGES = {
  NOT_CONNECTED: "Not connected to debugger",
  CONNECTION_REQUIRED: "Use attach first to connect to the debugger.",
} as const;

// Common response structure for MCP tools
export interface MCPResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

// Standardized response interfaces
export interface ErrorResponse {
  success: false;
  error: string;
  message?: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
}

export type ToolResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// Helper to create error responses
export function createErrorResponse(
  error: string,
  message?: string,
  code: string = 'TOOL_ERROR',
  details?: Record<string, unknown>,
): MCPResponse {
  const response: ErrorResponse = {
    success: false,
    error,
    ...(message !== undefined && { message }),
    code,
    ...(details && { details }),
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(response),
    }],
  };
}

// Helper to create success responses
export function createSuccessResponse<T>(data: T): MCPResponse {
  const response: SuccessResponse<T> = {
    success: true,
    data,
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(response),
    }],
  };
}

// Generic error handler utility
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: { operation: string; [key: string]: unknown },
): Promise<MCPResponse> {
  try {
    const result = await operation();

    return createSuccessResponse(result);
  } catch (error) {
    return createErrorResponse(
      `Failed to ${context.operation}`,
      error instanceof Error ? error.message : String(error),
      'OPERATION_FAILED',
      context,
    );
  }
}

// Helper to check if debugger is connected
export function requireConnection(isConnected: boolean): void {
  if (!isConnected) {
    throw new Error(ERROR_MESSAGES.NOT_CONNECTED);
  }
}

// Utility function for delays using Node.js promise timers
export const sleep = setTimeout;
