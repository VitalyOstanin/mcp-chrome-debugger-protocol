import type { DAPClient } from "./dap-client.js";
import type { TruncationOptions } from "./types.js";
import { withErrorHandling } from "./utils.js";
import type { DebugProtocol } from '@vscode/debugprotocol';
import { existsSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { SourceMapResolver } from "./source-map-resolver.js";

export class DAPDebuggerManager {
  private readonly sourceMapResolver = new SourceMapResolver();

  constructor(private readonly dapClient: DAPClient) {}

  private createStandardResponse(successMessage: string, errorMessage: string) {
    return {
      success: (result?: unknown, additionalData?: Record<string, unknown>) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: successMessage,
              ...(additionalData ?? {}),
            }),
          },
        ],
      }),
      error: (error: unknown) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: errorMessage,
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      }),
    };
  }

  private truncateResult(data: unknown, options: TruncationOptions = {}): { result: unknown; truncated: boolean } {
    const {
      maxLength = 20000,
      maxDepth = 10,
      maxArrayItems = 50,
      maxObjectKeys = 50,
      summary = false,
    } = options;
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
        if (value.length > maxLength / 4) {
          truncated = true;

          return `${value.substring(0, maxLength / 4)}... [${value.length - maxLength / 4} more chars]`;
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
    // Final length check
    const jsonString = JSON.stringify(result, null, 2);

    if (jsonString.length > maxLength) {
      truncated = true;

      return {
        result: {
          error: 'Response too large',
          preview: `${JSON.stringify(result, null, 2).substring(0, maxLength / 2)}...`,
          originalSize: JSON.stringify(data, null, 2).length,
          truncatedSize: jsonString.length,
        },
        truncated: true,
      };
    }

    return { result, truncated };
  }

  private findProjectRoot(): string {
    let currentDir = process.cwd();

    while (currentDir !== dirname(currentDir)) {
      if (existsSync(join(currentDir, 'package.json'))) {
        return currentDir;
      }
      currentDir = dirname(currentDir);
    }

    return process.cwd();
  }

  private getRelativePath(absolutePath: string): string {
    const projectRoot = this.findProjectRoot();

    return relative(projectRoot, absolutePath);
  }

  async setBreakpoint(filePath: string, lineNumber: number, columnNumber: number, condition?: string) {
    return withErrorHandling(async () => {
      // Resolve absolute path
      const absolutePath = resolve(filePath);
      // Create DAP setBreakpoints request
      const breakpointsArgs: DebugProtocol.SetBreakpointsArguments = {
        source: {
          name: relative(this.findProjectRoot(), absolutePath),
          path: absolutePath,
        },
        lines: [lineNumber],
        breakpoints: [{
          line: lineNumber,
          column: columnNumber,
          condition,
        }],
      };
      const response = await this.dapClient.dapRequest<DebugProtocol.SetBreakpointsResponse>(
        'setBreakpoints',
        breakpointsArgs,
      );

      if (!(response.success && response.body.breakpoints[0])) {
        throw new Error("Failed to set breakpoint");
      }

      const actualBreakpoint = response.body.breakpoints[0];

      // Track the breakpoint
      this.dapClient.addTrackedBreakpoint({
        breakpointId: actualBreakpoint.id!,
        type: 'breakpoint',
        originalRequest: {
          filePath: absolutePath,
          lineNumber,
          columnNumber,
          condition,
        },
        actualLocation: {
          scriptId: undefined, // DAP doesn't use scriptId
          lineNumber: actualBreakpoint.line ?? lineNumber,
          columnNumber: actualBreakpoint.column ?? columnNumber,
        },
        sourceMapResolution: {
          used: false, // DAP handles source maps internally
        },
        timestamp: new Date(),
      });

      return {
        breakpointId: actualBreakpoint.id!,
        actualLocation: {
          lineNumber: actualBreakpoint.line ?? lineNumber,
          columnNumber: actualBreakpoint.column ?? columnNumber,
        },
        originalRequest: {
          filePath: absolutePath,
          lineNumber,
          columnNumber,
          condition,
        },
        sourceMapResolution: {
          used: false,
        },
        verified: actualBreakpoint.verified,
      };
    }, { operation: 'set breakpoint', filePath, lineNumber, columnNumber, condition });
  }

  async setLogpoint(filePath: string, lineNumber: number, columnNumber: number, logMessage: string) {
    return withErrorHandling(async () => {
      // Resolve absolute path
      const absolutePath = resolve(filePath);
      // Create DAP setBreakpoints request with logMessage (this is the key feature!)
      const breakpointsArgs: DebugProtocol.SetBreakpointsArguments = {
        source: {
          name: relative(this.findProjectRoot(), absolutePath),
          path: absolutePath,
        },
        lines: [lineNumber],
        breakpoints: [{
          line: lineNumber,
          column: columnNumber,
          logMessage, // This enables variable interpolation with {variable} syntax!
        }],
      };
      const response = await this.dapClient.dapRequest<DebugProtocol.SetBreakpointsResponse>(
        'setBreakpoints',
        breakpointsArgs,
      );

      if (!(response.success && response.body.breakpoints[0])) {
        throw new Error("Failed to set logpoint");
      }

      const actualBreakpoint = response.body.breakpoints[0];

      // Track the logpoint
      this.dapClient.addTrackedBreakpoint({
        breakpointId: actualBreakpoint.id!,
        type: 'logpoint',
        originalRequest: {
          filePath: absolutePath,
          lineNumber,
          columnNumber,
          logMessage,
        },
        actualLocation: {
          scriptId: undefined,
          lineNumber: actualBreakpoint.line ?? lineNumber,
          columnNumber: actualBreakpoint.column ?? columnNumber,
        },
        sourceMapResolution: {
          used: false,
        },
        timestamp: new Date(),
      });

      return {
        breakpointId: actualBreakpoint.id!,
        actualLocation: {
          lineNumber: actualBreakpoint.line ?? lineNumber,
          columnNumber: actualBreakpoint.column ?? columnNumber,
        },
        originalRequest: {
          filePath: absolutePath,
          lineNumber,
          columnNumber,
          logMessage,
        },
        logMessage,
        type: "logpoint",
        sourceMapResolution: {
          used: false,
          reason: "DAP handles source maps and variable interpolation internally",
        },
        verified: actualBreakpoint.verified,
        interpolationSupport: true, // Key feature - DAP supports {variable} interpolation!
      };
    }, { operation: 'set logpoint', filePath, lineNumber, columnNumber, logMessage });
  }

  async removeBreakpoint(breakpointId: number) {
    return withErrorHandling(async () => {
      // Find the tracked breakpoint to get source info
      const trackedBreakpoint = this.dapClient.getTrackedBreakpoints()
        .find(bp => bp.breakpointId === breakpointId);

      if (!trackedBreakpoint) {
        throw new Error(`Breakpoint ${breakpointId} not found`);
      }

      // Remove by setting empty breakpoints list for the source
      const breakpointsArgs: DebugProtocol.SetBreakpointsArguments = {
        source: {
          name: relative(this.findProjectRoot(), trackedBreakpoint.originalRequest.filePath),
          path: trackedBreakpoint.originalRequest.filePath,
        },
        lines: [],
        breakpoints: [],
      };

      await this.dapClient.dapRequest('setBreakpoints', breakpointsArgs);

      // Remove from tracking
      this.dapClient.removeTrackedBreakpoint(breakpointId);

      return {
        breakpointId,
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

  async resume() {
    const responseFactory = this.createStandardResponse(
      "Execution resumed",
      "Failed to resume execution",
    );

    try {
      await this.dapClient.dapRequest('continue', { threadId: 1 });

      return responseFactory.success();
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  // DAP standard name for resume
  async continue(threadId?: number) {
    const responseFactory = this.createStandardResponse(
      "Execution continued",
      "Failed to continue execution",
    );

    try {
      await this.dapClient.dapRequest('continue', { threadId: threadId ?? 1 });

      return responseFactory.success(undefined, { threadId: threadId ?? 1 });
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  async pause() {
    const responseFactory = this.createStandardResponse(
      "Execution paused",
      "Failed to pause execution",
    );

    try {
      await this.dapClient.dapRequest('pause', { threadId: 1 });

      return responseFactory.success();
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  async stepOver() {
    const responseFactory = this.createStandardResponse(
      "Stepped over",
      "Failed to step over",
    );

    try {
      await this.dapClient.dapRequest('next', { threadId: 1 });

      return responseFactory.success();
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  async stepInto() {
    const responseFactory = this.createStandardResponse(
      "Stepped into",
      "Failed to step into",
    );

    try {
      await this.dapClient.dapRequest('stepIn', { threadId: 1 });

      return responseFactory.success();
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  async stepOut() {
    const responseFactory = this.createStandardResponse(
      "Stepped out",
      "Failed to step out",
    );

    try {
      await this.dapClient.dapRequest('stepOut', { threadId: 1 });

      return responseFactory.success();
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  // DAP standard names for step operations
  async next(threadId?: number) {
    const responseFactory = this.createStandardResponse(
      "Stepped over (next)",
      "Failed to step over (next)",
    );

    try {
      await this.dapClient.dapRequest('next', { threadId: threadId ?? 1 });

      return responseFactory.success(undefined, { threadId: threadId ?? 1 });
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  async stepIn(threadId?: number) {
    const responseFactory = this.createStandardResponse(
      "Stepped into",
      "Failed to step into",
    );

    try {
      await this.dapClient.dapRequest('stepIn', { threadId: threadId ?? 1 });

      return responseFactory.success(undefined, { threadId: threadId ?? 1 });
    } catch (error) {
      return responseFactory.error(error);
    }
  }

  async evaluate(expression: string, callFrameId?: string, options: TruncationOptions = {}) {
    const response = await this.dapClient.dapRequest<DebugProtocol.EvaluateResponse>(
      'evaluate',
      {
        expression,
        frameId: callFrameId ? parseInt(callFrameId, 10) : undefined,
        context: 'repl',
      },
    );
    const { result: truncatedResult, truncated } = this.truncateResult(response.body, options);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            result: truncatedResult,
            ...(truncated && {
              meta: {
                truncated: true,
                message: "Response was truncated due to size limits",
              },
            }),
          }, null, 2),
        },
      ],
    };
  }

  async getCallStack(options: TruncationOptions = {}) {
    try {
      // Get threads first
      const threadsResponse = await this.dapClient.dapRequest<DebugProtocol.ThreadsResponse>('threads', {});

      if (!(threadsResponse.success && threadsResponse.body.threads.length)) {
        throw new Error('No threads available');
      }

      const threadId = threadsResponse.body.threads[0].id;
      // Get stack trace
      const stackResponse = await this.dapClient.dapRequest<DebugProtocol.StackTraceResponse>(
        'stackTrace',
        {
          threadId,
          startFrame: 0,
          levels: 20,
        },
      );
      const { result: truncatedResult, truncated } = this.truncateResult(stackResponse.body, options);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: truncatedResult,
              ...(truncated && {
                meta: {
                  truncated: true,
                  message: "Call stack was truncated due to size limits",
                },
              }),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: [],
              message: "No call stack available",
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    }
  }

  async getScopeVariables(callFrameId: string, options: TruncationOptions = {}) {
    try {
      const frameId = parseInt(callFrameId, 10);
      // Get scopes for the frame
      const scopesResponse = await this.dapClient.dapRequest<DebugProtocol.ScopesResponse>(
        'scopes',
        { frameId },
      );

      if (!(scopesResponse.success && scopesResponse.body.scopes.length)) {
        throw new Error('No scopes available');
      }

      // Get variables from the first scope (usually local scope)
      const variablesResponse = await this.dapClient.dapRequest<DebugProtocol.VariablesResponse>(
        'variables',
        { variablesReference: scopesResponse.body.scopes[0].variablesReference },
      );
      const { result: truncatedResult, truncated } = this.truncateResult(variablesResponse.body, options);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: truncatedResult,
              ...(truncated && {
                meta: {
                  truncated: true,
                  message: "Scope variables were truncated due to size limits",
                },
              }),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Failed to get scope variables",
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    }
  }

  async getLogpointHits() {
    try {
      const hits = this.dapClient.getLogpointHits();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
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
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Failed to get logpoint hits",
              message: error instanceof Error ? error.message : String(error),
              hits: [],
              totalCount: 0,
            }),
          },
        ],
      };
    }
  }

  async clearLogpointHits() {
    try {
      this.dapClient.clearLogpointHits();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Logpoint hits cleared successfully",
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Failed to clear logpoint hits",
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    }
  }

  async getDebuggerEvents() {
    try {
      const events = this.dapClient.getDebuggerEvents();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              events: events.map(event => ({
                timestamp: event.timestamp.toISOString(),
                type: event.type,
                data: event.data,
              })),
              totalCount: events.length,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Failed to get debugger events",
              message: error instanceof Error ? error.message : String(error),
              events: [],
              totalCount: 0,
            }),
          },
        ],
      };
    }
  }

  async clearDebuggerEvents() {
    try {
      this.dapClient.clearDebuggerEvents();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Debugger events cleared successfully",
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Failed to clear debugger events",
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    }
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

  async setBreakpoints(source: { path: string }, breakpoints?: Array<{ line: number; column?: number; condition?: string; logMessage?: string }>, lines?: number[]) {
    return withErrorHandling(async () => {
      const absolutePath = resolve(source.path);
      // Convert parameters to DAP format
      const breakpointsArgs: DebugProtocol.SetBreakpointsArguments = {
        source: {
          name: relative(this.findProjectRoot(), absolutePath),
          path: absolutePath,
        },
        lines,
        breakpoints: breakpoints?.map(bp => ({
          line: bp.line,
          column: bp.column,
          condition: bp.condition,
          logMessage: bp.logMessage,
        })),
      };
      const response = await this.dapClient.dapRequest<DebugProtocol.SetBreakpointsResponse>(
        'setBreakpoints',
        breakpointsArgs,
      );

      if (!response.success) {
        throw new Error("Failed to set breakpoints");
      }

      // Track all breakpoints that were successfully created
      if (breakpoints) {
        response.body.breakpoints.forEach((actualBreakpoint, index) => {
          if (actualBreakpoint.id && breakpoints[index]) {
            const bp = breakpoints[index];

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

  async launch(args: { program: string; args?: string[]; cwd?: string; env?: Record<string, string> }) {
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

  async setExceptionBreakpoints(filters: string[], exceptionOptions?: Array<{ filterId: string; condition?: string }>) {
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
