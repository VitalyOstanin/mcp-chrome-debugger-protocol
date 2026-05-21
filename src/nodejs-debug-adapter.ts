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
import { setTimeout as sleep, setTimeout as setTimeoutP } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CDPTransport, type CDPConnection } from './cdp-transport.js';
import type { Protocol } from 'devtools-protocol';
import { SourceMapResolver, type SourceMapResolution } from './source-map-resolver.js';
import {
  buildLogpointExpression,
  extractLogpointPlaceholders,
  lookupDottedPath,
  renderLogpointMessage,
} from './logpoint.js';
import {
  BREAKPOINT_SEARCH_WINDOWS,
  DAP_ERROR_CODES,
  DEFAULT_THREAD_ID,
  DEFAULTS,
  END_COLUMN_LARGE,
} from './constants.js';
import { errorMessage, mapWithConcurrency } from './utils.js';
import { NotConnectedError, NotFoundError, ProtocolError, ValidationError } from './errors.js';
import { isVerbose } from './logger.js';
import safeStringify from 'safe-stable-stringify';

// The @vscode/debugadapter Breakpoint class does not publish source/id in its
// public type, but DebugProtocol.Breakpoint requires them. Centralise the cast
// in one helper so the rest of the adapter stays type-safe.
function assignDapBreakpointFields(
  bp: Breakpoint,
  fields: Pick<DebugProtocol.Breakpoint, 'source' | 'id' | 'message'>,
): void {
  const target = bp as unknown as DebugProtocol.Breakpoint;

  if (fields.source !== undefined) target.source = fields.source;
  if (fields.id !== undefined) target.id = fields.id;
  if (fields.message !== undefined) target.message = fields.message;
}

interface BreakpointPlacement {
  cdpResult: Protocol.Debugger.SetBreakpointByUrlResponse | null;
  reason?: string;
  // Full source-map resolution captured during placement so DAPDebuggerManager
  // does not have to re-run resolveSourceMapPosition for tracking metadata.
  // Undefined when the source was not TS/TSX or resolution did not succeed.
  sourceMapResolution?: SourceMapResolution;
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
  // Re-exposed locally so call sites read NodeJSDebugAdapter.THREAD_ID instead
  // of pulling in DEFAULT_THREAD_ID at every reference. Both literals are the
  // same and resolve to the canonical constant in src/constants.ts.
  private static readonly THREAD_ID = DEFAULT_THREAD_ID;

  private nodeProcess: ChildProcess | null = null;
  private readonly breakpoints = new Map<string, NodeJSRuntimeBreakpoint[]>();
  // Resolution metadata keyed by DAP id, captured during placeSingleBreakpoint.
  // Lets DAPDebuggerManager track the TS->JS hop without re-running the (cached
  // but not free) resolveSourceMapPosition pass for every actual breakpoint.
  private readonly breakpointSourceMapResolutions = new Map<number, SourceMapResolution>();
  private nextBreakpointId = 1;
  // In-memory tally of swallowed errors per CDP event type. We diagnostic() the
  // individual failures (visible only with DAP_VERBOSE=1), but the counter is
  // exposed through getDebuggerState so operators can spot a silent regression
  // -- e.g. a CDP payload format drift that newly breaks bindingCalled forward
  // -- without first toggling verbose mode on a hot session.
  private readonly eventErrorCounts = new Map<string, number>();
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
  // Long-running debug sessions can see tens of thousands of Debugger.scriptParsed
  // events (eval/vm code, dynamic imports). Cap the cache so memory stays bounded;
  // eviction order is insertion (Map preserves it), which approximates LRU well
  // enough for a cache only used for stackTrace/loadedSources lookups.
  private static readonly MAX_SCRIPTS = 5000;

  private diagnostic(message: string): void {
    if (!isVerbose()) return;
    this.sendEvent(new OutputEvent(message, "console"));
  }

  private bumpEventErrorCount(eventType: string): void {
    this.eventErrorCounts.set(eventType, (this.eventErrorCounts.get(eventType) ?? 0) + 1);
  }

  /**
   * Snapshot of swallowed errors per CDP event handler. Exposed via
   * getDebuggerState so operators can detect a silent regression without
   * enabling DAP_VERBOSE on a hot session.
   */
  public getEventErrorCounts(): Record<string, number> {
    return Object.fromEntries(this.eventErrorCounts);
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
  private exceptionPauseState: 'none' | 'caught' | 'uncaught' | 'all' = 'none';

  private async getScriptIdForPath(
    targetPath: string,
    timeoutMs: number = DEFAULTS.SCRIPT_LOOKUP_DEFAULT_TIMEOUT_MS,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    // pathToFileURL handles platform quirks: on Windows it produces 'file:///C:/...'
    // (RFC 8089-compliant), where naive 'file://' + path prefix produces an
    // invalid URL that no script lookup will match.
    const fileUrl = pathToFileURL(targetPath).href;
    const tryGet = () => this.scriptsByUrl.get(fileUrl) ?? this.scriptsByUrl.get(targetPath);
    let scriptId = tryGet();

    while (!scriptId && Date.now() < deadline) {
      // Small delay to allow scriptParsed events to arrive after Debugger.enable
      await sleep(DEFAULTS.SCRIPT_LOOKUP_POLL_INTERVAL_MS);
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

  // Drop the oldest cached script and the URL/basename index entries pointing
  // at it. Called from handleCDPEvent when scriptsById exceeds MAX_SCRIPTS so a
  // long-running session does not grow the cache without bound.
  private evictOldestScript(): void {
    const oldestEntry = this.scriptsById.entries().next();

    if (oldestEntry.done) return;

    const [scriptId, event] = oldestEntry.value;

    this.scriptsById.delete(scriptId);

    if (!event.url) return;

    const aliases = [event.url];

    if (event.url.startsWith("file://")) {
      aliases.push(event.url.replace(/^file:\/\//, ""));
    }

    for (const url of aliases) {
      if (this.scriptsByUrl.get(url) === scriptId) {
        this.scriptsByUrl.delete(url);
      }

      const basename = url.split("/").pop();

      if (!basename) continue;

      const bucket = this.scriptsByBasename.get(basename);

      if (!bucket) continue;
      bucket.delete(url);
      if (bucket.size === 0) {
        this.scriptsByBasename.delete(basename);
      }
    }

    // The script may be re-parsed under a new scriptId (re-import, HMR);
    // the CDP breakpoint id we stored is no longer addressable, and the
    // breakpoint will not re-apply on the new script without re-setBreakpoints.
    // Mark verified=false so DAPDebuggerManager / clients see the stale state
    // instead of trusting a breakpoint that is no longer live in V8.
    this.markBreakpointsUnverifiedForUrl(event.url);
  }

  private markBreakpointsUnverifiedForUrl(scriptUrl: string): void {
    let filePath: string | undefined;

    if (scriptUrl.startsWith("file://")) {
      try {
        filePath = fileURLToPath(scriptUrl);
      } catch {
        return;
      }
    } else {
      filePath = scriptUrl;
    }

    const list = this.breakpoints.get(filePath);

    if (!list) return;

    for (const bp of list) {
      bp.verified = false;
    }
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
        this.sendErrorResponse(response, DAP_ERROR_CODES.LAUNCH_PROGRAM_REQUIRED, "Program path is required");

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
        throw new ProtocolError("Failed to launch Node.js process");
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
        DAP_ERROR_CODES.LAUNCH_FAILED,
        `Launch failed: ${errorMessage(error)}`,
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
        DAP_ERROR_CODES.ATTACH_FAILED,
        `Attach failed: ${errorMessage(error)}`,
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
        new OutputEvent(`Attach failed: ${errorMessage(error)}\n`, "stderr"),
      );

      return { success: false, message: errorMessage(error) };
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
            errorMessage(error)
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
        new OutputEvent(`Source map path overrides: ${safeStringify(args.sourceMapPathOverrides)}\n`, "console"),
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

    // Per-attach setup (enableDomains, Runtime.addBinding) lives on the CDP
    // client object; after reconnect the client is replaced and that setup
    // must run again, otherwise logpoints stop delivering bindingCalled
    // because no binding is registered on the new client.
    this.cdpTransport.on("reconnected", () => {
      void this.handleCDPReconnected();
    });

    this.cdpTransport.on("error", (error: Error) => {
      this.sendEvent(new OutputEvent(`CDP Error: ${error.message}\n`, "stderr"));
    });

    this.cdpTransport.on("cdp-event", (event: { method: string; params: unknown }) => {
      this.handleCDPEvent(event);
    });
  }

  private async handleCDPReconnected(): Promise<void> {
    if (!this.cdpTransport) return;

    try {
      await this.cdpTransport.enableDomains(["Runtime", "Debugger", "Console", "Profiler"]);
    } catch (error) {
      this.bumpEventErrorCount("reconnect.enableDomains");
      this.diagnostic(`enableDomains after reconnect failed: ${errorMessage(error)}`);
    }

    try {
      await this.cdpTransport.sendCommand(
        "Runtime.addBinding",
        { name: "__mcpLogPoint" },
      );
    } catch (error) {
      this.bumpEventErrorCount("reconnect.addBinding");
      this.sendEvent(
        new OutputEvent(
          `Failed to reinstall Runtime.addBinding after reconnect: ${
            errorMessage(error)
          }\n`,
          "console",
        ),
      );
    }
  }

  private handleCDPEvent(event: { method: string; params: unknown }): void {
    switch (event.method) {
      case "Debugger.scriptParsed": {
        const params = event.params as Protocol.Debugger.ScriptParsedEvent;

        this.scriptsById.set(params.scriptId, params);
        while (this.scriptsById.size > NodeJSDebugAdapter.MAX_SCRIPTS) {
          this.evictOldestScript();
        }
        if (params.url) {
          this.indexScriptUrl(params.url, params.scriptId);
          if (params.url.startsWith("file://")) {
            // Also map plain absolute path
            try {
              const plain = params.url.replace(/^file:\/\//, "");

              this.indexScriptUrl(plain, params.scriptId);
            } catch (error) {
              // Indexing the plain-path alias is best-effort: the file:// URL
              // form is already indexed above, so a malformed plain path only
              // costs us the cheap basename-lookup shortcut.
              this.bumpEventErrorCount('Debugger.scriptParsed');
              this.diagnostic(`indexScriptUrl(plain) failed for ${params.url}: ${errorMessage(error)}`);
            }
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
        } catch (error) {
          // addBinding can race a context being torn down before we install
          // the binding; fall through silently. New contexts retry on their
          // own executionContextCreated event.
          this.bumpEventErrorCount('Runtime.executionContextCreated');
          this.diagnostic(`Runtime.addBinding for new context failed: ${errorMessage(error)}`);
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
        // Forward logpoint binding payload to client via a custom DAP event.
        try {
          const params = event.params as Protocol.Runtime.BindingCalledEvent;

          this.sendEvent(
            new DAEvent('mcpLogpoint', {
              executionContextId: params.executionContextId,
              name: params.name,
              payload: params.payload,
            }),
          );
        } catch (error) {
          // Surface in DAP_VERBOSE so a misshapen binding payload from the
          // logpoint expression does not silently disappear.
          this.bumpEventErrorCount('Runtime.bindingCalled');
          this.diagnostic(`bindingCalled forward failed: ${errorMessage(error)}`);
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
  ): Promise<{
    targetPath: string;
    targetLine: number;
    targetColumn: number;
    sourceMapResolution?: SourceMapResolution;
  }> {
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
          sourceMapResolution,
        };
      }
    } catch (error) {
      this.diagnostic(
        `Source map resolution failed for ${path}:${line}: ${
          errorMessage(error)
        }\n`,
      );
    }

    return { targetPath: path, targetLine: line, targetColumn: column };
  }

  // Attempt scriptId-based placement (most reliable when scripts are loaded).
  // Returns updated location info plus the cdpResult, or null if placement failed.
  // Ask V8 for the possible breakpoint locations in a [baseLine0+startDelta,
  // baseLine0+endDelta] window and pick the best match — first location at or
  // after the requested column, otherwise the location closest to baseLine0.
  // Lines/columns here are 0-based (CDP coordinate system).
  private async findBreakpointLocationInRange(
    scriptId: string,
    baseLine0: number,
    baseCol0: number,
    startDelta: number,
    endDelta: number,
  ): Promise<{ location: Protocol.Debugger.BreakLocation; moved: boolean } | undefined> {
    if (!this.cdpTransport) return undefined;

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
    const possible = await this.cdpTransport.sendCommand<Protocol.Debugger.GetPossibleBreakpointsResponse>(
      "Debugger.getPossibleBreakpoints",
      { start, end, restrictToFunction: false },
    );
    const locs = possible.locations;

    if (!locs.length) return undefined;

    const after = locs.filter(
      (l) => l.lineNumber > baseLine0 || (l.lineNumber === baseLine0 && (l.columnNumber ?? 0) >= baseCol0),
    );

    if (after.length) return { location: after[0]!, moved: false };

    // No statement at or beyond the requested position within the search
    // window — fall back to the nearest available statement and flag it so the
    // caller can surface a DAP Breakpoint.message explaining the shift.
    const fallback = locs.slice().sort(
      (a, b) => Math.abs(a.lineNumber - baseLine0) - Math.abs(b.lineNumber - baseLine0),
    )[0];

    if (!fallback) return undefined;

    return { location: fallback, moved: true };
  }

  private async placeBreakpointByScriptId(
    targetPath: string,
    targetLine: number,
    targetColumn: number,
    breakpointCondition: string | undefined,
  ): Promise<{ cdpResult: Protocol.Debugger.SetBreakpointByUrlResponse; line: number; column: number; reason?: string } | null> {
    if (!this.cdpTransport) return null;

    const scriptId = await this.getScriptIdForPath(targetPath, DEFAULTS.BREAKPOINT_SCRIPT_LOOKUP_TIMEOUT_MS);

    this.diagnostic(`Breakpoint target ${targetPath} → scriptId=${scriptId ?? "not-found"}\n`);

    if (!scriptId) return null;

    try {
      const baseLine0 = Math.max(0, targetLine - 1);
      const baseCol0 = Math.max(0, targetColumn - 1);
      // Walk the configured fallback windows: each retry widens the search so
      // a slightly off column still resolves to the nearest valid statement.
      let chosen: { location: Protocol.Debugger.BreakLocation; moved: boolean } | undefined;

      for (const [startDelta, endDelta] of BREAKPOINT_SEARCH_WINDOWS) {
        chosen = await this.findBreakpointLocationInRange(scriptId, baseLine0, baseCol0, startDelta, endDelta);
        if (chosen) break;
      }

      if (!chosen) return null;

      this.diagnostic(
        `getPossibleBreakpoints picked ${targetPath}:${chosen.location.lineNumber + 1}:${
          (chosen.location.columnNumber ?? 0) + 1
        }${chosen.moved ? ' (moved to nearest available statement)' : ''}\n`,
      );

      const setResp = await this.cdpTransport.sendCommand<Protocol.Debugger.SetBreakpointResponse>(
        "Debugger.setBreakpoint",
        { location: chosen.location, condition: breakpointCondition },
      );

      return {
        cdpResult: {
          breakpointId: setResp.breakpointId,
          locations: [setResp.actualLocation],
        },
        line: setResp.actualLocation.lineNumber + 1,
        column: (setResp.actualLocation.columnNumber ?? chosen.location.columnNumber ?? 0) + 1,
        ...(chosen.moved ? { reason: 'moved to nearest available statement' } : {}),
      };
    } catch (error) {
      // Caller will fall through to URL-based placement. Emit a diagnostic so
      // a regression in getPossibleBreakpoints / setBreakpoint isn't masked
      // when the URL fallback also fails -- otherwise only the URL-side error
      // surfaces and the original cause is lost.
      this.diagnostic(
        `scriptId-based placement failed: ${errorMessage(error)}; falling back to URL placement\n`,
      );

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
      throw new NotConnectedError('CDP transport not available');
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
    } catch (error) {
      // Exact-URL placement can fail when V8 normalises the script URL
      // differently (case, symlinks, percent-encoding). Fall through to a
      // urlRegex match before giving up.
      this.diagnostic(`setBreakpointByUrl exact-url failed: ${errorMessage(error)}; retrying via urlRegex`);

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
  ): Promise<BreakpointPlacement> {
    if (!this.cdpTransport) {
      return { cdpResult: null, reason: 'CDP transport not available' };
    }

    const { targetPath, targetLine, targetColumn, sourceMapResolution } =
      await this.resolveTargetLocation(path, line, column);
    // For logpoints, swap the user condition for the synthetic logpoint expression.
    const breakpointCondition = sourceBreakpoint.logMessage
      ? this.createLogpointExpression(sourceBreakpoint.logMessage)
      : sourceBreakpoint.condition;
    const scriptIdResult = await this.placeBreakpointByScriptId(targetPath, targetLine, targetColumn, breakpointCondition);

    if (scriptIdResult) {
      return {
        cdpResult: scriptIdResult.cdpResult,
        ...(scriptIdResult.reason !== undefined ? { reason: scriptIdResult.reason } : {}),
        ...(sourceMapResolution !== undefined ? { sourceMapResolution } : {}),
      };
    }

    const urlResult = await this.placeBreakpointByUrl(targetPath, targetLine, targetColumn, breakpointCondition);

    return {
      cdpResult: urlResult,
      ...(sourceMapResolution !== undefined ? { sourceMapResolution } : {}),
    };
  }

  // Build the runtime + DAP breakpoint pair, reusing prior dapId when signature matches.
  private buildBreakpointEntry(
    path: string,
    line: number,
    column: number,
    sourceBreakpoint: DebugProtocol.SourceBreakpoint,
    placement: BreakpointPlacement,
    previousByKey: Map<string, number>,
  ): { runtimeBp: NodeJSRuntimeBreakpoint; actualBp: Breakpoint } {
    const key = this.breakpointKey(line, column, sourceBreakpoint.condition, sourceBreakpoint.logMessage);
    const dapId = previousByKey.get(key) ?? this.nextBreakpointId++;

    previousByKey.delete(key);

    // Use a separate counter for synthetic CDP-style ids so they never collide
    // with the DAP id range (`dapId` consumes nextBreakpointId).
    const breakpointId = placement.cdpResult?.breakpointId ?? `bp_${this.nextSyntheticCdpId++}`;
    const verified = placement.cdpResult !== null;
    const runtimeBp: NodeJSRuntimeBreakpoint = {
      id: breakpointId,
      dapId,
      line,
      column,
      verified,
      condition: sourceBreakpoint.condition,
      logMessage: sourceBreakpoint.logMessage,
    };

    if (placement.sourceMapResolution) {
      this.breakpointSourceMapResolutions.set(dapId, placement.sourceMapResolution);
    } else {
      // A re-placement that no longer hops TS->JS (file changed, source-map
      // dropped) must not keep the previous resolution under the same dapId.
      this.breakpointSourceMapResolutions.delete(dapId);
    }

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
      // Surface placement context in DAP Breakpoint.message so DAP clients
      // (and the MCP setBreakpoints tool response) can show the user *why*
      // their breakpoint was greyed out (verified=false) or *why* the actual
      // line drifted from the requested one (e.g. "moved to nearest available
      // statement" when V8 had no statement at the requested column).
      ...(placement.reason !== undefined ? { message: placement.reason } : {}),
    });

    return { runtimeBp, actualBp };
  }

  protected override async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    const { path } = args.source;

    if (!path) {
      this.sendErrorResponse(response, DAP_ERROR_CODES.SET_BREAKPOINTS_FAILED, "Source path is required");

      return;
    }

    // Track which phase of setBreakpoints we're in so the catch can tell the
    // caller which step failed: a clear-vs-place-vs-build failure used to give
    // an identical "Set breakpoints failed: ..." message.
    let stage: 'snapshot' | 'clear' | 'place' | 'build' = 'snapshot';

    try {
      const clientLines = args.lines ?? [];
      const sourceBreakpoints = args.breakpoints ?? [];
      // DAP setBreakpoints replaces the file's breakpoint list, but real DAP clients
      // expect ids to stay stable for breakpoints whose location/condition/logMessage
      // hasn't changed. Snapshot the previous entries by signature so the loop below
      // can reuse the existing dapId when it sees the same breakpoint coming back.
      const previousByKey = this.snapshotPreviousDapIds(path);

      stage = 'clear';
      // Clear previous breakpoints for this file via CDP
      await this.clearCDPBreakpoints(path);
      stage = 'place';

      const actualBreakpoints: Breakpoint[] = [];
      const runtimeBreakpoints: NodeJSRuntimeBreakpoint[] = [];
      const total = Math.max(clientLines.length, sourceBreakpoints.length);

      interface PlacedBreakpointSlot {
        line: number;
        column: number;
        sourceBreakpoint: DebugProtocol.SourceBreakpoint;
        placement: BreakpointPlacement;
      }

      // Resolve every requested breakpoint with bounded parallelism: each
      // placement is an independent CDP roundtrip and a getPossibleBreakpoints
      // lookup, so a file with N breakpoints used to pay N sequential network
      // hops. The *id allocation* loop below stays sequential so dapId /
      // synthetic CDP id assignment remains deterministic across reruns.
      // Cap at SET_BREAKPOINTS_CONCURRENCY so a file with hundreds of points
      // can't fan out hundreds of concurrent CDP requests at once.
      const indices = Array.from({ length: total }, (_, i) => i);
      const placedSlots: PlacedBreakpointSlot[] = await mapWithConcurrency(
        indices,
        DEFAULTS.SET_BREAKPOINTS_CONCURRENCY,
        async (i): Promise<PlacedBreakpointSlot> => {
          const fallbackLine = clientLines[i] ?? 1;
          const sourceBreakpoint: DebugProtocol.SourceBreakpoint = sourceBreakpoints[i] ?? { line: fallbackLine };
          const line = clientLines[i] ?? sourceBreakpoint.line;
          // Use 1-based default column to satisfy source map resolution (resolver rejects 0)
          const column = sourceBreakpoint.column ?? 1;

          try {
            const placement = await this.placeSingleBreakpoint(path, line, column, sourceBreakpoint);

            return { line, column, sourceBreakpoint, placement };
          } catch (error) {
            const reason = errorMessage(error);

            this.diagnostic(`Failed to set breakpoint at ${path}:${line}: ${reason}\n`);

            return { line, column, sourceBreakpoint, placement: { cdpResult: null, reason } };
          }
        },
      );

      stage = 'build';
      for (const slot of placedSlots) {
        const { line, column, sourceBreakpoint, placement } = slot;
        const { runtimeBp, actualBp } = this.buildBreakpointEntry(path, line, column, sourceBreakpoint, placement, previousByKey);

        runtimeBreakpoints.push(runtimeBp);
        actualBreakpoints.push(actualBp);

        if (placement.cdpResult && sourceBreakpoint.logMessage) {
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
        DAP_ERROR_CODES.SET_BREAKPOINTS_FAILED,
        `Set breakpoints failed at stage=${stage}: ${errorMessage(error)}`,
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
            `Failed to remove breakpoint ${bp.id}: ${errorMessage(error)}\n`,
          );
        }
      }

      this.breakpointSourceMapResolutions.delete(dapId);

      if (list.length === 0) {
        this.breakpoints.delete(filePath);
      }

      return { removed: true, filePath };
    }

    return { removed: false };
  }

  /**
   * Source-map resolution captured during placeSingleBreakpoint for the given
   * DAP id, or undefined if the breakpoint did not hop TS->JS (or has been
   * removed). DAPDebuggerManager uses this to skip the redundant resolve pass.
   */
  public getBreakpointSourceMapResolution(dapId: number): SourceMapResolution | undefined {
    return this.breakpointSourceMapResolutions.get(dapId);
  }

  private async clearCDPBreakpoints(filePath: string): Promise<void> {
    const existingBreakpoints = this.breakpoints.get(filePath) ?? [];
    const transport = this.cdpTransport;

    // chrome-remote-interface dispatches by request id, so several
    // removeBreakpoint calls can race safely; this collapses N sequential
    // round-trips into one when a file has many bound breakpoints.
    await Promise.all(existingBreakpoints.map(async (bp) => {
      if (!transport || !bp.verified) return;

      try {
        await transport.sendCommand("Debugger.removeBreakpoint", { breakpointId: bp.id });
      } catch (error) {
        this.diagnostic(`Failed to remove breakpoint ${bp.id}: ${errorMessage(error)}\n`);
      }
    }));

    for (const bp of existingBreakpoints) {
      if (bp.dapId !== undefined) {
        this.breakpointSourceMapResolutions.delete(bp.dapId);
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

  private async runCdpExecutionCommand(
    cdpMethod: string,
    response: DebugProtocol.Response,
    errorCode: number,
    label: string,
    prepareBody?: () => void,
  ): Promise<void> {
    try {
      if (this.cdpTransport) {
        await this.cdpTransport.sendCommand(cdpMethod);
      }
      prepareBody?.();
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, errorCode, `${label} failed: ${errorMessage(error)}`);
    }
  }

  protected override async continueRequest(
    response: DebugProtocol.ContinueResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.ContinueArguments,
  ): Promise<void> {
    await this.runCdpExecutionCommand("Debugger.resume", response, DAP_ERROR_CODES.CONTINUE_FAILED, "Continue", () => {
      response.body = { allThreadsContinued: true };
    });
  }

  protected override async pauseRequest(
    response: DebugProtocol.PauseResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.PauseArguments,
  ): Promise<void> {
    await this.runCdpExecutionCommand("Debugger.pause", response, DAP_ERROR_CODES.PAUSE_FAILED, "Pause");
  }

  protected override async stepInRequest(
    response: DebugProtocol.StepInResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.StepInArguments,
  ): Promise<void> {
    await this.runCdpExecutionCommand("Debugger.stepInto", response, DAP_ERROR_CODES.STEP_IN_FAILED, "Step into");
  }

  protected override async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.StepOutArguments,
  ): Promise<void> {
    await this.runCdpExecutionCommand("Debugger.stepOut", response, DAP_ERROR_CODES.STEP_OUT_FAILED, "Step out");
  }

  protected override async nextRequest(
    response: DebugProtocol.NextResponse,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: DebugProtocol.NextArguments,
  ): Promise<void> {
    await this.runCdpExecutionCommand("Debugger.stepOver", response, DAP_ERROR_CODES.NEXT_FAILED, "Step over");
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
    await this.killNodeProcessWithFallback();

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
      throw new NotConnectedError('Not attached to a debugger');
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
      if (typeof remote.value === 'string') {
        return remote.value;
      }

      return safeStringify(remote.value) ?? String(remote.value);
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
    // currentCallFrames is only populated by Debugger.paused. If the debuggee
    // is running, return an empty scopes list (with a clear name) instead of
    // throwing "Frame N not found" — the latter masks the real reason.
    if (this.currentCallFrames.length === 0) {
      return this.okResponse<DebugProtocol.ScopesResponse>('scopes', {
        scopes: [{ name: '(debuggee not paused)', variablesReference: 0, expensive: false }],
      });
    }

    if (args.frameId < 0 || args.frameId >= this.currentCallFrames.length) {
      throw new NotFoundError(`Frame ${args.frameId} not found`);
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
      throw new NotFoundError(`Variable reference ${args.variablesReference} not found`);
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
      throw new ProtocolError(exceptionDetails.exception?.description ?? exceptionDetails.text);
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
      throw new ValidationError('setVariable is only supported on scope references');
    }

    if (handle.frameIndex < 0 || handle.frameIndex >= this.currentCallFrames.length) {
      throw new NotFoundError(`Frame ${handle.frameIndex} not found`);
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
      throw new ProtocolError(evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails.text);
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
      throw new NotFoundError('No exception information available');
    }

    // CDP Debugger.setPauseOnExceptions state -> DAP ExceptionBreakMode:
    //   'none'     -> 'never'      (no pause configured)
    //   'uncaught' -> 'unhandled'  (pause only on unhandled exceptions)
    //   'all'      -> 'always'     (pause on every exception)
    //   'caught'   -> 'always'     (DAP has no exact equivalent; 'always' is the
    //                               closest canonical value -- a pause does occur)
    const breakMode: DebugProtocol.ExceptionBreakMode =
      this.exceptionPauseState === 'all' || this.exceptionPauseState === 'caught' ? 'always'
        : this.exceptionPauseState === 'uncaught' ? 'unhandled'
          : 'never';

    return this.okResponse<DebugProtocol.ExceptionInfoResponse>('exceptionInfo', {
      exceptionId: String(ex.exceptionId),
      description: ex.exception?.description ?? ex.text,
      breakMode,
    });
  }

  public async setExceptionBreakpoints(
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): Promise<DebugProtocol.SetExceptionBreakpointsResponse> {
    let state: 'none' | 'caught' | 'uncaught' | 'all' = 'none';
    const {filters} = args;

    // CDP Debugger.setPauseOnExceptions supports four states (none/caught/uncaught/all).
    // The previous mapping silently dropped filters=['caught'] to state='none' while
    // reporting verified=true, leaving the caller convinced the filter was honoured.
    if (filters.includes('all') || (filters.includes('caught') && filters.includes('uncaught'))) {
      state = 'all';
    } else if (filters.includes('uncaught')) {
      state = 'uncaught';
    } else if (filters.includes('caught')) {
      state = 'caught';
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
    const scriptId = await this.getScriptIdForPath(path, DEFAULTS.BREAKPOINT_LOCATIONS_LOOKUP_TIMEOUT_MS);

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
      throw new NotFoundError(`Frame ${args.frameId} not found`);
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
    throw new ValidationError(
      'goto is not supported by the Node.js inspector: V8 has no primitive jump operation; ' +
      'use restartFrame to rerun a stack frame or set a breakpoint and continue/pause to navigate',
    );
  }

  public async terminate(): Promise<DebugProtocol.TerminateResponse> {
    await this.killNodeProcessWithFallback();

    if (this.cdpTransport) {
      await this.cdpTransport.disconnect();
      this.cdpTransport = null;
    }

    return this.okResponse<DebugProtocol.TerminateResponse>('terminate');
  }

  /**
   * Send SIGTERM to the spawned debuggee, then escalate to SIGKILL if it does
   * not exit within the timeout. nodeProcess.kill() defaults to SIGTERM which
   * a CPU-bound or signal-ignoring debuggee can stall on indefinitely.
   */
  private async killNodeProcessWithFallback(timeoutMs: number = DEFAULTS.NODE_PROCESS_KILL_TIMEOUT_MS): Promise<void> {
    const proc = this.nodeProcess;

    if (!proc) return;

    this.nodeProcess = null;

    // Already exited before disconnect/terminate raced in.
    if (proc.exitCode !== null || proc.signalCode !== null) return;

    try {
      proc.kill('SIGTERM');
    } catch (error) {
      this.diagnostic(`SIGTERM to debuggee failed: ${errorMessage(error)}\n`);
    }

    const exited = new Promise<boolean>((resolve) => {
      proc.once('exit', () => { resolve(true); });
    });
    const timed = setTimeoutP(timeoutMs).then(() => false);
    const cleanExit = await Promise.race([exited, timed]);

    if (!cleanExit) {
      try {
        proc.kill('SIGKILL');
      } catch (error) {
        this.diagnostic(`SIGKILL to debuggee failed: ${errorMessage(error)}\n`);
      }
    }
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
    // Use filter, not find — DAP allows multiple logpoints on the same line
    // (different messages / conditions). Emitting only the first hit would
    // silently drop the others.
    const logpoints = breakpoints.filter((bp) => bp.line === line && bp.logMessage);

    for (const logpoint of logpoints) {
      if (!logpoint.logMessage) continue;

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

      this.sendEvent(new DAEvent('mcpLogpoint', {
        executionContextId: 0,
        name: '__mcpLogPoint',
        payload: safeStringify(payload),
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
