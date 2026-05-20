// Minimal logger so the rest of the codebase does not have to remember the
// console.* / process.stderr split, and so DAP_VERBOSE diagnostics share a
// single gate. This is intentionally tiny: structured logging belongs to the
// MCP client and to OutputEvent over DAP, not to a local file.

import { errorMessage } from "./utils.js";

const verboseEnabled = process.env.DAP_VERBOSE === '1' || process.env.DAP_VERBOSE === 'true';

function formatCause(cause: unknown): string {
  if (cause === undefined || cause === null) return '';

  return `: ${errorMessage(cause)}`;
}

/**
 * Log a non-fatal error to stderr. All `console.error` sites in this codebase
 * funnel here so future routing changes (file sink, MCP notification) touch
 * one place.
 */
export function logError(message: string, cause?: unknown): void {
  console.error(`${message}${formatCause(cause)}`);
}

/**
 * Log a warning to stderr. Same routing rules as logError; separate level so
 * later filtering (e.g. CI quiet mode) can keep warnings while still hiding
 * info chatter.
 */
export function logWarn(message: string, cause?: unknown): void {
  console.warn(`${message}${formatCause(cause)}`);
}

/**
 * Log a diagnostic line only when DAP_VERBOSE is set. Prefer this over
 * `if (verbose) console.log(...)` so the env-var check stays in one place.
 * Component prefix mirrors the convention used by NodeJSDebugAdapter.diagnostic.
 */
export function logVerbose(component: string, message: string): void {
  if (!verboseEnabled) return;
  console.error(`[${component}] ${message}`);
}

/** Snapshot of the verbose flag for callers that need to gate a heavy code
 *  path (e.g. JSON.stringify on hot loops) before deciding whether to log. */
export function isVerbose(): boolean {
  return verboseEnabled;
}
