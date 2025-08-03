// Utility functions and constants for MCP Chrome Debugger Protocol
import { setTimeout } from "node:timers/promises";
import { readFileSync, existsSync } from "node:fs";
import { SourceMapResolver } from "./source-map-resolver.js";

// Common error messages
export const ERROR_MESSAGES = {
  NOT_CONNECTED: "Not connected to debugger",
  CONNECTION_REQUIRED: "Use connect_default, connect_url, or enable_debugger_pid first.",
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
  details?: Record<string, unknown>
): MCPResponse {
  const response: ErrorResponse = {
    success: false,
    error,
    code,
    ...(details && { details })
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(response)
    }]
  };
}

// Helper to create success responses
export function createSuccessResponse<T>(data: T): MCPResponse {
  const response: SuccessResponse<T> = {
    success: true,
    data
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(response)
    }]
  };
}

// Generic error handler utility
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: { operation: string; [key: string]: unknown }
): Promise<MCPResponse> {
  try {
    const result = await operation();

    return createSuccessResponse(result);
  } catch (error) {
    return createErrorResponse(
      `Failed to ${context.operation}`,
      error instanceof Error ? error.message : String(error),
      'OPERATION_FAILED',
      context
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

// Source code context utilities

export interface SourceCodeContext {
  filePath: string;
  targetLine: number;
  lines: Array<{
    number: number;
    content: string;
    isTarget: boolean;
  }>;
  markerType: 'breakpoint' | 'logpoint';
  recommendation: string;
}

export interface SourceContextOptions {
  contextLines?: number;
  useSourceMaps?: boolean;
  sourceMapResolver?: SourceMapResolver;
  markerType?: 'breakpoint' | 'logpoint';
}

/**
 * Extract source code context around a specific line, with source map support
 */
export async function getSourceCodeContext(
  filePath: string,
  lineNumber: number,
  columnNumber: number = 0,
  options: SourceContextOptions = {}
): Promise<SourceCodeContext | null> {
  const {
    contextLines = 10,
    useSourceMaps = true,
    sourceMapResolver,
    markerType = 'breakpoint'
  } = options;

  let targetFilePath = filePath;
  let targetLineNumber = lineNumber;

  // For TypeScript files, use them directly as they are the original source
  if (filePath.endsWith('.ts')) {
    targetFilePath = filePath;
    targetLineNumber = lineNumber;
  } else if (useSourceMaps && sourceMapResolver && filePath.endsWith('.js')) {
    // For JavaScript files, try to resolve back to original TypeScript source using reverse mapping
    try {
      // Use the existing resolveOriginalPosition method for reverse mapping
      const resolveResult = await sourceMapResolver.resolveOriginalPosition(lineNumber, columnNumber);
      const resolveData = JSON.parse(resolveResult.content[0].text);

      if (resolveData.success && resolveData.originalPosition && resolveData.sourceContent) {
        // Found original source mapping
        targetFilePath = resolveData.originalPosition.source;
        targetLineNumber = resolveData.originalPosition.line;

        // If we have a relative source path, we may need to construct full path
        if (!existsSync(targetFilePath) && !targetFilePath.startsWith('/')) {
          // Try to construct full path by looking for the source file
          const sourceFileName = targetFilePath.split('/').pop();

          if (sourceFileName) {
            // This is a fallback - in practice, source maps should provide full paths
            // or we'd need project structure knowledge
            targetFilePath = filePath; // fallback to original
            targetLineNumber = lineNumber;
          }
        }
      }
    } catch {
      // If source map resolution fails, use the original file
    }
  }

  // Check if the target file exists
  if (!existsSync(targetFilePath)) {
    return null;
  }

  try {
    const fileContent = readFileSync(targetFilePath, 'utf-8');
    const lines = fileContent.split('\n');

    // Calculate context range
    const startLine = Math.max(1, targetLineNumber - contextLines);
    const endLine = Math.min(lines.length, targetLineNumber + contextLines);

    // Extract context lines with metadata
    const contextLines_result: Array<{
      number: number;
      content: string;
      isTarget: boolean;
    }> = [];

    for (let i = startLine - 1; i < endLine; i++) {
      contextLines_result.push({
        number: i + 1,
        content: lines[i] || '',
        isTarget: i + 1 === targetLineNumber
      });
    }

    const recommendation = markerType === 'breakpoint'
      ? "Display this source context with line numbers. Show a red circle marker for the breakpoint line, similar to VS Code debugger."
      : "Display this source context with line numbers. Show a green circle marker for the logpoint line.";

    return {
      filePath: targetFilePath,
      targetLine: targetLineNumber,
      lines: contextLines_result,
      markerType,
      recommendation
    };
  } catch {
    return null;
  }
}
