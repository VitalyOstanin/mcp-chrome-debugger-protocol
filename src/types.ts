// Note: the historical DebuggerConnection interface lived here but was unused
// after the in-process DAP refactor. DAPClient owns the only canonical shape
// (DAPConnection in dap-client.ts).

/**
 * Truncation budgets passed to DAPDebuggerManager.truncateResult to bound the
 * size of MCP responses. All limits are optional; omitted fields fall back to
 * the defaults documented in DEFAULTS / truncateResult.
 */
export interface TruncationOptions {
  /** Maximum total response length in characters before fallback summarisation. */
  maxLength?: number | undefined;
  /** Maximum recursion depth when walking nested objects/arrays. */
  maxDepth?: number | undefined;
  /** Maximum number of array entries kept verbatim before "... N more items". */
  maxArrayItems?: number | undefined;
  /** Maximum number of object keys kept verbatim before "... N more keys". */
  maxObjectKeys?: number | undefined;
  /** When true, replace nested values with "[type]" markers instead of recursing. */
  summary?: boolean | undefined;
}

/**
 * One logpoint hit captured via the in-process DAP custom `mcpLogpoint` event.
 * Stored in DAPClient's bounded ring buffer and returned by `getLogpointHits`.
 */
export interface LogpointHit {
  /** Human-readable message rendered from the logpoint template, when available. */
  message?: string | undefined;
  /** Raw payload string as sent from Runtime.bindingCalled. Always present in live hits. */
  payloadRaw?: string | undefined;
  /** Parsed JSON payload from `payloadRaw`. Undefined when the payload was not JSON. */
  payload?: unknown | undefined;
  /** Wall-clock timestamp of when the hit reached DAPClient. */
  timestamp: Date;
  /** V8 execution context id reported by Runtime.bindingCalled. 0 for the simulated path. */
  executionContextId: number;
  /** Optional stack trace metadata. Reserved for future use. */
  stackTrace?: unknown | undefined;
  /** Severity tag. Currently always 'info' on the live path. */
  level?: string | undefined;
}

/** A debugger pause/resume event observed by DAPClient and exposed via getDebuggerEvents. */
export interface DebuggerEvent {
  type: 'paused' | 'resumed';
  timestamp: Date;
  data: Record<string, unknown>;
}

/**
 * One breakpoint tracked by DAPClient. Includes both what the client asked for
 * (originalRequest) and where the runtime actually resolved it (actualLocation),
 * plus optional source-map metadata for TS<->JS hops.
 */
export interface TrackedBreakpoint {
  /** DAP breakpoint id assigned by the adapter; stable across re-sends with identical signature. */
  breakpointId: number;
  /** 'breakpoint' for plain pauses; 'logpoint' when the entry has a logMessage. */
  type: 'breakpoint' | 'logpoint';
  /** What the client asked for (1-based line and column, MCP/DAP coordinates). */
  originalRequest: {
    filePath: string;
    lineNumber: number;
    columnNumber: number;
    condition?: string | undefined;
    logMessage?: string | undefined;
  };
  /** Where the runtime actually placed the breakpoint after CDP resolution. */
  actualLocation: {
    scriptId?: string | undefined;
    lineNumber: number;
    columnNumber: number;
  };
  /** Source-map resolution metadata when the breakpoint hopped TS->JS. */
  sourceMapResolution: {
    used: boolean;
    sourceMapFile?: string | undefined;
    matchedSource?: string | undefined;
    targetFile?: string | undefined;
    targetLocation?: {
      lineNumber: number;
      columnNumber: number;
    };
  };
  /** Wall-clock timestamp of the original setBreakpoints call. */
  timestamp: Date;
}

