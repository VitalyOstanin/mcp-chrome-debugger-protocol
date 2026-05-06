import type { DAPClient } from "./dap-client.js";
import type { TruncationOptions } from "./types.js";
import { findProjectRoot, withErrorHandling } from "./utils.js";
import { DEFAULTS } from "./constants.js";
import type { DebugProtocol } from '@vscode/debugprotocol';
import { resolve, relative } from "node:path";
import { SourceMapResolver } from "./source-map-resolver.js";

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
    // Final length check. Cache the serialised forms so the fallback branch does not
    // re-serialise twice (originalSize + preview); previously evaluate / stackTrace /
    // variables paid up to 3x JSON.stringify on large payloads.
    const jsonString = JSON.stringify(result, null, 2);

    if (jsonString.length > maxLength) {
      const originalJson = JSON.stringify(data, null, 2);

      return {
        result: {
          error: 'Response too large',
          preview: `${jsonString.substring(0, previewBudget)}...`,
          originalSize: originalJson.length,
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

  // DAP-standard execution control. Each method delegates to the adapter via dapRequest;
  // duplicated legacy aliases (resume/stepInto/stepOver) have been removed.
  async continue(threadId?: number) {
    const effectiveThreadId = threadId ?? 1;

    return withErrorHandling(async () => {
      await this.dapClient.dapRequest('continue', { threadId: effectiveThreadId });

      return { threadId: effectiveThreadId, message: 'Execution continued' };
    }, { operation: 'continue execution', threadId: effectiveThreadId });
  }

  async pause(threadId?: number) {
    const effectiveThreadId = threadId ?? 1;

    return withErrorHandling(async () => {
      await this.dapClient.dapRequest('pause', { threadId: effectiveThreadId });

      return { threadId: effectiveThreadId, message: 'Execution paused' };
    }, { operation: 'pause execution', threadId: effectiveThreadId });
  }

  async next(threadId?: number) {
    const effectiveThreadId = threadId ?? 1;

    return withErrorHandling(async () => {
      await this.dapClient.dapRequest('next', { threadId: effectiveThreadId });

      return { threadId: effectiveThreadId, message: 'Stepped over' };
    }, { operation: 'step over', threadId: effectiveThreadId });
  }

  async stepIn(threadId?: number) {
    const effectiveThreadId = threadId ?? 1;

    return withErrorHandling(async () => {
      await this.dapClient.dapRequest('stepIn', { threadId: effectiveThreadId });

      return { threadId: effectiveThreadId, message: 'Stepped into' };
    }, { operation: 'step into', threadId: effectiveThreadId });
  }

  async stepOut(threadId?: number) {
    const effectiveThreadId = threadId ?? 1;

    return withErrorHandling(async () => {
      await this.dapClient.dapRequest('stepOut', { threadId: effectiveThreadId });

      return { threadId: effectiveThreadId, message: 'Stepped out' };
    }, { operation: 'step out', threadId: effectiveThreadId });
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

  async resolveOriginalPosition(generatedLine: number, generatedColumn: number, sourceMapPaths?: string[]) {
    const originalPosition = await this.sourceMapResolver.resolveOriginalPosition(generatedLine, generatedColumn, sourceMapPaths);

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
                columnNumber: bp.column ?? 0,
                condition: bp.condition,
                logMessage: bp.logMessage,
              },
              actualLocation: {
                lineNumber: actualBreakpoint.line ?? bp.line,
                columnNumber: actualBreakpoint.column ?? (bp.column ?? 0),
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
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.ThreadsResponse>(
        'threads',
      );

      if (!response.success) {
        throw new Error("Failed to get threads");
      }

      return {
        threads: response.body.threads,
      };
    }, { operation: 'get threads' });
  }

  async scopes(frameId: number) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.ScopesResponse>(
        'scopes',
        { frameId },
      );

      if (!response.success) {
        throw new Error("Failed to get scopes");
      }

      return {
        scopes: response.body.scopes,
      };
    }, { operation: 'get scopes', frameId });
  }

  async setVariable(variablesReference: number, name: string, value: string) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.SetVariableResponse>(
        'setVariable',
        {
          variablesReference,
          name,
          value,
        },
      );

      if (!response.success) {
        throw new Error("Failed to set variable");
      }

      return {
        value: response.body.value,
        type: response.body.type,
        variablesReference: response.body.variablesReference,
      };
    }, { operation: 'set variable', variablesReference, name, value });
  }

  async launch(args: { program: string; args?: string[] | undefined; cwd?: string | undefined; env?: Record<string, string> | undefined }) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.LaunchResponse>(
        'launch',
        args,
      );

      if (!response.success) {
        throw new Error("Failed to launch program");
      }

      return {
        launched: true,
        program: args.program,
      };
    }, { operation: 'launch', program: args.program });
  }

  async terminate() {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.TerminateResponse>(
        'terminate',
      );

      if (!response.success) {
        throw new Error("Failed to terminate");
      }

      return {
        terminated: true,
      };
    }, { operation: 'terminate' });
  }

  async restart() {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.RestartResponse>(
        'restart',
      );

      if (!response.success) {
        throw new Error("Failed to restart");
      }

      return {
        restarted: true,
      };
    }, { operation: 'restart' });
  }

  async loadedSources() {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.LoadedSourcesResponse>(
        'loadedSources',
      );

      if (!response.success) {
        throw new Error("Failed to get loaded sources");
      }

      return {
        sources: response.body.sources,
      };
    }, { operation: 'get loaded sources' });
  }

  async exceptionInfo(threadId: number) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.ExceptionInfoResponse>(
        'exceptionInfo',
        { threadId },
      );

      if (!response.success) {
        throw new Error("Failed to get exception info");
      }

      const { exceptionId, description, breakMode, details } = response.body;

      return {
        exceptionId,
        description,
        breakMode,
        details,
      };
    }, { operation: 'get exception info', threadId });
  }

  async setExceptionBreakpoints(filters: string[], exceptionOptions?: Array<{ filterId: string; condition?: string | undefined }>) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.SetExceptionBreakpointsResponse>(
        'setExceptionBreakpoints',
        {
          filters,
          exceptionOptions,
        },
      );

      if (!response.success) {
        throw new Error("Failed to set exception breakpoints");
      }

      return {
        breakpoints: response.body?.breakpoints ?? [],
      };
    }, { operation: 'set exception breakpoints', filters });
  }

  async breakpointLocations(source: { path: string }, line: number, column?: number, endLine?: number, endColumn?: number) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.BreakpointLocationsResponse>(
        'breakpointLocations',
        {
          source,
          line,
          column,
          endLine,
          endColumn,
        },
      );

      if (!response.success) {
        throw new Error("Failed to get breakpoint locations");
      }

      return {
        breakpoints: response.body.breakpoints,
      };
    }, { operation: 'get breakpoint locations', source: source.path, line });
  }

  async goto(threadId: number, targetId: number) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.GotoResponse>(
        'goto',
        {
          threadId,
          targetId,
        },
      );

      if (!response.success) {
        throw new Error("Failed to goto target");
      }

      return {
        success: true,
        threadId,
        targetId,
      };
    }, { operation: 'goto', threadId, targetId });
  }

  async restartFrame(frameId: number) {
    return withErrorHandling(async () => {
      const response = await this.dapClient.dapRequest<DebugProtocol.RestartFrameResponse>(
        'restartFrame',
        { frameId },
      );

      if (!response.success) {
        throw new Error("Failed to restart frame");
      }

      return {
        success: true,
        frameId,
      };
    }, { operation: 'restart frame', frameId });
  }
}
