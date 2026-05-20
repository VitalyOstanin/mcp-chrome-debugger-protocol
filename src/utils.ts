// Utility functions and constants for MCP DAP Debugger Protocol
import { setTimeout } from "node:timers/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import safeStringify from "safe-stable-stringify";

/**
 * Wire-format envelope for every MCP tool response. The single `text` chunk
 * carries the JSON-stringified ToolResponse; clients parse it back into
 * SuccessResponse | ErrorResponse.
 */
export interface MCPResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

/**
 * Failure payload returned inside MCPResponse.text. `error` is the short
 * machine-friendly summary, `message` (when present) is the underlying
 * exception text, `code` is the stable error category for programmatic
 * branching, and `details` carries free-form context for diagnostics.
 */
export interface ErrorResponse {
  success: false;
  error: string;
  message?: string | undefined;
  code: string;
  details?: Record<string, unknown>;
}

/**
 * Success payload returned inside MCPResponse.text. `data` is whatever the
 * specific tool decided to return — see each tool registration for its shape.
 */
export interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
}

/** Discriminated union of the two ToolResponse shapes — switch on `success`. */
export type ToolResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

/**
 * Extract a human-readable text from a thrown / rejected value. Centralises the
 * `error instanceof Error ? error.message : String(error)` idiom that was
 * repeated 25+ times across the codebase, so a future change (e.g. handle
 * AggregateError, redact PII) touches one place.
 */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;

  return safeStringify(cause) ?? String(cause);
}

/**
 * Build an MCPResponse wrapping an ErrorResponse JSON body. Used directly when
 * a tool needs custom error code/details; for the common try/catch path prefer
 * `withErrorHandling`.
 */
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

/**
 * Build an MCPResponse wrapping a SuccessResponse JSON body. The generic `T`
 * is preserved purely for documentation/IDE hints — the body is JSON-stringified
 * so type info is not transmitted on the wire.
 */
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

// Context keys whose values may carry user-authored expressions / values that
// could contain secrets (e.g. evaluate("process.env.API_KEY"), setVariable
// receiving a secret literal). Redact them when echoing the context into
// ErrorResponse.details so a thrown evaluation does not surface the original
// source string verbatim back to the MCP client logs.
const SENSITIVE_DETAIL_KEYS = new Set([
  'expression',
  'value',
  'condition',
  'logMessage',
]);

function redactSensitiveContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    if (SENSITIVE_DETAIL_KEYS.has(key) && typeof value === 'string') {
      redacted[key] = `[redacted: ${value.length} chars]`;
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Run `operation` and convert the outcome to an MCPResponse: a SuccessResponse
 * wrapping its return value, or an ErrorResponse with code `OPERATION_FAILED`
 * and `details = context` carrying both operation name and any extra fields the
 * caller passed in (sensitive fields like `expression` / `value` are redacted
 * to a `[redacted: N chars]` placeholder before they reach the client). Use
 * this for every tool handler so error wrapping is uniform across the server.
 */
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
      errorMessage(error),
      'OPERATION_FAILED',
      redactSensitiveContext(context),
    );
  }
}

/**
 * Promise-based sleep: `await sleep(ms)`. Re-export of node:timers/promises
 * setTimeout so callers do not have to remember the import path.
 */
export const sleep = setTimeout;

/**
 * Walk up from `startDir` looking for a `package.json`. Returns the directory
 * that contains it, or null if none found before reaching the filesystem root.
 * DAPDebuggerManager and SourceMapResolver used to inline two slightly
 * different copies of this; centralise so a future change touches one place.
 *
 * Result is memoised by `startDir` within the process. Project structure does
 * not change at runtime, and findProjectRoot is on the source-map /
 * setBreakpoints hot path — dropping the per-call existsSync chain is worth a
 * tiny Map.
 */
const projectRootCache = new Map<string, string | null>();

export function findProjectRoot(startDir: string): string | null {
  const cached = projectRootCache.get(startDir);

  if (cached !== undefined) {
    return cached;
  }

  let currentDir = startDir;

  while (currentDir !== dirname(currentDir)) {
    if (existsSync(join(currentDir, 'package.json'))) {
      projectRootCache.set(startDir, currentDir);

      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  projectRootCache.set(startDir, null);

  return null;
}
