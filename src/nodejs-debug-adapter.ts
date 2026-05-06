import {
  DebugSession,
  InitializedEvent,
  TerminatedEvent,
  StoppedEvent,
  OutputEvent,
  ContinuedEvent,
  Thread,
  Breakpoint,
  Event as DAEvent,
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { CDPTransport, type CDPConnection } from './cdp-transport.js';
import type { Protocol } from 'devtools-protocol';
import { SourceMapResolver } from './source-map-resolver.js';
import {
  buildLogpointExpression,
  extractLogpointPlaceholders,
  lookupDottedPath,
  renderLogpointMessage,
} from './logpoint.js';
import {
  BREAKPOINT_SEARCH_WINDOWS,
  DEFAULTS,
  END_COLUMN_LARGE,
} from './constants.js';

// The @vscode/debugadapter Breakpoint class does not publish source/id in its
// public type, but DebugProtocol.Breakpoint requires them. Centralise the cast
// in one helper so the rest of the adapter stays type-safe.
function assignDapBreakpointFields(
  bp: Breakpoint,
  fields: Pick<DebugProtocol.Breakpoint, 'source' | 'id'>,
): void {
  const target = bp as unknown as DebugProtocol.Breakpoint;

  if (fields.source !== undefined) target.source = fields.source;
  if (fields.id !== undefined) target.id = fields.id;
}

export interface NodeJSLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  env?: Record<string, string>;
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal' | undefined;
  sourceMaps?: boolean | undefined;
  outFiles?: string[] | undefined;
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[] | undefined;
}

export interface NodeJSAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
  port?: number | undefined;
  address?: string | undefined;
  localRoot?: string | undefined;
  remoteRoot?: string | undefined;
  sourceMaps?: boolean | undefined;
  outFiles?: string[] | undefined;
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[] | undefined;
}

interface NodeJSRuntimeBreakpoint {
  id: string;
  dapId?: number | undefined;
  line: number;
  column?: number | undefined;
  verified: boolean;
  condition?: string | undefined;
  logMessage?: string | undefined;
}

type VariableHandle =
  | { kind: 'scope'; frameIndex: number; scopeIndex: number; objectId?: string }
  | { kind: 'object'; objectId: string };

export class NodeJSDebugAdapter extends DebugSession {
  private static readonly THREAD_ID = 1;

  private nodeProcess: ChildProcess | null = null;
  private readonly breakpoints = new Map<string, NodeJSRuntimeBreakpoint[]>();
  private nextBreakpointId = 1;
  // Synthetic CDP-style breakpoint id used when the runtime never replied.
  // Kept independent of nextBreakpointId so the DAP id and the synthetic CDP
  // id never collide on the same numeric value.
  private nextSyntheticCdpId = 1;
  private cdpTransport: CDPTransport | null = null;
  private readonly sourceMapResolver = new SourceMapResolver();
  private readonly scriptsByUrl = new Map<string, string>();
  // Secondary index for the suffix/basename fallback in getScriptIdForPath.
  // Without it, a Node process loading thousands of modules paid O(N) on every
  // breakpoint placement that didn't match the exact URL.
  private readonly scriptsByBasename = new Map<string, Set<string>>();
  private readonly scriptsById = new Map<string, Protocol.Debugger.ScriptParsedEvent>();
  private readonly verboseDiagnostics = process.env.DAP_VERBOSE === '1' || process.env.DAP_VERBOSE === 'true';

  private diagnostic(message: string): void {
    if (!this.verboseDiagnostics) return;
    this.sendEvent(new OutputEvent(message, "console"));
  }

  // Build a successful DAP response shell with the canonical envelope. The
  // adapter does not own the request_seq/seq counters in this build, so they
  // stay at 0 -- DAPClient overwrites request_seq on the wire when needed.
  private okResponse<R extends DebugProtocol.Response>(
    command: R['command'],
    body?: R['body'],
  ): R {
    const result: DebugProtocol.Response = {
      seq: 0,
      type: 'response',
      request_seq: 0,
      command,
      success: true,
      ...(body !== undefined ? { body } : {}),
    };

    return result as unknown as R;
  }
  private currentCallFrames: Protocol.Debugger.CallFrame[] = [];
  private readonly variableHandles = new Map<number, VariableHandle>();
  private nextVariableHandleId = 1;
  private lastException: Protocol.Runtime.ExceptionDetails | null = null;
  private nextExceptionId = 1;
  private exceptionPauseState: 'none' | 'uncaught' | 'all' = 'none';

  private async getScriptIdForPath(targetPath: string, timeoutMs = 1000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    // pathToFileURL handles platform quirks: on Windows it produces 'file:///C:/...'
    // (RFC 8089-compliant), where naive 'file://' + path prefix produces an
    // invalid URL that no script lookup will match.
    const fileUrl = pathToFileURL(targetPath).href;
    const tryGet = () => this.scriptsByUrl.get(fileUrl) ?? this.scriptsByUrl.get(targetPath);
    let scriptId = tryGet();

    while (!scriptId && Date.now() < deadline) {
      // Small delay to allow scriptParsed events to arrive after Debugger.enable
      await sleep(50);
      scriptId = tryGet();
    }

    // As a last resort, try suffix/basename match. Use the precomputed basename
    // index so we don't iterate over scriptsByUrl (which can hold 1000+ entries
    // for typical Node processes).
    if (!scriptId) {
      const base = targetPath.split("/").pop();

      if (base) {
        const candidateUrls = this.scriptsByBasename.get(base);

        if (candidateUrls) {
          for (const url of candidateUrls) {
            if (url.endsWith(targetPath) || url.endsWith(`/${base}`)) {
              const sid = this.scriptsByUrl.get(url);

              if (sid) {
                scriptId = sid;
                break;
              }
            }
          }
        }
      }
    }

    return scriptId;
  }

  private indexScriptUrl(url: string, scriptId: string): void {
    this.scriptsByUrl.set(url, scriptId);

    const basename = url.split("/").pop();

    if (!basename) return;

    const bucket = this.scriptsByBasename.get(basename) ?? new Set<string>();

    bucket.add(url);
    this.scriptsByBasename.set(basename, bucket);
  }

  constructor() {
    super();

    // This debugger uses 1-based line and column numbers (DAP standard)
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected override initializeRequest(
    response: DebugProtocol.InitializeResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.InitializeRequestArguments,
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

  protected override async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: NodeJSLaunchRequestArguments,
  ): Promise<void> {
    try {
      // Validate required parameters
      if (!args.program) {
        this.sendErrorResponse(response, 1001, "Program path is required");

        return;
      }

      // Prepare Node.js arguments for debugging.
      // Bind inspector to loopback only -- 0.0.0.0 exposes Runtime.evaluate (RCE)
      // to anyone on the local network and historically allowed DNS rebinding RCE.
      const nodeArgs = [
        "--inspect-brk=127.0.0.1:0",
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
        this.sendEvent(new OutputEvent(data.toString(), "stderr"));
      });

      this.logSourceMapConfig(args);

      this.nodeProcess.on("exit", () => {
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

  protected override async attachRequest(
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
      host: args.address ?? DEFAULTS.INSPECTOR_CLIENT_HOST,
      port: args.port ?? DEFAULTS.INSPECTOR_PORT,
    });

    // Set up CDP event handlers
    this.setupCDPEventHandlers();

    // Connect to Node.js inspector via CDP
    await this.cdpTransport.connect();

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

    this.sendEvent(
      new OutputEvent(
        `Attached to Node.js process on ${args.address ?? DEFAULTS.INSPECTOR_CLIENT_HOST}:${args.port ?? DEFAULTS.INSPECTOR_PORT}\n`,
        "console",
      ),
    );

    this.logSourceMapConfig(args);
  }

  // Emit the same source-map configuration log block from both launchRequest
  // and doAttach. Skipped when sourceMaps is explicitly disabled.
  private logSourceMapConfig(args: {
    sourceMaps?: boolean | undefined;
    outFiles?: string[] | undefined;
    sourceMapPathOverrides?: Record<string, string> | undefined;
  }): void {
    if (args.sourceMaps === false) return;
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
          this.indexScriptUrl(params.url, params.scriptId);
          if (params.url.startsWith("file://")) {
            // Also map plain absolute path
            try {
              const plain = params.url.replace(/^file:\/\//, "");

              this.indexScriptUrl(plain, params.scriptId);
            } catch { /* ignore */ }
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
        // Inform the DAP client that the runtime is no longer paused; otherwise
        // ToolStateManager.isPaused stays true after `continue` and step* tools
        // remain available even though the debuggee is running again.
        this.lastException = null;
        this.currentCallFrames = [];
        this.variableHandles.clear();
        this.sendEvent(new OutputEvent("Execution resumed\n", "console"));
        this.sendEvent(new ContinuedEvent(NodeJSDebugAdapter.THREAD_ID, true));
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
      // Prefer the richer payload from Runtime.exceptionThrown if it arrived first
      // (it carries stackTrace/scriptId from CDP). Only synthesize from the call
      // frame when nothing has been recorded yet.
      if (!this.lastException && this.currentCallFrames[0]) {
        const data = params.data as Protocol.Runtime.RemoteObject | undefined;
        const top = this.currentCallFrames[0].location;

        // Convert CDP 0-based coordinates to MCP/DAP 1-based at storage time so
        // exceptionInfo never has to remember which frame stored what.
        this.lastException = {
          exceptionId: this.nextExceptionId++,
          text: data?.description ?? 'Exception',
          lineNumber: top.lineNumber + 1,
          columnNumber: (top.columnNumber ?? 0) + 1,
          scriptId: top.scriptId,
          ...(data !== undefined ? { exception: data } : {}),
        };
      }
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
    // Reuse remoteObjectToString so console.log({ a: 1 }) shows as `{"a":1}` and
    // Error remotes carry their description; the previous implementation
    // collapsed every non-primitive to "[object Object]".
    const args = params.args
      .map((arg: Protocol.Runtime.RemoteObject) => this.remoteObjectToString(arg))
      .join(" ");

    this.sendEvent(new OutputEvent(`${args}\n`, "stdout"));
  }

  private handleException(params: Protocol.Runtime.ExceptionThrownEvent): void {
    // Override the CDP-internal exceptionId with our monotonic counter so the
    // value exposed via exceptionInfo matches what handleDebuggerPaused stores
    // (predictable 1, 2, 3, ... rather than CDP-internal jumps).
    this.lastException = {
      ...params.exceptionDetails,
      exceptionId: this.nextExceptionId++,
    };
    this.sendEvent(new OutputEvent(`Exception: ${params.exceptionDetails.text}\n`, "stderr"));
  }

  // Build a (line|column|condition|logMessage) → previous dapId map so re-sends keep stable ids.
  private snapshotPreviousDapIds(path: string): Map<string, number> {
    const previousByKey = new Map<string, number>();

    for (const prev of this.breakpoints.get(path) ?? []) {
      if (prev.dapId === undefined) continue;

      const key = this.breakpointKey(prev.line, prev.column, prev.condition, prev.logMessage);

      previousByKey.set(key, prev.dapId);
    }

    return previousByKey;
  }

  private breakpointKey(line: number, column: number | undefined, condition: string | undefined, logMessage: string | undefined): string {
    return `${line}|${column ?? 0}|${condition ?? ''}|${logMessage ?? ''}`;
  }

  // Resolve TS source positions through source maps; for non-TS or when no map, returns input unchanged.
  private async resolveTargetLocation(
    path: string,
    line: number,
    column: number,
  ): Promise<{ targetPath: string; targetLine: number; targetColumn: number }> {
    if (!/\.(ts|tsx|mts|cts)$/.test(path)) {
      return { targetPath: path, targetLine: line, targetColumn: column };
    }

    try {
      const sourceMapResolution = await this.sourceMapResolver.resolveSourceMapPosition(path, line, column);

      if (sourceMapResolution.sourceMapInfo.success) {
        this.diagnostic(`Source map resolved: ${path}:${line} → ${sourceMapResolution.targetFilePath}:${sourceMapResolution.targetLineNumber}\n`);

        return {
          targetPath: sourceMapResolution.targetFilePath,
          targetLine: sourceMapResolution.targetLineNumber,
          targetColumn: sourceMapResolution.targetColumnNumber,
        };
      }
    } catch (error) {
      this.diagnostic(
        `Source map resolution failed for ${path}:${line}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }

    return { targetPath: path, targetLine: line, targetColumn: column };
  }

  // Attempt scriptId-based placement (most reliable when scripts are loaded).
  // Returns updated location info plus the cdpResult, or null if placement failed.
  private async placeBreakpointByScriptId(
    targetPath: string,
    targetLine: number,
    targetColumn: number,
    breakpointCondition: string | undefined,
  ): Promise<{ cdpResult: Protocol.Debugger.SetBreakpointByUrlResponse; line: number; column: number } | null> {
    if (!this.cdpTransport) return null;

    const scriptId = await this.getScriptIdForPath(targetPath, 2000);

    this.diagnostic(`Breakpoint target ${targetPath} → scriptId=${scriptId ?? "not-found"}\n`);

    if (!scriptId) return null;

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
          columnNumber: END_COLUMN_LARGE,
        };
        const possible =
          await this.cdpTransport!.sendCommand<Protocol.Debugger.GetPossibleBreakpointsResponse>(
            "Debugger.getPossibleBreakpoints",
            { start, end, restrictToFunction: false },
          );
        const locs = possible.locations;

        if (!locs.length) return undefined;

        const after = locs.filter(
          (l) => l.lineNumber > baseLine0 || (l.lineNumber === baseLine0 && (l.columnNumber ?? 0) >= baseCol0),
        );

        if (after.length) return after[0];

        return locs.sort(
          (a, b) => Math.abs(a.lineNumber - baseLine0) - Math.abs(b.lineNumber - baseLine0),
        )[0];
      };
      // Walk the configured fallback windows: each retry widens the search so
      // a slightly off column still resolves to the nearest valid statement.
      let chosen: Protocol.Debugger.BreakLocation | undefined;

      for (const [startDelta, endDelta] of BREAKPOINT_SEARCH_WINDOWS) {
        chosen = await tryRange(startDelta, endDelta);
        if (chosen) break;
      }

      if (!chosen) return null;

      this.diagnostic(
        `getPossibleBreakpoints picked ${targetPath}:${chosen.lineNumber + 1}:${
          (chosen.columnNumber ?? 0) + 1
        }\n`,
      );

      const setResp = await this.cdpTransport.sendCommand<Protocol.Debugger.SetBreakpointResponse>(
        "Debugger.setBreakpoint",
        { location: chosen, condition: breakpointCondition },
      );

      return {
        cdpResult: {
          breakpointId: setResp.breakpointId,
          locations: [setResp.actualLocation],
        },
        line: setResp.actualLocation.lineNumber + 1,
        column: (setResp.actualLocation.columnNumber ?? chosen.columnNumber ?? 0) + 1,
      };
    } catch {
      // Caller will fall through to URL-based placement.
      return null;
    }
  }

  // Fallback path: setBreakpointByUrl (exact url first, then urlRegex).
  private async placeBreakpointByUrl(
    targetPath: string,
    targetLine: number,
    targetColumn: number,
    breakpointCondition: string | undefined,
  ): Promise<Protocol.Debugger.SetBreakpointByUrlResponse> {
    if (!this.cdpTransport) {
      throw new Error('CDP transport not available');
    }

    const fileUrl = pathToFileURL(targetPath).href;

    try {
      const cdpResult = await this.cdpTransport.sendCommand<Protocol.Debugger.SetBreakpointByUrlResponse>(
        "Debugger.setBreakpointByUrl",
        {
          url: fileUrl,
          lineNumber: Math.max(0, targetLine - 1),
          condition: breakpointCondition,
        },
      );

      this.diagnostic(`setBreakpointByUrl at ${fileUrl}:${targetLine}:${targetColumn} (exact url)\n`);

      return cdpResult;
    } catch {
      const escapedPath = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const cdpResult = await this.cdpTransport.sendCommand<Protocol.Debugger.SetBreakpointByUrlResponse>(
        "Debugger.setBreakpointByUrl",
        {
          lineNumber: Math.max(0, targetLine - 1),
          urlRegex: `file:.*${escapedPath}$`,
          condition: breakpointCondition,
        },
      );

      this.diagnostic(`setBreakpointByUrl at regex /${escapedPath}$/ line=${targetLine} col=${targetColumn}\n`);

      return cdpResult;
    }
  }

  // Place a single breakpoint, trying scriptId then url paths. Returns null on no transport.
  private async placeSingleBreakpoint(
    path: string,
    line: number,
    column: number,
    sourceBreakpoint: DebugProtocol.SourceBreakpoint,
  ): Promise<Protocol.Debugger.SetBreakpointByUrlResponse | null> {
    if (!this.cdpTransport) return null;

    const { targetPath, targetLine, targetColumn } = await this.resolveTargetLocation(path, line, column);
    // For logpoints, swap the user condition for the synthetic logpoint expression.
    const breakpointCondition = sourceBreakpoint.logMessage
      ? this.createLogpointExpression(sourceBreakpoint.logMessage)
      : sourceBreakpoint.condition;
    const scriptIdResult = await this.placeBreakpointByScriptId(targetPath, targetLine, targetColumn, breakpointCondition);

    if (scriptIdResult) {
      return scriptIdResult.cdpResult;
    }

    return this.placeBreakpointByUrl(targetPath, targetLine, targetColumn, breakpointCondition);
  }

  // Build the runtime + DAP breakpoint pair, reusing prior dapId when signature matches.
  private buildBreakpointEntry(
    path: string,
    line: number,
    column: number,
    sourceBreakpoint: DebugProtocol.SourceBreakpoint,
    cdpResult: Protocol.Debugger.SetBreakpointByUrlResponse | null,
    previousByKey: Map<string, number>,
  ): { runtimeBp: NodeJSRuntimeBreakpoint; actualBp: Breakpoint } {
    const key = this.breakpointKey(line, column, sourceBreakpoint.condition, sourceBreakpoint.logMessage);
    const dapId = previousByKey.get(key) ?? this.nextBreakpointId++;

    previousByKey.delete(key);

    // Use a separate counter for synthetic CDP-style ids so they never collide
    // with the DAP id range (`dapId` consumes nextBreakpointId).
    const breakpointId = cdpResult?.breakpointId ?? `bp_${this.nextSyntheticCdpId++}`;
    const verified = cdpResult !== null;
    const runtimeBp: NodeJSRuntimeBreakpoint = {
      id: breakpointId,
      dapId,
      line,
      column,
      verified,
      condition: sourceBreakpoint.condition,
      logMessage: sourceBreakpoint.logMessage,
    };
    const actualBp = new Breakpoint(verified, line, column);
    const sourceName = path.split("/").pop();

    // The @vscode/debugadapter Breakpoint helper does not surface `source` and
    // `id` on its public type, even though DebugProtocol.Breakpoint requires
    // them. Cast the helper to the protocol shape once via this assigner so
    // call sites stay type-safe.
    assignDapBreakpointFields(actualBp, {
      source: {
        ...(sourceName !== undefined ? { name: sourceName } : {}),
        path,
      },
      id: dapId,
    });

    return { runtimeBp, actualBp };
  }

  protected override async setBreakPointsRequest(
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
      // DAP setBreakpoints replaces the file's breakpoint list, but real DAP clients
      // expect ids to stay stable for breakpoints whose location/condition/logMessage
      // hasn't changed. Snapshot the previous entries by signature so the loop below
      // can reuse the existing dapId when it sees the same breakpoint coming back.
      const previousByKey = this.snapshotPreviousDapIds(path);

      // Clear previous breakpoints for this file via CDP
      await this.clearCDPBreakpoints(path);

      const actualBreakpoints: Breakpoint[] = [];
      const runtimeBreakpoints: NodeJSRuntimeBreakpoint[] = [];
      const total = Math.max(clientLines.length, sourceBreakpoints.length);

      for (let i = 0; i < total; i++) {
        const fallbackLine = clientLines[i] ?? 1;
        const sourceBreakpoint: DebugProtocol.SourceBreakpoint = sourceBreakpoints[i] ?? { line: fallbackLine };
        const line = clientLines[i] ?? sourceBreakpoint.line;
        // Use 1-based default column to satisfy source map resolution (resolver rejects 0)
        const column = sourceBreakpoint.column ?? 1;
        let cdpResult: Protocol.Debugger.SetBreakpointByUrlResponse | null = null;

        try {
          cdpResult = await this.placeSingleBreakpoint(path, line, column, sourceBreakpoint);
        } catch (error) {
          this.diagnostic(
            `Failed to set breakpoint at ${path}:${line}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }

        const { runtimeBp, actualBp } = this.buildBreakpointEntry(path, line, column, sourceBreakpoint, cdpResult, previousByKey);

        runtimeBreakpoints.push(runtimeBp);
        actualBreakpoints.push(actualBp);

        if (cdpResult && sourceBreakpoint.logMessage) {
          this.diagnostic(`Logpoint set at ${path}:${line} - Message: "${sourceBreakpoint.logMessage}"\n`);
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

  // Remove a single breakpoint by its DAP id without affecting siblings in the same file.
  // Sends Debugger.removeBreakpoint for one CDP id and prunes the runtime map entry.
  async removeBreakpointByDapId(dapId: number): Promise<{ removed: boolean; filePath?: string }> {
    for (const [filePath, list] of this.breakpoints.entries()) {
      const index = list.findIndex(bp => bp.dapId === dapId);

      if (index < 0) continue;

      const [bp] = list.splice(index, 1) as [NodeJSRuntimeBreakpoint];

      if (this.cdpTransport && bp.verified) {
        try {
          await this.cdpTransport.sendCommand("Debugger.removeBreakpoint", {
            breakpointId: bp.id,
          });
        } catch (error) {
          this.diagnostic(
            `Failed to remove breakpoint ${bp.id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }

      if (list.length === 0) {
        this.breakpoints.delete(filePath);
      }

      return { removed: true, filePath };
    }

    return { removed: false };
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
        this.diagnostic(
          `Failed to remove breakpoint ${bp.id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    this.breakpoints.delete(filePath);
  }

  private createLogpointExpression(logMessage: string): string {
    // Delegate to the shared logpoint helper so the runtime path and the
    // simulated path stay observationally consistent (placeholder syntax,
    // escaping order, error handling).
    return buildLogpointExpression(logMessage);
  }

  // The DAP request handlers below (continueRequest/pauseRequest/...) remain as DebugSession
  // overrides for the small subset reachable through DAP message routing. The MCP-facing path goes
  // through the public methods declared further down (continue, pause, stepIn, stepOut, next,
  // evaluate, stackTrace, scopes, variables, threads, ...) so we never depend on the DebugSession
  // protected handler chain for those operations.

  protected override async continueRequest(
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

  protected override async pauseRequest(
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

  protected override async stepInRequest(
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

  protected override async stepOutRequest(
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

  protected override async nextRequest(
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

  protected override configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    super.configurationDoneRequest(response, _args);

    // In real implementation, we could start execution here if not already started
  }

  protected override async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    void args;
    if (this.nodeProcess) {
      this.nodeProcess.kill();
      this.nodeProcess = null;
    }

    // Clean up CDP connection
    if (this.cdpTransport) {
      await this.cdpTransport.disconnect();
      this.cdpTransport = null;
    }

    this.currentCallFrames = [];
    this.variableHandles.clear();
    this.lastException = null;

    // Do NOT delegate to super.disconnectRequest here. DebugSession's default
    // implementation calls this.shutdown(), which in non-server mode invokes
    // process.exit(0) and would kill the entire MCP server hosting this
    // in-process adapter. Our DAPClient owns the adapter lifecycle and
    // re-creates it on the next attach, so all cleanup happens above.
    this.sendResponse(response);
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

    return this.okResponse<DebugProtocol.ContinueResponse>('continue', { allThreadsContinued: true });
  }

  public async pauseExecution(args?: DebugProtocol.PauseArguments): Promise<DebugProtocol.PauseResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.pause');

    return this.okResponse<DebugProtocol.PauseResponse>('pause');
  }

  public async stepIn(args?: DebugProtocol.StepInArguments): Promise<DebugProtocol.StepInResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.stepInto');

    return this.okResponse<DebugProtocol.StepInResponse>('stepIn');
  }

  public async stepOut(args?: DebugProtocol.StepOutArguments): Promise<DebugProtocol.StepOutResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.stepOut');

    return this.okResponse<DebugProtocol.StepOutResponse>('stepOut');
  }

  public async next(args?: DebugProtocol.NextArguments): Promise<DebugProtocol.NextResponse> {
    void args;
    await this.requireTransport().sendCommand('Debugger.stepOver');

    return this.okResponse<DebugProtocol.NextResponse>('next');
  }

  public threads(): DebugProtocol.ThreadsResponse {
    return this.okResponse<DebugProtocol.ThreadsResponse>('threads', {
      threads: [new Thread(NodeJSDebugAdapter.THREAD_ID, 'Main Thread')],
    });
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
        ...(sourcePath
          ? { source: { name: sourcePath.split('/').pop() ?? sourcePath, path: sourcePath } }
          : {}),
      };
    });

    return this.okResponse<DebugProtocol.StackTraceResponse>('stackTrace', {
      stackFrames,
      totalFrames: this.currentCallFrames.length,
    });
  }

  public scopes(args: DebugProtocol.ScopesArguments): DebugProtocol.ScopesResponse {
    if (args.frameId < 0 || args.frameId >= this.currentCallFrames.length) {
      throw new Error(`Frame ${args.frameId} not found`);
    }

    const frame = this.currentCallFrames[args.frameId]!;
    const dapScopes: DebugProtocol.Scope[] = frame.scopeChain.map((scope, scopeIndex) => {
      const reference = this.allocateHandle({
        kind: 'scope',
        frameIndex: args.frameId,
        scopeIndex,
        ...(scope.object.objectId !== undefined ? { objectId: scope.object.objectId } : {}),
      });
      const presentationHint = scope.type === 'local' ? 'locals' : undefined;
      const expensive = scope.type === 'global';

      return {
        name: scope.name ?? scope.type,
        ...(presentationHint !== undefined ? { presentationHint } : {}),
        variablesReference: reference,
        expensive,
      };
    });

    return this.okResponse<DebugProtocol.ScopesResponse>('scopes', { scopes: dapScopes });
  }

  public async variables(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.VariablesResponse> {
    const handle = this.variableHandles.get(args.variablesReference);

    if (!handle) {
      throw new Error(`Variable reference ${args.variablesReference} not found`);
    }

    const {objectId} = handle;

    if (objectId === undefined) {
      return this.okResponse<DebugProtocol.VariablesResponse>('variables', { variables: [] });
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
          ...(remote?.type !== undefined ? { type: remote.type } : {}),
          variablesReference: childRef,
        };
      });

    return this.okResponse<DebugProtocol.VariablesResponse>('variables', { variables });
  }

  public async evaluate(args: DebugProtocol.EvaluateArguments): Promise<DebugProtocol.EvaluateResponse> {
    const transport = this.requireTransport();
    let remote: Protocol.Runtime.RemoteObject;
    let exceptionDetails: Protocol.Runtime.ExceptionDetails | undefined;

    if (args.frameId !== undefined && this.currentCallFrames[args.frameId]) {
      const callFrame = this.currentCallFrames[args.frameId]!;
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

    return this.okResponse<DebugProtocol.EvaluateResponse>('evaluate', {
      result: this.remoteObjectToString(remote),
      type: remote.type,
      variablesReference: reference,
    });
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

    const callFrame = this.currentCallFrames[handle.frameIndex]!;
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

    return this.okResponse<DebugProtocol.SetVariableResponse>('setVariable', {
      value: this.remoteObjectToString(evalResult.result),
      type: evalResult.result.type,
      variablesReference: childRef,
    });
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

    return this.okResponse<DebugProtocol.LoadedSourcesResponse>('loadedSources', { sources });
  }

  public exceptionInfo(args: DebugProtocol.ExceptionInfoArguments): DebugProtocol.ExceptionInfoResponse {
    void args;

    const ex = this.lastException;

    if (!ex) {
      throw new Error('No exception information available');
    }

    return this.okResponse<DebugProtocol.ExceptionInfoResponse>('exceptionInfo', {
      exceptionId: String(ex.exceptionId),
      description: ex.exception?.description ?? ex.text,
      breakMode: this.exceptionPauseState === 'all' ? 'always' : 'unhandled',
    });
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

    return this.okResponse<DebugProtocol.SetExceptionBreakpointsResponse>('setExceptionBreakpoints', {
      breakpoints: filters.map(() => ({ verified: true })),
    });
  }

  public async breakpointLocations(
    args: DebugProtocol.BreakpointLocationsArguments,
  ): Promise<DebugProtocol.BreakpointLocationsResponse> {
    const path = args.source.path ?? '';
    const scriptId = await this.getScriptIdForPath(path, 200);

    if (!scriptId) {
      return this.okResponse<DebugProtocol.BreakpointLocationsResponse>('breakpointLocations', {
        breakpoints: [],
      });
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
      columnNumber: args.endColumn !== undefined ? Math.max(0, args.endColumn - 1) : END_COLUMN_LARGE,
    };
    const possible = await transport.sendCommand<Protocol.Debugger.GetPossibleBreakpointsResponse>(
      'Debugger.getPossibleBreakpoints',
      { start, end, restrictToFunction: false },
    );
    const breakpoints: DebugProtocol.BreakpointLocation[] = possible.locations.map(loc => ({
      line: loc.lineNumber + 1,
      column: (loc.columnNumber ?? 0) + 1,
    }));

    return this.okResponse<DebugProtocol.BreakpointLocationsResponse>('breakpointLocations', { breakpoints });
  }

  public async restartFrame(
    args: DebugProtocol.RestartFrameArguments,
  ): Promise<DebugProtocol.RestartFrameResponse> {
    if (args.frameId < 0 || args.frameId >= this.currentCallFrames.length) {
      throw new Error(`Frame ${args.frameId} not found`);
    }

    const frame = this.currentCallFrames[args.frameId]!;

    await this.requireTransport().sendCommand('Debugger.restartFrame', { callFrameId: frame.callFrameId });

    return this.okResponse<DebugProtocol.RestartFrameResponse>('restartFrame');
  }

  public goto(args: DebugProtocol.GotoArguments): DebugProtocol.GotoResponse {
    void args;
    // The V8 inspector does not expose a primitive jump operation; surface a
    // descriptive error so the MCP client knows the operation is impossible
    // here, not just temporarily failing.
    throw new Error(
      'goto is not supported by the Node.js inspector: V8 has no primitive jump operation; ' +
      'use restartFrame to rerun a stack frame or set a breakpoint and continue/pause to navigate',
    );
  }

  public async terminate(): Promise<DebugProtocol.TerminateResponse> {
    if (this.nodeProcess) {
      this.nodeProcess.kill();
      this.nodeProcess = null;
    }

    if (this.cdpTransport) {
      await this.cdpTransport.disconnect();
      this.cdpTransport = null;
    }

    return this.okResponse<DebugProtocol.TerminateResponse>('terminate');
  }

  public async restart(): Promise<DebugProtocol.RestartResponse> {
    // Best-effort: detach and re-attach is the responsibility of the caller; we just clean state.
    this.currentCallFrames = [];
    this.variableHandles.clear();
    this.lastException = null;

    return this.okResponse<DebugProtocol.RestartResponse>('restart');
  }

  // Method to simulate logpoint hit - would be called from DAP runtime events
  public simulateLogpointHit(filePath: string, line: number, variables: Record<string, unknown>): void {
    const breakpoints = this.breakpoints.get(filePath) ?? [];
    const logpoint = breakpoints.find((bp) => bp.line === line && bp.logMessage);

    if (logpoint?.logMessage) {
      // Mirror the runtime path: extract the same placeholders, resolve them
      // against the provided static variables map, then render the message via
      // the shared helper so this path stays observationally consistent.
      const exprs = extractLogpointPlaceholders(logpoint.logMessage);
      const vars: Record<string, unknown> = {};

      for (const expr of exprs) {
        vars[expr] = lookupDottedPath(expr, variables);
      }

      const message = renderLogpointMessage(logpoint.logMessage, vars);
      const payload = { message, vars, time: Date.now() };

      // Emit custom event like runtime binding path
      this.sendEvent(new DAEvent('mcpLogpoint', {
        executionContextId: 0,
        name: '__mcpLogPoint',
        payload: JSON.stringify(payload),
      }));
    }
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
