import type { DAPClient } from "./dap-client.js";
import type { TruncationOptions } from "./types.js";
import { findProjectRoot, withErrorHandling } from "./utils.js";
import { DEFAULTS } from "./constants.js";
import type { DebugProtocol } from '@vscode/debugprotocol';
import { resolve, relative } from "node:path";
import { SourceMapResolver } from "./source-map-resolver.js";

/**
 * High-level DAP/CDP orchestration layer used by the MCP tool handlers.
 *
 * Wraps {@link DAPClient} for transport-level work and {@link SourceMapResolver}
 * for TS<->JS coordinate mapping, then exposes the domain operations the MCP
 * tools delegate to (set/clear breakpoints, stack/scope/variable inspection,
 * evaluate, stepping, etc.). Output payloads are normalised via the private
 * `truncateResult` so a single oversized response cannot blow the MCP wire
 * budget.
 */
export class DAPDebuggerManager {
  private readonly sourceMapResolver = new SourceMapResolver();

  constructor(private readonly dapClient: DAPClient) {}

  private truncateResult(data: unknown, options: TruncationOptions = {}): { result: unknown; truncated: boolean } {
    const {
      maxLength = DEFAULTS.TRUNCATE_MAX_LENGTH,
      maxDepth = 10,
      maxArrayItems = 50,
      maxObjectKeys = 50,
      summary = false,
    } = options;
    // Pre-floor the budgets so a non-multiple-of-4 maxLength (zod allows any positive
    // integer) cannot leak fractional indices into substring offsets or "more chars"
    // counters. The zod schema also caps maxLength at >=100 so these floors stay sane.
    const stringBudget = Math.max(0, Math.floor(maxLength / 4));
    const previewBudget = Math.max(0, Math.floor(maxLength / 2));
    let truncated = false;
    const truncateValue = (value: unknown, currentDepth: number): unknown => {
      if (currentDepth > maxDepth) {
        truncated = true;

        return '[max depth exceeded]';
      }

      if (value === null || value === undefined) {
        return value;
      }

      if (typeof value === 'string') {
        if (value.length > stringBudget) {
          truncated = true;

          return `${value.substring(0, stringBudget)}... [${value.length - stringBudget} more chars]`;
        }

        return value;
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
      }

      if (Array.isArray(value)) {
        if (value.length > maxArrayItems) {
          truncated = true;

          const truncatedArray = value.slice(0, maxArrayItems).map(item =>
            truncateValue(item, currentDepth + 1),
          );

          truncatedArray.push(`[... and ${value.length - maxArrayItems} more items]`);

          return truncatedArray;
        }

        return value.map(item => truncateValue(item, currentDepth + 1));
      }

      if (typeof value === 'object') {
        const valueObj = value as Record<string, unknown>;
        const keys = Object.keys(valueObj);

        if (keys.length > maxObjectKeys) {
          truncated = true;

          const truncatedObj: Record<string, unknown> = {};

          keys.slice(0, maxObjectKeys).forEach(key => {
            truncatedObj[key] = summary
              ? `[${typeof valueObj[key]}]`
              : truncateValue(valueObj[key], currentDepth + 1);
          });
          truncatedObj[`[... and ${keys.length - maxObjectKeys} more keys]`] = '[truncated]';

          return truncatedObj;
        }

        const result: Record<string, unknown> = {};

        keys.forEach(key => {
          result[key] = summary
            ? `[${typeof valueObj[key]}]`
            : truncateValue(valueObj[key], currentDepth + 1);
        });

        return result;
      }

      return value;
    };
    const result = truncateValue(data, 0);
    // Match the wire-format exactly when measuring the payload size:
    // createSuccessResponse / createErrorResponse both call JSON.stringify
    // without indentation, so comparing against an indented form (the previous
    // `null, 2`) overshot the real size by up to ~30% on nested objects and
    // tripped the truncation fallback for payloads that would have fit. Drop
    // the indent here and only pay the second stringify (for originalSize) on
    // the unhappy path -- happy path now does a single JSON.stringify(result).
    const jsonString = JSON.stringify(result);

    if (jsonString.length > maxLength) {
      return {
        result: {
          error: 'Response too large',
          preview: `${jsonString.substring(0, previewBudget)}...`,
          originalSize: JSON.stringify(data).length,
          truncatedSize: jsonString.length,
        },
        truncated: true,
      };
    }

    return { result, truncated };
  }

  private findProjectRoot(): string {
    return findProjectRoot(process.cwd()) ?? process.cwd();
  }

  // Build a contextual DAP error so the MCP client gets the underlying
  // response.message and the call arguments instead of a generic "Failed to X".
  private dapError(operation: string, response: DebugProtocol.Response, ctx: Record<string, unknown>): Error {
    const ctxString = Object.keys(ctx).length > 0 ? ` (ctx: ${JSON.stringify(ctx)})` : '';

    return new Error(`Failed to ${operation}: ${response.message ?? '(no message)'}${ctxString}`);
  }

  // Common shape: send a DAP execution-control request with no body, return a
  // {threadId, message} payload. Used by continue/pause/next/stepIn/stepOut.
  private async dapAction(
    method: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut',
    threadId: number | undefined,
    successMessage: string,
    operation: string,
  ) {
    const effectiveThreadId = threadId ?? 1;

    return withErrorHandling(async () => {
      await this.dapClient.dapRequest(method, { threadId: effectiveThreadId });

      return { threadId: effectiveThreadId, message: successMessage };
    }, { operation, threadId: effectiveThreadId });
  }

  // Common shape: send a DAP request, validate response.success, and project
  // the body via mapBody. Errors propagate with full context via dapError.
  private async dapTypedRequest<R extends DebugProtocol.Response, T>(
    method: string,
    params: unknown,
    operation: string,
    ctx: Record<string, unknown>,
    mapBody: (body: R['body']) => T,
  ) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<R>(method, params);

      if (!response.success) {
        throw this.dapError(operation, response, ctx);
      }

      return mapBody(response.body);
    }, { operation, ...ctx });
  }

  async removeBreakpoint(breakpointId: number) {
    return withErrorHandling(async () => {
      // Find the tracked breakpoint to get source info (used for the response).
      const trackedBreakpoint = this.dapClient.getTrackedBreakpoints()
        .find(bp => bp.breakpointId === breakpointId);

      if (!trackedBreakpoint) {
        throw new Error(`Breakpoint ${breakpointId} not found`);
      }

      // Remove a single breakpoint by its DAP id; siblings in the same file are not
      // touched. The previous implementation used setBreakpoints with an empty list,
      // which caused clearCDPBreakpoints(path) to wipe ALL breakpoints in the file.
      const result = await this.dapClient.removeBreakpointByDapId(breakpointId);

      if (!result.removed) {
        throw new Error(`Breakpoint ${breakpointId} not found in adapter`);
      }

      this.dapClient.removeTrackedBreakpoint(breakpointId);

      return {
        breakpointId,
        filePath: result.filePath ?? trackedBreakpoint.originalRequest.filePath,
        message: "Breakpoint removed successfully",
      };
    }, { operation: 'remove breakpoint', breakpointId });
  }

  async listBreakpoints() {
    return withErrorHandling(async () => {
      const trackedBreakpoints = this.dapClient.getTrackedBreakpoints();

      return {
        totalCount: trackedBreakpoints.length,
        breakpoints: trackedBreakpoints,
        recommendation: "DAP breakpoints with native source map support and variable interpolation",
      };
    }, { operation: 'list breakpoints' });
  }

  // DAP-standard execution control. Each method delegates to the adapter via dapAction;
  // duplicated legacy aliases (resume/stepInto/stepOver) have been removed.
  async continue(threadId?: number) {
    return this.dapAction('continue', threadId, 'Execution continued', 'continue execution');
  }

  async pause(threadId?: number) {
    return this.dapAction('pause', threadId, 'Execution paused', 'pause execution');
  }

  async next(threadId?: number) {
    return this.dapAction('next', threadId, 'Stepped over', 'step over');
  }

  async stepIn(threadId?: number) {
    return this.dapAction('stepIn', threadId, 'Stepped into', 'step into');
  }

  async stepOut(threadId?: number) {
    return this.dapAction('stepOut', threadId, 'Stepped out', 'step out');
  }

  async evaluate(expression: string, frameId?: number, options: TruncationOptions = {}) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.EvaluateResponse>(
        'evaluate',
        {
          expression,
          frameId,
          context: 'repl',
        },
      );
      const { result: truncatedResult, truncated } = this.truncateResult(response.body, options);

      return {
        result: truncatedResult,
        ...(truncated && {
          meta: {
            truncated: true,
            message: 'Response was truncated due to size limits',
          },
        }),
      };
    }, { operation: 'evaluate expression', expression, frameId });
  }

  async getLogpointHits() {
    return withErrorHandling(() => {
      const hits = this.dapClient.getLogpointHits();

      return Promise.resolve({
        hits: hits.map(hit => ({
          timestamp: hit.timestamp.toISOString(),
          executionContextId: hit.executionContextId,
          message: hit.message,
          payloadRaw: hit.payloadRaw,
          payload: hit.payload,
          level: hit.level ?? 'info',
        })),
        totalCount: hits.length,
        interpolationSupport: true,
      });
    }, { operation: 'get logpoint hits' });
  }

  async clearLogpointHits() {
    return withErrorHandling(() => {
      this.dapClient.clearLogpointHits();

      return Promise.resolve({ message: 'Logpoint hits cleared successfully' });
    }, { operation: 'clear logpoint hits' });
  }

  async getDebuggerEvents() {
    return withErrorHandling(() => {
      const events = this.dapClient.getDebuggerEvents();

      return Promise.resolve({
        events: events.map(event => ({
          timestamp: event.timestamp.toISOString(),
          type: event.type,
          data: event.data,
        })),
        totalCount: events.length,
      });
    }, { operation: 'get debugger events' });
  }

  async clearDebuggerEvents() {
    return withErrorHandling(() => {
      this.dapClient.clearDebuggerEvents();

      return Promise.resolve({ message: 'Debugger events cleared successfully' });
    }, { operation: 'clear debugger events' });
  }

  async resolveOriginalPosition(
    generatedLine: number,
    generatedColumn: number,
    sourceMapPaths?: string[],
    generatedSourcePath?: string,
  ) {
    const originalPosition = await this.sourceMapResolver.resolveOriginalPosition(
      generatedLine,
      generatedColumn,
      sourceMapPaths,
      generatedSourcePath,
    );

    return originalPosition;
  }

  async resolveGeneratedPosition(originalSource: string, originalLine: number, originalColumn: number, sourceMapPaths?: string[], originalSourcePath?: string) {
    const generatedPosition = await this.sourceMapResolver.resolveGeneratedPosition(
      originalSource,
      originalLine,
      originalColumn,
      sourceMapPaths,
      originalSourcePath,
    );

    return generatedPosition;
  }

  // New DAP methods for complete protocol coverage

  async setBreakpoints(source: { path: string }, breakpoints?: Array<{ line: number; column?: number | undefined; condition?: string | undefined; logMessage?: string | undefined }>, lines?: number[]) {
    return withErrorHandling(async () => {
      const absolutePath = resolve(source.path);
      // Convert parameters to DAP format
      const breakpointsArgs: DebugProtocol.SetBreakpointsArguments = {
        source: {
          name: relative(this.findProjectRoot(), absolutePath),
          path: absolutePath,
        },
        ...(lines !== undefined ? { lines } : {}),
        ...(breakpoints !== undefined
          ? {
            breakpoints: breakpoints.map(bp => ({
              line: bp.line,
              ...(bp.column !== undefined ? { column: bp.column } : {}),
              ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
              ...(bp.logMessage !== undefined ? { logMessage: bp.logMessage } : {}),
            })),
          }
          : {}),
      };
      const response = await this.dapClient.dapRequest<DebugProtocol.SetBreakpointsResponse>(
        'setBreakpoints',
        breakpointsArgs,
      );

      if (!response.success) {
        throw new Error("Failed to set breakpoints");
      }

      // Track all breakpoints that were successfully created. Both shapes
      // (`breakpoints` rich form and `lines` shorthand) need tracking so
      // getBreakpoints() lists them; the previous code skipped the lines case.
      interface TrackedSourceItem {
        line: number;
        column?: number | undefined;
        condition?: string | undefined;
        logMessage?: string | undefined;
      }

      const trackedSource: TrackedSourceItem[] | undefined = breakpoints
        ?? lines?.map((line): TrackedSourceItem => ({ line }));

      if (trackedSource) {
        response.body.breakpoints.forEach((actualBreakpoint, index) => {
          const bp = trackedSource[index];

          if (actualBreakpoint.id && bp) {
            this.dapClient.addTrackedBreakpoint({
              breakpointId: actualBreakpoint.id,
              type: bp.logMessage ? 'logpoint' : 'breakpoint',
              originalRequest: {
                filePath: absolutePath,
                lineNumber: bp.line,
                // MCP/DAP coordinates are 1-based; default the column to 1 so
                // tracking matches the adapter (nodejs-debug-adapter:805) and
                // SourceMapResolver, which reject column < 1.
                columnNumber: bp.column ?? 1,
                condition: bp.condition,
                logMessage: bp.logMessage,
              },
              actualLocation: {
                lineNumber: actualBreakpoint.line ?? bp.line,
                columnNumber: actualBreakpoint.column ?? (bp.column ?? 1),
              },
              sourceMapResolution: {
                used: false,
              },
              timestamp: new Date(),
            });
          }
        });
      }

      return {
        breakpoints: response.body.breakpoints,
        source: source.path,
      };
    }, { operation: 'set breakpoints', source: source.path, count: breakpoints?.length ?? lines?.length });
  }

  async getBreakpoints() {
    return withErrorHandling(async () => {
      const trackedBreakpoints = this.dapClient.getTrackedBreakpoints();

      return {
        totalCount: trackedBreakpoints.length,
        breakpoints: trackedBreakpoints,
        recommendation: "DAP breakpoints with native source map support",
      };
    }, { operation: 'get breakpoints' });
  }

  async stackTrace(threadId?: number, startFrame?: number, levels?: number, options: TruncationOptions = {}) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.StackTraceResponse>(
        'stackTrace',
        {
          threadId: threadId ?? 1,
          startFrame: startFrame ?? 0,
          levels,
        },
      );

      if (!response.success) {
        throw new Error("Failed to get stack trace");
      }

      const { result, truncated } = this.truncateResult(response.body, options);

      return {
        stackFrames: (result as DebugProtocol.StackTraceResponse['body']).stackFrames,
        totalFrames: (result as DebugProtocol.StackTraceResponse['body']).totalFrames,
        truncated,
      };
    }, { operation: 'get stack trace', threadId, startFrame, levels });
  }

  async variables(variablesReference: number, filter?: 'indexed' | 'named', start?: number, count?: number, options: TruncationOptions = {}) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.VariablesResponse>(
        'variables',
        {
          variablesReference,
          filter,
          start,
          count,
        },
      );

      if (!response.success) {
        throw new Error("Failed to get variables");
      }

      const { result, truncated } = this.truncateResult(response.body, options);

      return {
        variables: (result as DebugProtocol.VariablesResponse['body']).variables,
        truncated,
      };
    }, { operation: 'get variables', variablesReference, filter, start, count });
  }

  async threads() {
    return this.dapTypedRequest<DebugProtocol.ThreadsResponse, { threads: DebugProtocol.Thread[] }>(
      'threads',
      undefined,
      'get threads',
      {},
      (body) => ({ threads: body.threads }),
    );
  }

  async scopes(frameId: number) {
    return this.dapTypedRequest<DebugProtocol.ScopesResponse, { scopes: DebugProtocol.Scope[] }>(
      'scopes',
      { frameId },
      'get scopes',
      { frameId },
      (body) => ({ scopes: body.scopes }),
    );
  }

  async setVariable(variablesReference: number, name: string, value: string) {
    return this.dapTypedRequest<DebugProtocol.SetVariableResponse, {
      value: string;
      type: string | undefined;
      variablesReference: number | undefined;
    }>(
      'setVariable',
      { variablesReference, name, value },
      'set variable',
      { variablesReference, name, value },
      (body) => ({
        value: body.value,
        type: body.type,
        variablesReference: body.variablesReference,
      }),
    );
  }

  async launch(args: { program: string; args?: string[] | undefined; cwd?: string | undefined; env?: Record<string, string> | undefined }) {
    return this.dapTypedRequest<DebugProtocol.LaunchResponse, { launched: true; program: string }>(
      'launch',
      args,
      'launch',
      { program: args.program },
      () => ({ launched: true, program: args.program }),
    );
  }

  async terminate() {
    return this.dapTypedRequest<DebugProtocol.TerminateResponse, { terminated: true }>(
      'terminate',
      undefined,
      'terminate',
      {},
      () => ({ terminated: true }),
    );
  }

  async restart() {
    return this.dapTypedRequest<DebugProtocol.RestartResponse, { restarted: true }>(
      'restart',
      undefined,
      'restart',
      {},
      () => ({ restarted: true }),
    );
  }

  async loadedSources() {
    return this.dapTypedRequest<DebugProtocol.LoadedSourcesResponse, { sources: DebugProtocol.Source[] }>(
      'loadedSources',
      undefined,
      'get loaded sources',
      {},
      (body) => ({ sources: body.sources }),
    );
  }

  async exceptionInfo(threadId: number) {
    return this.dapTypedRequest<DebugProtocol.ExceptionInfoResponse, {
      exceptionId: string;
      description: string | undefined;
      breakMode: DebugProtocol.ExceptionBreakMode;
      details: DebugProtocol.ExceptionDetails | undefined;
    }>(
      'exceptionInfo',
      { threadId },
      'get exception info',
      { threadId },
      (body) => ({
        exceptionId: body.exceptionId,
        description: body.description,
        breakMode: body.breakMode,
        details: body.details,
      }),
    );
  }

  async setExceptionBreakpoints(filters: string[], exceptionOptions?: Array<{ filterId: string; condition?: string | undefined }>) {
    return this.dapTypedRequest<DebugProtocol.SetExceptionBreakpointsResponse, {
      breakpoints: DebugProtocol.Breakpoint[];
    }>(
      'setExceptionBreakpoints',
      { filters, exceptionOptions },
      'set exception breakpoints',
      { filters },
      (body) => ({ breakpoints: body?.breakpoints ?? [] }),
    );
  }

  async breakpointLocations(source: { path: string }, line: number, column?: number, endLine?: number, endColumn?: number) {
    return this.dapTypedRequest<DebugProtocol.BreakpointLocationsResponse, {
      breakpoints: DebugProtocol.BreakpointLocation[];
    }>(
      'breakpointLocations',
      { source, line, column, endLine, endColumn },
      'get breakpoint locations',
      { source: source.path, line },
      (body) => ({ breakpoints: body.breakpoints }),
    );
  }

  async goto(threadId: number, targetId: number) {
    return this.dapTypedRequest<DebugProtocol.GotoResponse, {
      success: true;
      threadId: number;
      targetId: number;
    }>(
      'goto',
      { threadId, targetId },
      'goto',
      { threadId, targetId },
      () => ({ success: true, threadId, targetId }),
    );
  }

  async restartFrame(frameId: number) {
    return this.dapTypedRequest<DebugProtocol.RestartFrameResponse, { success: true; frameId: number }>(
      'restartFrame',
      { frameId },
      'restart frame',
      { frameId },
      () => ({ success: true, frameId }),
    );
  }
}
