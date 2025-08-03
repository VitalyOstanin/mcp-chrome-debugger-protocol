import { CDPClient } from "./cdp-client.js";
import { TruncationOptions } from "./types.js";
import { createSuccessResponse, createErrorResponse, withErrorHandling, getSourceCodeContext } from "./utils.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { execSync } from "node:child_process";
import { TraceMap, originalPositionFor, generatedPositionFor, sourceContentFor, LEAST_UPPER_BOUND } from "@jridgewell/trace-mapping";
import { SourceMapResolver } from "./source-map-resolver.js";

export class DebuggerManager {
  private sourceMapResolver = new SourceMapResolver();

  constructor(private cdpClient: CDPClient) {}

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

          return `${value.substring(0, maxLength / 4)  }... [${value.length - maxLength / 4} more chars]`;
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
            truncateValue(item, currentDepth + 1)
          );

          truncatedArray.push(`[... and ${value.length - maxArrayItems} more items]`);

          return truncatedArray;
        }

        return value.map(item => truncateValue(item, currentDepth + 1));
      }

      if (typeof value === 'object' && value !== null) {
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
          preview: `${JSON.stringify(result, null, 2).substring(0, maxLength / 2)  }...`,
          originalSize: JSON.stringify(data, null, 2).length,
          truncatedSize: jsonString.length,
        },
        truncated: true,
      };
    }

    return { result, truncated };
  }



  private get client() {
    if (!this.cdpClient.client) {
      throw new Error("Not connected to debugger");
    }

    return this.cdpClient.client;
  }

  // Helper method to create consistent responses
  private createResponse(data: unknown) {
    return createSuccessResponse(data);
  }

  private createErrorResponseHelper(error: string, details?: Record<string, unknown>) {
    return createErrorResponse(error, JSON.stringify(details));
  }


  async setBreakpoint(filePath: string, lineNumber: number, columnNumber: number, condition?: string) {
    return withErrorHandling(async () => {
      // Resolve source map position using the extracted resolver
      const resolution = await this.sourceMapResolver.resolveSourceMapPosition(filePath, lineNumber, columnNumber);
      const { targetFilePath, targetLineNumber, targetColumnNumber, sourceMapInfo } = resolution;

      // Use file:// URL format like in the working script
      const fileUrl = `file://${targetFilePath}`;

      const result = await this.client.Debugger.setBreakpointByUrl({
        url: fileUrl,
        lineNumber: targetLineNumber - 1, // CDP uses 0-based indexing
        columnNumber: targetColumnNumber,
        condition,
      });

      if (!result.breakpointId) {
        throw new Error("Failed to get breakpoint ID from CDP response");
      }

      // Get source code context for the original request location
      const sourceContext = await getSourceCodeContext(
        filePath,
        lineNumber,
        columnNumber,
        {
          useSourceMaps: true,
          sourceMapResolver: this.sourceMapResolver,
          markerType: 'breakpoint'
        }
      );

      const breakpointData = {
        breakpointId: result.breakpointId,
        actualLocation: {
          scriptId: result.locations?.[0]?.scriptId,
          lineNumber: (result.locations?.[0]?.lineNumber ?? (targetLineNumber - 1)) + 1, // Convert back to 1-based
          columnNumber: result.locations?.[0]?.columnNumber ?? targetColumnNumber
        },
        originalRequest: {
          filePath,
          lineNumber,
          columnNumber,
          condition
        },
        sourceMapResolution: sourceMapInfo.success ? {
          used: true,
          sourceMapFile: sourceMapInfo.sourceMapUsed,
          matchedSource: sourceMapInfo.matchedSource,
          targetFile: targetFilePath,
          targetLocation: {
            lineNumber: targetLineNumber,
            columnNumber: targetColumnNumber
          }
        } : {
          used: false,
          reason: "No source map resolution needed or available"
        },
        sourceContext: sourceContext ? {
          filePath: sourceContext.filePath,
          targetLine: sourceContext.targetLine,
          lines: sourceContext.lines,
          recommendation: sourceContext.recommendation
        } : null
      };

      // Track the breakpoint
      this.cdpClient.addTrackedBreakpoint({
        breakpointId: result.breakpointId,
        type: 'breakpoint',
        originalRequest: {
          filePath,
          lineNumber,
          columnNumber,
          condition
        },
        actualLocation: {
          scriptId: result.locations?.[0]?.scriptId,
          lineNumber: (result.locations?.[0]?.lineNumber ?? (targetLineNumber - 1)) + 1,
          columnNumber: result.locations?.[0]?.columnNumber ?? targetColumnNumber
        },
        sourceMapResolution: sourceMapInfo.success ? {
          used: true,
          sourceMapFile: sourceMapInfo.sourceMapUsed,
          matchedSource: sourceMapInfo.matchedSource,
          targetFile: targetFilePath,
          targetLocation: {
            lineNumber: targetLineNumber,
            columnNumber: targetColumnNumber
          }
        } : {
          used: false
        },
        timestamp: new Date()
      });

      return breakpointData;
    }, { operation: 'set breakpoint', filePath, lineNumber, columnNumber, condition });
  }

  async setLogpoint(filePath: string, lineNumber: number, columnNumber: number, logMessage: string) {
    return withErrorHandling(async () => {
      let targetFilePath = filePath;
      let targetLineNumber = lineNumber;
      let targetColumnNumber = columnNumber;
      let sourceMapInfo: { success: boolean; sourceMapUsed?: string; matchedSource?: string } = { success: false };

      // Use source map resolver to find the compiled location
      const resolution = await this.sourceMapResolver.resolveSourceMapPosition(filePath, lineNumber, columnNumber);

      if (resolution.sourceMapInfo.success) {
        // Use the compiled JavaScript file path and coordinates from source map resolution
        ({ targetFilePath, targetLineNumber, targetColumnNumber, sourceMapInfo } = resolution);
      } else {
        // Source map resolution failed - this is an error
        if (filePath.endsWith('.js')) {
          // Direct JavaScript file - use it as is (no source mapping needed)
          targetFilePath = filePath;
          targetLineNumber = lineNumber;
          targetColumnNumber = columnNumber;
          sourceMapInfo = { success: false };
        } else {
          // Any non-.js file without successful source map resolution is an error
          throw new Error(`Source map resolution failed for ${filePath}:${lineNumber}:${columnNumber}. Cannot establish logpoint without proper source mapping.`);
        }
      }

      // Use file:// URL format like in the working script
      const fileUrl = `file://${targetFilePath}`;

      // Add universal marker for log capturing
      const markedLogMessage = `LOGPOINT: ${logMessage}`;

      // Convert logpoint message to console.log expression with variable interpolation support
      const logExpression = `console.log('${markedLogMessage}'), false`;

      const result = await this.client.Debugger.setBreakpointByUrl({
        url: fileUrl,
        lineNumber: targetLineNumber - 1, // CDP uses 0-based indexing
        columnNumber: targetColumnNumber,
        condition: logExpression, // Execute log and return false to not break
      });

      if (!result.breakpointId) {
        throw new Error("Failed to get breakpoint ID from CDP response");
      }

      // Get source code context for the original request location
      const sourceContext = await getSourceCodeContext(
        filePath,
        lineNumber,
        columnNumber,
        {
          useSourceMaps: true,
          sourceMapResolver: this.sourceMapResolver,
          markerType: 'logpoint'
        }
      );

      const logpointData = {
        breakpointId: result.breakpointId,
        actualLocation: {
          scriptId: result.locations?.[0]?.scriptId,
          lineNumber: (result.locations?.[0]?.lineNumber ?? (targetLineNumber - 1)) + 1, // Convert back to 1-based
          columnNumber: result.locations?.[0]?.columnNumber ?? targetColumnNumber
        },
        originalRequest: {
          filePath,
          lineNumber,
          columnNumber,
          logMessage
        },
        logMessage: markedLogMessage,
        type: "logpoint",
        sourceMapResolution: sourceMapInfo.success ? {
          used: true,
          sourceMapFile: sourceMapInfo.sourceMapUsed,
          matchedSource: sourceMapInfo.matchedSource,
          targetFile: targetFilePath,
          targetLocation: {
            lineNumber: targetLineNumber,
            columnNumber: targetColumnNumber
          }
        } : {
          used: false,
          reason: "No source map resolution needed or available"
        },
        sourceContext: sourceContext ? {
          filePath: sourceContext.filePath,
          targetLine: sourceContext.targetLine,
          lines: sourceContext.lines,
          recommendation: sourceContext.recommendation
        } : null
      };

      // Track the logpoint
      this.cdpClient.addTrackedBreakpoint({
        breakpointId: result.breakpointId,
        type: 'logpoint',
        originalRequest: {
          filePath,
          lineNumber,
          columnNumber,
          logMessage
        },
        actualLocation: {
          scriptId: result.locations?.[0]?.scriptId,
          lineNumber: (result.locations?.[0]?.lineNumber ?? (targetLineNumber - 1)) + 1,
          columnNumber: result.locations?.[0]?.columnNumber ?? targetColumnNumber
        },
        sourceMapResolution: sourceMapInfo.success ? {
          used: true,
          sourceMapFile: sourceMapInfo.sourceMapUsed,
          matchedSource: sourceMapInfo.matchedSource,
          targetFile: targetFilePath,
          targetLocation: {
            lineNumber: targetLineNumber,
            columnNumber: targetColumnNumber
          }
        } : {
          used: false
        },
        timestamp: new Date()
      });

      return logpointData;
    }, { operation: 'set logpoint', filePath, lineNumber, columnNumber, logMessage });
  }

  async removeBreakpoint(breakpointId: string) {
    return withErrorHandling(async () => {
      await this.client.Debugger.removeBreakpoint({ breakpointId });

      // Remove from tracking
      this.cdpClient.removeTrackedBreakpoint(breakpointId);

      return {
        breakpointId,
        message: "Breakpoint removed successfully"
      };
    }, { operation: 'remove breakpoint', breakpointId });
  }

  async listBreakpoints() {
    return withErrorHandling(async () => {
      const trackedBreakpoints = this.cdpClient.getTrackedBreakpoints();

      // Get source context for each breakpoint
      const breakpointsWithContext = await Promise.all(
        trackedBreakpoints.map(async (breakpoint) => {
          // Get source context for the original request location
          const sourceContext = await getSourceCodeContext(
            breakpoint.originalRequest.filePath,
            breakpoint.originalRequest.lineNumber,
            breakpoint.originalRequest.columnNumber,
            {
              useSourceMaps: true,
              sourceMapResolver: this.sourceMapResolver,
              markerType: breakpoint.type
            }
          );

          return {
            ...breakpoint,
            sourceContext: sourceContext ? {
              filePath: sourceContext.filePath,
              targetLine: sourceContext.targetLine,
              lines: sourceContext.lines,
              recommendation: sourceContext.recommendation
            } : null
          };
        })
      );

      return {
        totalCount: breakpointsWithContext.length,
        breakpoints: breakpointsWithContext,
        recommendation: "Display breakpoints with their source context. Show line numbers and highlight target lines for better user experience."
      };
    }, { operation: 'list breakpoints' });
  }

  async resume() {
    try {
      await this.client.Debugger.resume();

      // Emit resume event to update state immediately
      this.cdpClient.emit('debuggerResumed', {
        type: 'resumed',
        timestamp: new Date(),
        data: {}
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Execution resumed"
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
              error: "Failed to resume execution",
              message: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  async pause() {
    try {
      await this.client.Debugger.pause();

      // Emit pause event to update state immediately
      // This is necessary because CDP pause command doesn't immediately trigger paused event
      // unless there's active JavaScript execution
      this.cdpClient.emit('debuggerPaused', {
        type: 'paused',
        timestamp: new Date(),
        data: { reason: 'pause' }
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Execution paused"
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
              error: "Failed to pause execution",
              message: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  async stepOver() {
    try {
      await this.client.Debugger.stepOver();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Stepped over"
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
              error: "Failed to step over",
              message: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  async stepInto() {
    try {
      await this.client.Debugger.stepInto();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Stepped into"
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
              error: "Failed to step into",
              message: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  async stepOut() {
    try {
      await this.client.Debugger.stepOut();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Stepped out"
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
              error: "Failed to step out",
              message: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  async evaluate(expression: string, callFrameId?: string, options: TruncationOptions = {}) {
    const result = callFrameId
      ? await this.client.Debugger.evaluateOnCallFrame({
          callFrameId,
          expression,
        })
      : await this.client.Runtime.evaluate({ expression });

    const { result: truncatedResult, truncated } = this.truncateResult(result.result, options);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            result: truncatedResult,
            ...(truncated && {
              meta: {
                truncated: true,
                message: "Response was truncated due to size limits"
              }
            }),
          }, null, 2),
        },
      ],
    };
  }

  async getCallStack(options: TruncationOptions = {}) {
    try {
      // Try to get the current call stack using Runtime.evaluate with stack trace
      const result = await this.client.Runtime.evaluate({
        expression: "new Error().stack",
        includeCommandLineAPI: true
      });

      const { result: truncatedResult, truncated } = this.truncateResult(result, options);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: truncatedResult,
              ...(truncated && {
                meta: {
                  truncated: true,
                  message: "Call stack was truncated due to size limits"
                }
              }),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      // If we can't get call stack, return empty result
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: [],
              message: "No call stack available",
              error: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  async getScopeVariables(callFrameId: string, options: TruncationOptions = {}) {
    const result = await this.client.Runtime.getProperties({
      objectId: callFrameId,
    });

    const { result: truncatedResult, truncated } = this.truncateResult(result.result, options);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            result: truncatedResult,
            ...(truncated && {
              meta: {
                truncated: true,
                message: "Scope variables were truncated due to size limits"
              }
            }),
          }, null, 2),
        },
      ],
    };
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

  private findTsConfigPath(startDir: string = process.cwd()): string | null {
    let currentDir = startDir;

    while (currentDir !== dirname(currentDir)) {
      const tsConfigPath = join(currentDir, 'tsconfig.json');

      if (existsSync(tsConfigPath)) {
        return tsConfigPath;
      }
      currentDir = dirname(currentDir);
    }

    return null;
  }

  private getBuildDirectory(): string {
    const tsConfigPath = this.findTsConfigPath();

    if (tsConfigPath) {
      try {
        const tsConfigContent = readFileSync(tsConfigPath, 'utf-8');
        const tsConfig = JSON.parse(tsConfigContent) as {
          compilerOptions?: {
            outDir?: string;
            outFile?: string;
          };
        };

        // Check compilerOptions.outDir
        if (tsConfig.compilerOptions?.outDir) {
          const outDir = resolve(dirname(tsConfigPath), tsConfig.compilerOptions.outDir);

          if (existsSync(outDir)) {
            return outDir;
          }
        }

        // Check compilerOptions.outFile
        if (tsConfig.compilerOptions?.outFile) {
          const outFile = resolve(dirname(tsConfigPath), tsConfig.compilerOptions.outFile);
          const outFileDir = dirname(outFile);

          if (existsSync(outFileDir)) {
            return outFileDir;
          }
        }
      } catch {
        // Silently handle tsconfig parsing errors
      }
    }

    // Fallback: check common build directories
    const commonBuildDirs = ['dist', 'build', 'lib', 'out'];

    for (const dir of commonBuildDirs) {
      const buildPath = resolve(process.cwd(), dir);

      if (existsSync(buildPath)) {
        return buildPath;
      }
    }

    // Final fallback: use current directory
    return process.cwd();
  }


  async getLogpointHits() {
    try {
      const hits = this.cdpClient.getLogpointHits();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              hits: hits.map(hit => ({
                timestamp: hit.timestamp.toISOString(),
                message: hit.message,
                level: hit.level ?? 'info'
              })),
              totalCount: hits.length
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
              totalCount: 0
            }),
          },
        ],
      };
    }
  }

  async clearLogpointHits() {
    try {
      this.cdpClient.clearLogpointHits();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Logpoint hits cleared successfully"
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
              message: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  async getDebuggerEvents() {
    try {
      const events = this.cdpClient.getDebuggerEvents();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              events: events.map(event => ({
                timestamp: event.timestamp.toISOString(),
                type: event.type,
                data: event.data
              })),
              totalCount: events.length
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
              totalCount: 0
            }),
          },
        ],
      };
    }
  }

  async clearDebuggerEvents() {
    try {
      this.cdpClient.clearDebuggerEvents();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Debugger events cleared successfully"
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
              message: error instanceof Error ? error.message : String(error)
            }),
          },
        ],
      };
    }
  }

  private getSourceMapPaths(searchPaths?: string[]): string[] {
    const dirsToSearch = searchPaths && searchPaths.length > 0
      ? searchPaths
      : [this.getBuildDirectory()];

    const sourceMapPaths: string[] = [];

    for (const dir of dirsToSearch) {
      if (!existsSync(dir)) {
        continue;
      }

      try {
        const rgCommand = `rg --files --type-add 'sourcemap:*.map' --type sourcemap "${dir}"`;
        const output = execSync(rgCommand, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const files = output.trim().split('\n').filter(line => line.length > 0);

        sourceMapPaths.push(...files);
      } catch {
        // Fallback to manual search if ripgrep fails
        try {
          const findCommand = `find "${dir}" -name "*.map" -type f`;
          const output = execSync(findCommand, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          const files = output.trim().split('\n').filter(line => line.length > 0);

          sourceMapPaths.push(...files);
        } catch {
          // Ignore errors from find command
        }
      }
    }

    return sourceMapPaths;
  }

  async resolveOriginalPosition(generatedLine: number, generatedColumn: number, sourceMapPaths?: string[]) {
    try {
      const mapPaths = this.getSourceMapPaths(sourceMapPaths);

      if (mapPaths.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "No source map files found",
                searchedPaths: sourceMapPaths ?? [this.getBuildDirectory()],
                generatedPosition: { line: generatedLine, column: generatedColumn }
              }),
            },
          ],
        };
      }

      for (const mapPath of mapPaths) {
        try {
          const sourceMapContent = readFileSync(mapPath, 'utf-8');
          const sourceMapData = JSON.parse(sourceMapContent);
          const tracer = new TraceMap(sourceMapData);

          const originalPos = originalPositionFor(tracer, {
            line: generatedLine,
            column: generatedColumn
          });

          if (originalPos.source !== null) {
            const sourceContent = sourceContentFor(tracer, originalPos.source);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    sourceMapUsed: mapPath,
                    generatedPosition: { line: generatedLine, column: generatedColumn },
                    originalPosition: {
                      source: originalPos.source,
                      line: originalPos.line,
                      column: originalPos.column,
                      name: originalPos.name
                    },
                    sourceContent: sourceContent ?? null
                  }, null, 2),
                },
              ],
            };
          }
        } catch {
          // Continue to next source map if this one fails
          continue;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No mapping found for generated position",
              searchedSourceMaps: mapPaths,
              generatedPosition: { line: generatedLine, column: generatedColumn }
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
              error: "Failed to resolve original position",
              message: error instanceof Error ? error.message : String(error),
              generatedPosition: { line: generatedLine, column: generatedColumn }
            }),
          },
        ],
      };
    }
  }

  async resolveGeneratedPosition(originalSource: string, originalLine: number, originalColumn: number, sourceMapPaths?: string[]) {
    try {
      const mapPaths = this.getSourceMapPaths(sourceMapPaths);

      if (mapPaths.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "No source map files found",
                searchedPaths: sourceMapPaths ?? [this.getBuildDirectory()],
                originalPosition: { source: originalSource, line: originalLine, column: originalColumn }
              }),
            },
          ],
        };
      }

      // Normalize the input source path for better matching
      const normalizedSource = originalSource.replace(/\\/g, '/');
      const sourceBasename = normalizedSource.split('/').pop() ?? '';

      for (const mapPath of mapPaths) {
        try {
          const sourceMapContent = readFileSync(mapPath, 'utf-8');
          const sourceMapData = JSON.parse(sourceMapContent);
          const tracer = new TraceMap(sourceMapData);

          // Try multiple matching strategies for the source
          const candidateSources: string[] = [];

          // Strategy 1: Exact match
          candidateSources.push(originalSource);

          // Strategy 2: Try all sources that end with the same filename
          const {sources} = (sourceMapData as { sources?: string[] });

          if (sources) {
            for (const source of sources) {
              const sourceNormalized = source.replace(/\\/g, '/');

              if (sourceNormalized.endsWith(sourceBasename) || sourceNormalized.includes(normalizedSource)) {
                candidateSources.push(source);
              }
            }
          }

          // Strategy 3: Try partial path matches (e.g., match "publications/deals.controller.ts")
          if (sources) {
            const sourcePathParts = normalizedSource.split('/');

            for (const source of sources) {
              const sourceNormalized = source.replace(/\\/g, '/');
              // Check if the source contains all path segments from the target
              let containsAllParts = true;

              for (let i = sourcePathParts.length - 1; i >= Math.max(0, sourcePathParts.length - 3); i--) {
                if (!sourceNormalized.includes(sourcePathParts[i])) {
                  containsAllParts = false;
                  break;
                }
              }
              if (containsAllParts) {
                candidateSources.push(source);
              }
            }
          }

          // Try each candidate source
          for (const candidateSource of candidateSources) {
            // First try exact column match
            let generatedPos = generatedPositionFor(tracer, {
              source: candidateSource,
              line: originalLine,
              column: originalColumn
            });

            // If exact match fails and we're looking for column 0, try with bias to find nearest mapping
            if ((generatedPos.line === null || generatedPos.column === null) && originalColumn === 0) {
              // LEAST_UPPER_BOUND (-1) finds the first mapping at or after the requested position
              generatedPos = generatedPositionFor(tracer, {
                source: candidateSource,
                line: originalLine,
                column: originalColumn,
                bias: LEAST_UPPER_BOUND
              });
            }

            if (generatedPos.line !== null && generatedPos.column !== null) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      sourceMapUsed: mapPath,
                      matchedSource: candidateSource,
                      originalPosition: { source: originalSource, line: originalLine, column: originalColumn },
                      generatedPosition: {
                        line: generatedPos.line,
                        column: generatedPos.column
                      }
                    }, null, 2),
                  },
                ],
              };
            }
          }
        } catch {
          // Continue to next source map if this one fails
          continue;
        }
      }

      // Collect information about available sources for debugging
      const availableSources: Array<{ sourceMap: string; sources: string[] }> = [];

      for (const mapPath of mapPaths) {
        try {
          const sourceMapContent = readFileSync(mapPath, 'utf-8');
          const sourceMapData = JSON.parse(sourceMapContent) as {
            sources?: string[];
            [key: string]: unknown;
          };

          availableSources.push({
            sourceMap: mapPath,
            sources: sourceMapData.sources ?? []
          });
        } catch {
          // Skip maps that can't be read
          continue;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No mapping found for original position",
              searchedSourceMaps: mapPaths,
              originalPosition: { source: originalSource, line: originalLine, column: originalColumn },
              availableSources,
              suggestions: [
                "Check if the source path matches any of the sources listed above",
                "Try using just the filename (e.g., 'deals.controller.ts') instead of full path",
                "Verify the line number exists in the original source file"
              ]
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
              error: "Failed to resolve generated position",
              message: error instanceof Error ? error.message : String(error),
              originalPosition: { source: originalSource, line: originalLine, column: originalColumn }
            }),
          },
        ],
      };
    }
  }
}
