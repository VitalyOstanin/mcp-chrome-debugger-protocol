// Utility functions and constants for MCP DAP Debugger Protocol
import { setTimeout } from "node:timers/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import safeStringify from "safe-stable-stringify";
import { DomainError } from "./errors.js";

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
      text: safeStringify(response),
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
      text: safeStringify(response),
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
    // Domain errors carry their own MCP code so the client can branch on
    // failure kind (NOT_FOUND vs NOT_CONNECTED vs PROTOCOL_ERROR vs ...) without
    // parsing the message. Plain Errors fall back to the generic code.
    const code = error instanceof DomainError ? error.code : 'OPERATION_FAILED';

    return createErrorResponse(
      `Failed to ${context.operation}`,
      errorMessage(error),
      code,
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
 * Like `Promise.all(items.map(fn))`, but caps the number of `fn` invocations
 * in flight at `limit`. Preserves input order in the returned array so the
 * caller can index back by the original position (matches Promise.all
 * semantics). Used on hot paths like `setBreakpoints` where unbounded
 * parallelism would saturate downstream CDP roundtrips.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit <= 0) {
    throw new Error(`mapWithConcurrency: limit must be > 0, got ${limit}`);
  }

  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);

  return results;
}

/**
 * Walk up from `startDir` looking for a `package.json`. Returns the directory
 * that contains it, or null if none found before reaching the filesystem root.
 * DAPDebuggerManager and SourceMapResolver used to inline two slightly
 * different copies of this; centralise so a future change touches one place.
 *
 * Caching behaviour:
 *   - Successful hits cache forever. Project layout does not change at
 *     runtime; the walk would just reproduce the same answer.
 *   - Negative hits (no package.json found) cache for FIND_PROJECT_ROOT_NULL_TTL_MS,
 *     so a project that was created after the first probe (e.g. on a fresh
 *     long-running MCP session) can still be discovered without forcing a
 *     full walk on every lookup.
 *   - LRU eviction caps the Map at FIND_PROJECT_ROOT_CACHE_MAX entries; a
 *     monorepo walked with many leaf paths would otherwise grow the cache
 *     without bound. We rely on Map insertion order: re-insert on hit so the
 *     most recent entries stay at the tail.
 *
 * Kept synchronous because tests/utils/test-app-manager.resolveAppPath is a
 * sync static method that needs the result. The existsSync chain has bounded
 * depth (≤ filesystem path depth, typically <10) so the event-loop block is
 * sub-millisecond and dominated by the OS stat cache.
 */
const FIND_PROJECT_ROOT_CACHE_MAX = 1024;
const FIND_PROJECT_ROOT_NULL_TTL_MS = 5 * 60 * 1000;

interface ProjectRootCacheEntry {
  value: string | null;
  expiresAt: number; // Infinity for successful hits (never expire).
}

const projectRootCache = new Map<string, ProjectRootCacheEntry>();

function touchCacheEntry(key: string, entry: ProjectRootCacheEntry): void {
  projectRootCache.delete(key);
  projectRootCache.set(key, entry);
  while (projectRootCache.size > FIND_PROJECT_ROOT_CACHE_MAX) {
    const oldest = projectRootCache.keys().next();

    if (oldest.done) break;
    projectRootCache.delete(oldest.value);
  }
}

export function findProjectRoot(startDir: string): string | null {
  const cached = projectRootCache.get(startDir);

  if (cached !== undefined && Date.now() < cached.expiresAt) {
    // Refresh LRU position so a hot key does not get evicted by a flood of
    // one-off lookups.
    touchCacheEntry(startDir, cached);

    return cached.value;
  }

  let currentDir = startDir;

  while (currentDir !== dirname(currentDir)) {
    if (existsSync(join(currentDir, 'package.json'))) {
      touchCacheEntry(startDir, { value: currentDir, expiresAt: Number.POSITIVE_INFINITY });

      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  touchCacheEntry(startDir, { value: null, expiresAt: Date.now() + FIND_PROJECT_ROOT_NULL_TTL_MS });

  return null;
}
