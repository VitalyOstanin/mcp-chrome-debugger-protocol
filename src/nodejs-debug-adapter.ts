import {
  DebugSession,
  InitializedEvent,
  TerminatedEvent,
  StoppedEvent,
  OutputEvent,
  Thread,
  Breakpoint,
  Event as DAEvent,
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { CDPTransport, type CDPConnection } from './cdp-transport.js';
import type { Protocol } from 'devtools-protocol';
import { SourceMapResolver } from './source-map-resolver.js';

export interface NodeJSLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';
  sourceMaps?: boolean;
  outFiles?: string[];
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[];
}

export interface NodeJSAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
  port?: number;
  address?: string;
  localRoot?: string;
  remoteRoot?: string;
  sourceMaps?: boolean;
  outFiles?: string[];
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[];
}

interface NodeJSRuntimeBreakpoint {
  id: string;
  line: number;
  column?: number;
  verified: boolean;
  condition?: string;
  logMessage?: string;
}

type VariableHandle =
  | { kind: 'scope'; frameIndex: number; scopeIndex: number; objectId?: string }
  | { kind: 'object'; objectId: string };

export class NodeJSDebugAdapter extends DebugSession {
  private static readonly THREAD_ID = 1;

  private nodeProcess: ChildProcess | null = null;
  private isAttached = false;
  private readonly breakpoints = new Map<string, NodeJSRuntimeBreakpoint[]>();
  private nextBreakpointId = 1;
  private cdpTransport: CDPTransport | null = null;
  private cdpConnection: CDPConnection | null = null;
  private readonly sourceMapResolver = new SourceMapResolver();
  private readonly scriptsByUrl = new Map<string, string>();
  private readonly scriptsById = new Map<string, Protocol.Debugger.ScriptParsedEvent>();
  private currentCallFrames: Protocol.Debugger.CallFrame[] = [];
  private readonly variableHandles = new Map<number, VariableHandle>();
  private nextVariableHandleId = 1;
  private lastException: Protocol.Runtime.ExceptionDetails | null = null;
  private exceptionPauseState: 'none' | 'uncaught' | 'all' = 'none';

  private async getScriptIdForPath(targetPath: string, timeoutMs = 1000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    const fileUrl = `file://${targetPath}`;
    const tryGet = () => this.scriptsByUrl.get(fileUrl) ?? this.scriptsByUrl.get(targetPath);
    let scriptId = tryGet();

    while (!scriptId && Date.now() < deadline) {
      // Small delay to allow scriptParsed events to arrive after Debugger.enable
      await new Promise((r) => setTimeout(r, 50));
      scriptId = tryGet();
    }

    // As a last resort, try suffix/basename match
    if (!scriptId) {
      const base = targetPath.split("/").pop();

      for (const [url, sid] of this.scriptsByUrl.entries()) {
        if (url.endsWith(targetPath) || (base && url.endsWith(`/${  base}`))) {
          scriptId = sid;
          break;
        }
      }
    }

    return scriptId;
  }

  constructor() {
    super();

    // This debugger uses 1-based line and column numbers (DAP standard)
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    __args: DebugProtocol.InitializeRequestArguments,
  ): void {
    // Build and return capabilities of this debug adapter
    response.body = response.body ?? {};

    // The adapter implements the configurationDone request
    response.body.supportsConfigurationDoneRequest = true;

    // Make VS Code use 'evaluate' when hovering over source
    response.body.supportsEvaluateForHovers = true;

    // Make VS Code show a 'step back' button
    response.body.supportsStepBack = false;

    // Make VS Code support data breakpoints
    response.body.supportsDataBreakpoints = false;

    // Make VS Code support completion in REPL
    response.body.supportsCompletionsRequest = true;
    response.body.completionTriggerCharacters = [".", "["];

    // Make VS Code support hit conditional breakpoints
    response.body.supportsHitConditionalBreakpoints = true;

    // Make VS Code support logpoints
    response.body.supportsLogPoints = true;

    // Make VS Code support setting variable values
    response.body.supportsSetVariable = true;

    // Make VS Code support conditional breakpoints
    response.body.supportsConditionalBreakpoints = true;

    this.sendResponse(response);

    // Since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
    // we request them early by sending an 'initializeRequest' to the frontend.
    // The frontend will end the configuration sequence by calling 'configurationDone' request.
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: NodeJSLaunchRequestArguments,
  ): Promise<void> {
    try {
      // Validate required parameters
      if (!args.program) {
        this.sendErrorResponse(response, 1001, "Program path is required");

        return;
      }

      // Prepare Node.js arguments for debugging
      const nodeArgs = [
        "--inspect-brk=0.0.0.0:0", // Enable debugging and break on start
        args.program,
        ...(args.args ?? []),
      ];

      // Launch Node.js process with debugging enabled
      this.nodeProcess = spawn("node", nodeArgs, {
        cwd: args.cwd ?? process.cwd(),
        env: { ...process.env, ...args.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (!this.nodeProcess.pid) {
        throw new Error("Failed to launch Node.js process");
      }

      // Handle process output
      this.nodeProcess.stdout?.on("data", (data) => {
        this.sendEvent(new OutputEvent(data.toString(), "stdout"));
      });

      this.nodeProcess.stderr?.on("data", (data) => {
        const output = data.toString();

        this.sendEvent(new OutputEvent(output, "stderr"));

        // Node.js debugger output - DAP handles connection automatically
      });

      // Log source map configuration
      if (args.sourceMaps !== false) {
        this.sendEvent(new OutputEvent(`Source maps enabled: ${args.sourceMaps ?? true}\n`, "console"));

        if (args.outFiles && args.outFiles.length > 0) {
          this.sendEvent(new OutputEvent(`Output files patterns: ${args.outFiles.join(", ")}\n`, "console"));
        }

        if (args.sourceMapPathOverrides) {
          this.sendEvent(
            new OutputEvent(`Source map path overrides: ${JSON.stringify(args.sourceMapPathOverrides)}\n`, "console"),
          );
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.nodeProcess.on("exit", (__code) => {
        this.sendEvent(new TerminatedEvent());
        this.nodeProcess = null;
      });

      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1002,
        `Launch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected async attachRequest(
    response: DebugProtocol.AttachResponse,
    args: NodeJSAttachRequestArguments,
  ): Promise<void> {
    try {
      await this.doAttach(args);
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1003,
        `Attach failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Public wrapper: perform attach without VS Code request plumbing
  public async attach(args: NodeJSAttachRequestArguments): Promise<{ success: boolean; message?: string }> {
    try {
      await this.doAttach(args);

      return { success: true, message: "attached" };
    } catch (error) {
      this.sendEvent(
        new OutputEvent(`Attach failed: ${error instanceof Error ? error.message : String(error)}\n`, "stderr"),
      );

      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // Shared attach logic (DRY)
  private async doAttach(args: NodeJSAttachRequestArguments): Promise<void> {
    // Create CDP transport and connect to Node.js inspector
    this.cdpTransport = new CDPTransport({
      host: args.address ?? "localhost",
      port: args.port ?? 9229,
    });

    // Set up CDP event handlers
    this.setupCDPEventHandlers();

    // Connect to Node.js inspector via CDP
    this.cdpConnection = await this.cdpTransport.connect();

    // Enable necessary CDP domains
    await this.cdpTransport.enableDomains(["Runtime", "Debugger", "Console", "Profiler"]);

    // Install a binding for logpoints before any breakpoints are set
    try {
      await this.cdpTransport.sendCommand(
        "Runtime.addBinding",
        { name: "__mcpLogPoint" },
      );
    } catch (error) {
      this.sendEvent(
        new OutputEvent(
          `Failed to install Runtime.addBinding for logpoints: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
          "console",
        ),
      );
    }

    this.isAttached = true;

    this.sendEvent(
      new OutputEvent(
        `Attached to Node.js process on ${args.address ?? "localhost"}:${args.port ?? 9229}\n`,
        "console",
      ),
    );

    // Log source map configuration for attach
    if (args.sourceMaps !== false) {
      this.sendEvent(new OutputEvent(`Source maps enabled: ${args.sourceMaps ?? true}\n`, "console"));

      if (args.outFiles && args.outFiles.length > 0) {
        this.sendEvent(new OutputEvent(`Output files patterns: ${args.outFiles.join(", ")}\n`, "console"));
      }

      if (args.sourceMapPathOverrides) {
        this.sendEvent(
          new OutputEvent(`Source map path overrides: ${JSON.stringify(args.sourceMapPathOverrides)}\n`, "console"),
        );
      }
    }
  }

  private setupCDPEventHandlers(): void {
    if (!this.cdpTransport) return;

    this.cdpTransport.on("connected", (connection: CDPConnection) => {
      this.sendEvent(new OutputEvent(`Connected to target: ${connection.target.title}\n`, "console"));
    });

    this.cdpTransport.on("disconnected", () => {
      this.sendEvent(new OutputEvent("Debugger disconnected\n", "console"));
      this.sendEvent(new TerminatedEvent());
    });

    this.cdpTransport.on("error", (error: Error) => {
      this.sendEvent(new OutputEvent(`CDP Error: ${error.message}\n`, "stderr"));
    });

    this.cdpTransport.on("cdp-event", (event: { method: string; params: unknown }) => {
      this.handleCDPEvent(event);
    });
  }

  private handleCDPEvent(event: { method: string; params: unknown }): void {
    switch (event.method) {
      case "Debugger.scriptParsed": {
        const params = event.params as Protocol.Debugger.ScriptParsedEvent;

        this.scriptsById.set(params.scriptId, params);
        if (params.url) {
          this.scriptsByUrl.set(params.url, params.scriptId);
          if (params.url.startsWith("file://")) {
            // Also map plain absolute path
            try {
              const plain = params.url.replace(/^file:\/\//, "");

              this.scriptsByUrl.set(plain, params.scriptId);
            } catch { void 0; }
          }
        }
        break;
      }
      case "Runtime.executionContextCreated": {
        // Ensure our binding exists in newly created execution contexts as well
        try {
          const params = event.params as Protocol.Runtime.ExecutionContextCreatedEvent;

          if (this.cdpTransport) {
            void this.cdpTransport.sendCommand(
              "Runtime.addBinding",
              { name: "__mcpLogPoint", executionContextId: params.context.id },
            );
          }
        } catch {
          // best-effort; ignore errors
        }
        break;
      }
      case "Debugger.paused":
        this.handleDebuggerPaused(event.params as Protocol.Debugger.PausedEvent);
        break;
      case "Debugger.resumed":
        this.sendEvent(new OutputEvent("Execution resumed\n", "console"));
        break;
      case "Runtime.consoleAPICalled":
        this.handleConsoleAPI(event.params as Protocol.Runtime.ConsoleAPICalledEvent);
        break;
      case "Runtime.exceptionThrown":
        this.handleException(event.params as Protocol.Runtime.ExceptionThrownEvent);
        break;
      case "Runtime.bindingCalled": {
        // Forward logpoint binding payload to client via a custom DAP event
        try {
          const params = event.params as Protocol.Runtime.BindingCalledEvent;

          this.sendEvent(
            new DAEvent('mcpLogpoint', {
              executionContextId: params.executionContextId,
              name: params.name,
              payload: params.payload,
            }),
          );
        } catch {
          // ignore malformed payloads
        }
        break;
      }
      default:
        // Ignore other events for now
        break;
    }
  }

  private handleDebuggerPaused(params: Protocol.Debugger.PausedEvent): void {
    // Persist runtime state for evaluate/stackTrace/scopes/variables before raising the event
    this.currentCallFrames = params.callFrames;
    this.variableHandles.clear();
    this.nextVariableHandleId = 1;

    if (params.reason === 'exception' || params.reason === 'promiseRejection') {
      const data = params.data as Protocol.Runtime.RemoteObject | undefined;

      this.lastException = {
        exceptionId: 0,
        text: data?.description ?? 'Exception',
        lineNumber: this.currentCallFrames[0]?.location.lineNumber ?? 0,
        columnNumber: this.currentCallFrames[0]?.location.columnNumber ?? 0,
        scriptId: this.currentCallFrames[0]?.location.scriptId,
        exception: data,
      };
    }

    let reason: string;

    // Map CDP pause reasons to DAP stopped reasons
    switch (params.reason) {
      case 'exception':
      case 'promiseRejection':
        reason = 'exception';
        break;
      case 'other':
        // Check if it's actually a breakpoint hit
        reason = params.hitBreakpoints && params.hitBreakpoints.length > 0 ? 'breakpoint' : 'pause';
        break;
      case 'debugCommand':
      case 'step':
        reason = 'step';
        break;
      case 'DOM':
      case 'ambiguous':
      case 'assert':
      case 'CSPViolation':
      case 'EventListener':
      case 'instrumentation':
      case 'OOM':
      case 'XHR':
      default:
        reason = 'pause';
        break;
    }

    this.sendEvent(new StoppedEvent(reason, NodeJSDebugAdapter.THREAD_ID));
  }

  private handleConsoleAPI(params: Protocol.Runtime.ConsoleAPICalledEvent): void {
    const args = params.args
      .map((arg: Protocol.Runtime.RemoteObject) => arg.value ?? arg.description ?? "[object]")
      .join(" ");

    this.sendEvent(new OutputEvent(`${args}\n`, "stdout"));
  }

  private handleException(params: Protocol.Runtime.ExceptionThrownEvent): void {
    this.lastException = params.exceptionDetails;
    this.sendEvent(new OutputEvent(`Exception: ${params.exceptionDetails.text}\n`, "stderr"));
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    const { path } = args.source;

    if (!path) {
      this.sendErrorResponse(response, 1004, "Source path is required");

      return;
    }

    try {
      const clientLines = args.lines ?? [];
      const sourceBreakpoints = args.breakpoints ?? [];

      // Clear previous breakpoints for this file via CDP
      await this.clearCDPBreakpoints(path);

      const actualBreakpoints: Breakpoint[] = [];
      const runtimeBreakpoints: NodeJSRuntimeBreakpoint[] = [];
      // Set new breakpoints via CDP
      const total = Math.max(clientLines.length, sourceBreakpoints.length);

      for (let i = 0; i < total; i++) {
        const sourceBreakpoint = sourceBreakpoints[i] ?? ({ line: clientLines[i] });
        const line = clientLines[i] ?? sourceBreakpoint.line;
        // Use 1-based default column to satisfy source map resolution (resolver rejects 0)
        const column = sourceBreakpoint.column ?? 1;

        try {
          let cdpResult: Protocol.Debugger.SetBreakpointByUrlResponse | null = null;
          // Resolve source map position if needed (for .ts files)
          let targetPath = path;
          let targetLine = line;
          let targetColumn = column;

          if (this.cdpTransport) {
            if (/\.(ts|tsx|mts|cts)$/.test(path)) {
              try {
                const sourceMapResolution = await this.sourceMapResolver.resolveSourceMapPosition(path, line, column);

                if (sourceMapResolution.sourceMapInfo.success) {
                  targetPath = sourceMapResolution.targetFilePath;
                  targetLine = sourceMapResolution.targetLineNumber;
                  targetColumn = sourceMapResolution.targetColumnNumber;

                  this.sendEvent(
                    new OutputEvent(`Source map resolved: ${path}:${line} → ${targetPath}:${targetLine}\n`, "console"),
                  );
                }
              } catch (error) {
                this.sendEvent(
                  new OutputEvent(
                    `Source map resolution failed for ${path}:${line}: ${
                      error instanceof Error ? error.message : String(error)
                    }\n`,
                    "console",
                  ),
                );
              }
            }

            // Determine the condition for this breakpoint
            // For logpoints, use the logpoint expression; otherwise use the regular condition
            let breakpointCondition = sourceBreakpoint.condition;

            if (sourceBreakpoint.logMessage) {
              breakpointCondition = this.createLogpointExpression(sourceBreakpoint.logMessage);
            }

            // First try scriptId-based placement for reliability
            const fileUrl = `file://${targetPath}`;
            const scriptId = await this.getScriptIdForPath(targetPath, 2000);

            this.sendEvent(
              new OutputEvent(`Breakpoint target ${targetPath} → scriptId=${scriptId ?? "not-found"}\n`, "console"),
            );

            if (scriptId) {
              try {
                const baseLine0 = Math.max(0, targetLine - 1);
                const baseCol0 = Math.max(0, targetColumn - 1);
                const tryRange = async (startDelta: number, endDelta: number) => {
                  const start: Protocol.Debugger.Location = {
                    scriptId,
                    lineNumber: Math.max(0, baseLine0 + startDelta),
                    columnNumber: 0,
                  };
                  const end: Protocol.Debugger.Location = {
                    scriptId,
                    lineNumber: Math.max(start.lineNumber, baseLine0 + endDelta),
                    columnNumber: 200,
                  };
                  const possible =
                    await this.cdpTransport!.sendCommand<Protocol.Debugger.GetPossibleBreakpointsResponse>(
                      "Debugger.getPossibleBreakpoints",
                      { start, end, restrictToFunction: false },
                    );
                  const locs = possible.locations;

                  if (!locs.length) return undefined;

                  // Prefer first location at or after base position
                  const after = locs.filter(
                    (l) => l.lineNumber > baseLine0 || (l.lineNumber === baseLine0 && (l.columnNumber ?? 0) >= baseCol0),
                  );

                  if (after.length) return after[0];

                  // Else pick the closest by absolute distance in lines
                  return locs.sort(
                    (a, b) => Math.abs(a.lineNumber - baseLine0) - Math.abs(b.lineNumber - baseLine0),
                  )[0];
                };
                let chosen = await tryRange(0, 10);

                chosen ??= await tryRange(-2, 20);
                chosen ??= await tryRange(-10, 50);

                if (chosen) {
                  this.sendEvent(
                    new OutputEvent(
                      `getPossibleBreakpoints picked ${targetPath}:${chosen.lineNumber + 1}:${
                        (chosen.columnNumber ?? 0) + 1
                      }\n`,
                      "console",
                    ),
                  );

                  const setResp = await this.cdpTransport.sendCommand<Protocol.Debugger.SetBreakpointResponse>(
                    "Debugger.setBreakpoint",
                    { location: chosen, condition: breakpointCondition },
                  );

                  cdpResult = {
                    breakpointId: setResp.breakpointId,
                    locations: [setResp.actualLocation],
                  };
                  // Update targetLine/Column for better reporting
                  targetLine = setResp.actualLocation.lineNumber + 1;
                  targetColumn = (setResp.actualLocation.columnNumber ?? chosen.columnNumber ?? 0) + 1;
                }
              } catch {
                // fall through to URL-based
              }
            }

            if (!cdpResult) {
              // Try exact URL with mapped generated location
              try {
                cdpResult = await this.cdpTransport.sendCommand<Protocol.Debugger.SetBreakpointByUrlResponse>(
                  "Debugger.setBreakpointByUrl",
                  {
                    url: fileUrl,
                    lineNumber: Math.max(0, targetLine - 1),
                    condition: breakpointCondition,
                  },
                );
                this.sendEvent(
                  new OutputEvent(
                    `setBreakpointByUrl at ${fileUrl}:${targetLine}:${targetColumn} (exact url)\n`,
                    "console",
                  ),
                );
              } catch {
                // Fallback to urlRegex
                const escapedPath = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

                cdpResult = await this.cdpTransport.sendCommand<Protocol.Debugger.SetBreakpointByUrlResponse>(
                  "Debugger.setBreakpointByUrl",
                  {
                    lineNumber: Math.max(0, targetLine - 1),
                    urlRegex: `file:.*${escapedPath}$`,
                    condition: breakpointCondition,
                  },
                );
                this.sendEvent(
                  new OutputEvent(
                    `setBreakpointByUrl at regex /${escapedPath}$/ line=${targetLine} col=${targetColumn}\n`,
                    "console",
                  ),
                );
              }
            }
          }

          const breakpointId = cdpResult?.breakpointId ?? `bp_${this.nextBreakpointId++}`;
          const verified = cdpResult !== null;
          const runtimeBp: NodeJSRuntimeBreakpoint = {
            id: breakpointId,
            line,
            column,
            verified,
            condition: sourceBreakpoint.condition,
            logMessage: sourceBreakpoint.logMessage,
          };

          runtimeBreakpoints.push(runtimeBp);

          // Report requested location back to client (tests expect requested line/col)
          const actualBp = new Breakpoint(verified, line, column);

          // Attach source info so tests can assert source.path
          (actualBp as unknown as DebugProtocol.Breakpoint).source = {
            name: path.split("/").pop(),
            path,
          };
          // Provide numeric id for DAP response consumers
          (actualBp as unknown as DebugProtocol.Breakpoint).id = this.nextBreakpointId++;

          actualBreakpoints.push(actualBp);

          // Send notification if this was a logpoint
          if (sourceBreakpoint.logMessage) {
            this.sendEvent(
              new OutputEvent(
                `Logpoint set at ${path}:${line} - Message: "${sourceBreakpoint.logMessage}"\n`,
                "console",
              ),
            );
          }
        } catch (error) {
          // Create unverified breakpoint if CDP fails
          const runtimeBp: NodeJSRuntimeBreakpoint = {
            id: `bp_${this.nextBreakpointId++}`,
            line,
            column,
            verified: false,
            condition: sourceBreakpoint.condition,
            logMessage: sourceBreakpoint.logMessage,
          };

          runtimeBreakpoints.push(runtimeBp);

          const actualBp = new Breakpoint(false, line, column);

          (actualBp as unknown as DebugProtocol.Breakpoint).source = {
            name: path.split("/").pop(),
            path,
          };
          (actualBp as unknown as DebugProtocol.Breakpoint).id = this.nextBreakpointId++;

          actualBreakpoints.push(actualBp);

          this.sendEvent(
            new OutputEvent(
              `Failed to set breakpoint at ${path}:${line}: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
              "console",
            ),
          );
        }
      }

      this.breakpoints.set(path, runtimeBreakpoints);

      response.success = true;
      response.body = {
        breakpoints: actualBreakpoints,
      };
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1004,
        `Set breakpoints failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Public wrapper: set breakpoints (supports logMessage)
  public async setBreakpoints(
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<DebugProtocol.SetBreakpointsResponse> {
    const response: DebugProtocol.SetBreakpointsResponse = {
      seq: 0,
      type: "response",
      request_seq: 0,
      command: "setBreakpoints",
      success: false,
      body: { breakpoints: [] },
    };

    await this.setBreakPointsRequest(response, args);

    return response;
  }

  private async clearCDPBreakpoints(filePath: string): Promise<void> {
    const existingBreakpoints = this.breakpoints.get(filePath) ?? [];

    for (const bp of existingBreakpoints) {
      try {
        if (this.cdpTransport && bp.verified) {
          await this.cdpTransport.sendCommand("Debugger.removeBreakpoint", {
            breakpointId: bp.id,
          });
        }
      } catch (error) {
        this.sendEvent(
          new OutputEvent(
            `Failed to remove breakpoint ${bp.id}: ${error instanceof Error ? error.message : String(error)}\n`,
            "console",
          ),
        );
      }
    }

    this.breakpoints.delete(filePath);
  }

  private createLogpointExpression(logMessage: string): string {
    // Collect unique placeholder expressions inside {...}
    const exprs = Array.from(new Set((logMessage.match(/\{([^}]+)\}/g) ?? [])
      .map(m => m.slice(1, -1).trim())
      .filter(Boolean)));
    // Build safe per-expression evaluators to capture variables/expressions without throwing
    const varsEntries = exprs.map(expr => {
      const key = expr.replace(/"/g, '\\"');

      // Use IIFE with try/catch to guard ReferenceErrors and other runtime errors
      return `"${key}":(()=>{try{return ${expr}}catch(_){return undefined}})()`;
    }).join(',');
    // Build message template using __vars values instead of re-evaluating expressions
    const tpl = logMessage.replace(/`/g, "\\`").replace(/\{([^}]+)\}/g, (_, expr) => {
      const key = expr.trim().replace(/"/g, '\\"');

      return `\${typeof __vars["${key}"]==="object"?JSON.stringify(__vars["${key}"]):__vars["${key}"]}`;
    });

    // Report via Runtime.addBinding binding with rich JSON payload; swallow errors; never pause (return false)
    return `(()=>{try{const __vars={${varsEntries}};typeof __mcpLogPoint==='function'&&__mcpLogPoint(JSON.stringify({message:\`${tpl}\`,vars:__vars,time:Date.now()}))}catch(_){};return false})()`;
  }

  // The DAP request handlers below (continueRequest/pauseRequest/...) remain as DebugSession
  // overrides for the small subset reachable through DAP message routing. The MCP-facing path goes
  // through the public methods declared further down (continue, pause, stepIn, stepOut, next,
  // evaluate, stackTrace, scopes, variables, threads, ...) so we never depend on the DebugSession
  // protected handler chain for those operations.

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.ContinueArguments,
  ): Promise<void> {
    try {
      if (this.cdpTransport) {
        await this.cdpTransport.sendCommand("Debugger.resume");
      }
      response.body = { allThreadsContinued: true };
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1005,
        `Continue failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.PauseArguments,
  ): Promise<void> {
    try {
      if (this.cdpTransport) {
        await this.cdpTransport.sendCommand("Debugger.pause");
      }
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 1006, `Pause failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.StepInArguments,
  ): Promise<void> {
    try {
      if (this.cdpTransport) {
        await this.cdpTransport.sendCommand("Debugger.stepInto");
      }
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1007,
        `Step into failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.StepOutArguments,
  ): Promise<void> {
    try {
      if (this.cdpTransport) {
        await this.cdpTransport.sendCommand("Debugger.stepOut");
      }
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1008,
        `Step out failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.NextArguments,
  ): Promise<void> {
    try {
      if (this.cdpTransport) {
        await this.cdpTransport.sendCommand("Debugger.stepOver");
      }
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        1009,
        `Step over failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    super.configurationDoneRequest(response, _args);

    // In real implementation, we could start execution here if not already started
  }

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    if (this.nodeProcess) {
      this.nodeProcess.kill();
      this.nodeProcess = null;
    }

    // Clean up CDP connection
    if (this.cdpTransport) {
      await this.cdpTransport.disconnect();
      this.cdpTransport = null;
      this.cdpConnection = null;
    }

    this.isAttached = false;
    this.currentCallFrames = [];
    this.variableHandles.clear();

    super.disconnectRequest(response, args);
  }

  // ===== Public methods used by DAPClient.dapRequest =====
  // These talk to CDP directly and bypass DebugSession's protected request pipeline.

  private requireTransport(): CDPTransport {
    if (!this.cdpTransport) {
      throw new Error('Not attached to a debugger');
    }

    return this.cdpTransport;
  }

  private allocateHandle(handle: VariableHandle): number {
    const id = this.nextVariableHandleId++;

    this.variableHandles.set(id, handle);

    return id;
  }

  private remoteObjectToString(remote: Protocol.Runtime.RemoteObject): string {
    if (remote.unserializableValue !== undefined) {
      return remote.unserializableValue;
    }
    if (remote.value !== undefined) {
      return typeof remote.value === 'string' ? remote.value : JSON.stringify(remote.value);
    }

    return remote.description ?? remote.type;
  }

  public async continueExecution(args?: DebugProtocol.ContinueArguments): Promise<DebugProtocol.ContinueResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.resume');

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'continue',
      success: true,
      body: { allThreadsContinued: true },
    };
  }

  public async pauseExecution(args?: DebugProtocol.PauseArguments): Promise<DebugProtocol.PauseResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.pause');

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'pause',
      success: true,
    };
  }

  public async stepIn(args?: DebugProtocol.StepInArguments): Promise<DebugProtocol.StepInResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.stepInto');

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'stepIn',
      success: true,
    };
  }

  public async stepOut(args?: DebugProtocol.StepOutArguments): Promise<DebugProtocol.StepOutResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.stepOut');

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'stepOut',
      success: true,
    };
  }

  public async next(args?: DebugProtocol.NextArguments): Promise<DebugProtocol.NextResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.stepOver');

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'next',
      success: true,
    };
  }

  public threads(): DebugProtocol.ThreadsResponse {
    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'threads',
      success: true,
      body: { threads: [new Thread(NodeJSDebugAdapter.THREAD_ID, 'Main Thread')] },
    };
  }

  public stackTrace(args: DebugProtocol.StackTraceArguments): DebugProtocol.StackTraceResponse {
    const startFrame = args.startFrame ?? 0;
    const levels = args.levels && args.levels > 0 ? args.levels : this.currentCallFrames.length;
    const slice = this.currentCallFrames.slice(startFrame, startFrame + levels);
    const stackFrames: DebugProtocol.StackFrame[] = slice.map((frame, idx) => {
      const absoluteIndex = startFrame + idx;
      const script = this.scriptsById.get(frame.location.scriptId);
      const url = script?.url ?? '';
      const sourcePath = url.startsWith('file://') ? url.replace(/^file:\/\//, '') : url;

      return {
        id: absoluteIndex,
        name: frame.functionName || '<anonymous>',
        line: frame.location.lineNumber + 1,
        column: (frame.location.columnNumber ?? 0) + 1,
        source: sourcePath
          ? { name: sourcePath.split('/').pop() ?? sourcePath, path: sourcePath }
          : undefined,
      };
    });

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'stackTrace',
      success: true,
      body: { stackFrames, totalFrames: this.currentCallFrames.length },
    };
  }

  public scopes(args: DebugProtocol.ScopesArguments): DebugProtocol.ScopesResponse {
    if (args.frameId < 0 || args.frameId >= this.currentCallFrames.length) {
      throw new Error(`Frame ${args.frameId} not found`);
    }

    const frame = this.currentCallFrames[args.frameId];
    const dapScopes: DebugProtocol.Scope[] = frame.scopeChain.map((scope, scopeIndex) => {
      const reference = this.allocateHandle({
        kind: 'scope',
        frameIndex: args.frameId,
        scopeIndex,
        objectId: scope.object.objectId,
      });
      const presentationHint =
        scope.type === 'local' ? 'locals'
        : scope.type === 'global' ? undefined
        : undefined;
      const expensive = scope.type === 'global';

      return {
        name: scope.name ?? scope.type,
        presentationHint,
        variablesReference: reference,
        expensive,
      };
    });

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'scopes',
      success: true,
      body: { scopes: dapScopes },
    };
  }

  public async variables(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.VariablesResponse> {
    const handle = this.variableHandles.get(args.variablesReference);

    if (!handle) {
      throw new Error(`Variable reference ${args.variablesReference} not found`);
    }

    const {objectId} = handle;

    if (objectId === undefined) {
      return {
        seq: 0,
        type: 'response',
        request_seq: 0,
        command: 'variables',
        success: true,
        body: { variables: [] },
      };
    }

    const result = await this.requireTransport().sendCommand<Protocol.Runtime.GetPropertiesResponse>(
      'Runtime.getProperties',
      {
        objectId,
        ownProperties: handle.kind === 'object',
        accessorPropertiesOnly: false,
        generatePreview: true,
      },
    );
    const variables: DebugProtocol.Variable[] = result.result
      .filter(prop => !(prop.value === undefined && prop.get === undefined))
      .map(prop => {
        const remote = prop.value;
        const childRef = remote?.objectId
          ? this.allocateHandle({ kind: 'object', objectId: remote.objectId })
          : 0;

        return {
          name: prop.name,
          value: remote ? this.remoteObjectToString(remote) : '<accessor>',
          type: remote?.type,
          variablesReference: childRef,
        };
      });

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'variables',
      success: true,
      body: { variables },
    };
  }

  public async evaluate(args: DebugProtocol.EvaluateArguments): Promise<DebugProtocol.EvaluateResponse> {
    const transport = this.requireTransport();
    let remote: Protocol.Runtime.RemoteObject;
    let exceptionDetails: Protocol.Runtime.ExceptionDetails | undefined;

    if (args.frameId !== undefined && this.currentCallFrames[args.frameId]) {
      const callFrame = this.currentCallFrames[args.frameId];
      const response = await transport.sendCommand<Protocol.Debugger.EvaluateOnCallFrameResponse>(
        'Debugger.evaluateOnCallFrame',
        {
          callFrameId: callFrame.callFrameId,
          expression: args.expression,
          objectGroup: 'mcp-evaluate',
          includeCommandLineAPI: true,
          silent: false,
          returnByValue: false,
          generatePreview: true,
        },
      );

      remote = response.result;
      exceptionDetails = response.exceptionDetails;
    } else {
      const response = await transport.sendCommand<Protocol.Runtime.EvaluateResponse>(
        'Runtime.evaluate',
        {
          expression: args.expression,
          objectGroup: 'mcp-evaluate',
          includeCommandLineAPI: true,
          silent: false,
          returnByValue: false,
          generatePreview: true,
          replMode: args.context === 'repl',
        },
      );

      remote = response.result;
      exceptionDetails = response.exceptionDetails;
    }

    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }

    const reference = remote.objectId
      ? this.allocateHandle({ kind: 'object', objectId: remote.objectId })
      : 0;

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'evaluate',
      success: true,
      body: {
        result: this.remoteObjectToString(remote),
        type: remote.type,
        variablesReference: reference,
      },
    };
  }

  public async setVariable(
    args: DebugProtocol.SetVariableArguments,
  ): Promise<DebugProtocol.SetVariableResponse> {
    const handle = this.variableHandles.get(args.variablesReference);

    if (handle?.kind !== 'scope') {
      throw new Error('setVariable is only supported on scope references');
    }

    if (handle.frameIndex < 0 || handle.frameIndex >= this.currentCallFrames.length) {
      throw new Error(`Frame ${handle.frameIndex} not found`);
    }

    const callFrame = this.currentCallFrames[handle.frameIndex];
    const transport = this.requireTransport();
    // Evaluate the desired value as an expression, then assign via Debugger.setVariableValue
    const evalResult = await transport.sendCommand<Protocol.Debugger.EvaluateOnCallFrameResponse>(
      'Debugger.evaluateOnCallFrame',
      {
        callFrameId: callFrame.callFrameId,
        expression: args.value,
        objectGroup: 'mcp-set-variable',
        includeCommandLineAPI: false,
        silent: true,
        returnByValue: false,
        generatePreview: true,
      },
    );

    if (evalResult.exceptionDetails) {
      throw new Error(evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails.text);
    }

    const newValue: Protocol.Runtime.CallArgument = evalResult.result.objectId
      ? { objectId: evalResult.result.objectId }
      : { value: evalResult.result.value };

    await transport.sendCommand('Debugger.setVariableValue', {
      scopeNumber: handle.scopeIndex,
      variableName: args.name,
      newValue,
      callFrameId: callFrame.callFrameId,
    });

    const childRef = evalResult.result.objectId
      ? this.allocateHandle({ kind: 'object', objectId: evalResult.result.objectId })
      : 0;

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'setVariable',
      success: true,
      body: {
        value: this.remoteObjectToString(evalResult.result),
        type: evalResult.result.type,
        variablesReference: childRef,
      },
    };
  }

  public loadedSources(): DebugProtocol.LoadedSourcesResponse {
    const sources: DebugProtocol.Source[] = [];
    const seen = new Set<string>();

    for (const script of this.scriptsById.values()) {
      const {url} = script;

      if (!url || seen.has(url)) continue;
      seen.add(url);

      const path = url.startsWith('file://') ? url.replace(/^file:\/\//, '') : url;

      sources.push({
        name: path.split('/').pop() ?? path,
        path,
      });
    }

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'loadedSources',
      success: true,
      body: { sources },
    };
  }

  public exceptionInfo(args: DebugProtocol.ExceptionInfoArguments): DebugProtocol.ExceptionInfoResponse {
    void args;

    const ex = this.lastException;

    if (!ex) {
      throw new Error('No exception information available');
    }

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'exceptionInfo',
      success: true,
      body: {
        exceptionId: String(ex.exceptionId),
        description: ex.exception?.description ?? ex.text,
        breakMode: this.exceptionPauseState === 'all' ? 'always' : 'unhandled',
      },
    };
  }

  public async setExceptionBreakpoints(
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): Promise<DebugProtocol.SetExceptionBreakpointsResponse> {
    let state: 'none' | 'uncaught' | 'all' = 'none';
    const {filters} = args;

    if (filters.includes('all') || (filters.includes('caught') && filters.includes('uncaught'))) {
      state = 'all';
    } else if (filters.includes('uncaught')) {
      state = 'uncaught';
    }

    await this.requireTransport().sendCommand('Debugger.setPauseOnExceptions', { state });
    this.exceptionPauseState = state;

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'setExceptionBreakpoints',
      success: true,
      body: { breakpoints: filters.map(() => ({ verified: true })) },
    };
  }

  public async breakpointLocations(
    args: DebugProtocol.BreakpointLocationsArguments,
  ): Promise<DebugProtocol.BreakpointLocationsResponse> {
    const path = args.source.path ?? '';
    const scriptId = await this.getScriptIdForPath(path, 200);

    if (!scriptId) {
      return {
        seq: 0,
        type: 'response',
        request_seq: 0,
        command: 'breakpointLocations',
        success: true,
        body: { breakpoints: [] },
      };
    }

    const transport = this.requireTransport();
    const start: Protocol.Debugger.Location = {
      scriptId,
      lineNumber: Math.max(0, args.line - 1),
      columnNumber: args.column !== undefined ? Math.max(0, args.column - 1) : 0,
    };
    const end: Protocol.Debugger.Location = {
      scriptId,
      lineNumber: Math.max(start.lineNumber, args.endLine !== undefined ? args.endLine - 1 : start.lineNumber),
      columnNumber: args.endColumn !== undefined ? Math.max(0, args.endColumn - 1) : 200,
    };
    const possible = await transport.sendCommand<Protocol.Debugger.GetPossibleBreakpointsResponse>(
      'Debugger.getPossibleBreakpoints',
      { start, end, restrictToFunction: false },
    );
    const breakpoints: DebugProtocol.BreakpointLocation[] = possible.locations.map(loc => ({
      line: loc.lineNumber + 1,
      column: (loc.columnNumber ?? 0) + 1,
    }));

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'breakpointLocations',
      success: true,
      body: { breakpoints },
    };
  }

  public async restartFrame(
    args: DebugProtocol.RestartFrameArguments,
  ): Promise<DebugProtocol.RestartFrameResponse> {
    if (args.frameId < 0 || args.frameId >= this.currentCallFrames.length) {
      throw new Error(`Frame ${args.frameId} not found`);
    }

    const frame = this.currentCallFrames[args.frameId];

    await this.requireTransport().sendCommand('Debugger.restartFrame', { callFrameId: frame.callFrameId });

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'restartFrame',
      success: true,
    };
  }

  public goto(args: DebugProtocol.GotoArguments): DebugProtocol.GotoResponse {
    void args;
    throw new Error('goto is not supported by the Node.js inspector');
  }

  public async terminate(): Promise<DebugProtocol.TerminateResponse> {
    if (this.nodeProcess) {
      this.nodeProcess.kill();
      this.nodeProcess = null;
    }

    if (this.cdpTransport) {
      await this.cdpTransport.disconnect();
      this.cdpTransport = null;
      this.cdpConnection = null;
    }

    this.isAttached = false;

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'terminate',
      success: true,
    };
  }

  public async restart(): Promise<DebugProtocol.RestartResponse> {
    // Best-effort: detach and re-attach is the responsibility of the caller; we just clean state.
    this.currentCallFrames = [];
    this.variableHandles.clear();
    this.lastException = null;

    return {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command: 'restart',
      success: true,
    };
  }

  // Method to simulate logpoint hit - would be called from DAP runtime events
  public simulateLogpointHit(__filePath: string, __line: number, __variables: Record<string, unknown>): void {
    const breakpoints = this.breakpoints.get(__filePath) ?? [];
    const logpoint = breakpoints.find((bp) => bp.line === __line && bp.logMessage);

    if (logpoint?.logMessage) {
      // Build message and vars similar to binding-based runtime path
      const exprs = Array.from(new Set((logpoint.logMessage.match(/\{([^}]+)\}/g) ?? [])
        .map(m => m.slice(1, -1).trim())
        .filter(Boolean)));
      const vars: Record<string, unknown> = {};

      for (const expr of exprs) {
        try {
          // simple dotted path lookup from provided __variables
          const parts = expr.split(".");
          let value: unknown = __variables;

          for (const part of parts) {
            value = (value as Record<string, unknown>)[part];
          }
          vars[expr] = value;
        } catch {
          vars[expr] = undefined;
        }
      }

      const message = logpoint.logMessage
        .replace(/`/g, "\\`")
        .replace(/\{([^}]+)\}/g, (_m, expression) => {
          try {
            const key = String(expression);
            const val = vars[key];

            return String(val);
          } catch {
            return _m;
          }
        });
      const payload = { message, vars, time: Date.now() };

      // Emit custom event like runtime binding path
      this.sendEvent(new DAEvent('mcpLogpoint', {
        executionContextId: 0,
        name: '__mcpLogPoint',
        payload: JSON.stringify(payload),
      }));
    }
  }

  // Method to simulate breakpoint hit
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public simulateBreakpointHit(__filePath: string, __line: number): void {
    this.sendEvent(new StoppedEvent("breakpoint", NodeJSDebugAdapter.THREAD_ID));
  }

  // Public wrapper: disconnect
  public async disconnect(): Promise<void> {
    const response: DebugProtocol.DisconnectResponse = {
      seq: 0,
      type: "response",
      request_seq: 0,
      command: "disconnect",
      success: true,
    };

    await this.disconnectRequest(response, {});
  }
}
