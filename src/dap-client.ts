import { EventEmitter } from 'node:events';
import { z } from 'zod';
import safeStringify from 'safe-stable-stringify';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { NodeJSDebugAdapter, type NodeJSLaunchRequestArguments, type NodeJSAttachRequestArguments } from './nodejs-debug-adapter.js';
import type { SourceMapResolution } from './source-map-resolver.js';
import type { LogpointHit, DebuggerEvent, TrackedBreakpoint } from './types.js';
import { createSuccessResponse, createErrorResponse, errorMessage, type MCPResponse } from './utils.js';
import { NotConnectedError, ProtocolError, ValidationError } from './errors.js';
import { DEFAULTS, INSPECTOR_PORT_RANGE } from './constants.js';
import { logVerbose, logError } from './logger.js';
import { kill } from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout as scheduleTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import http from 'node:http';

// Bounded FIFO buffer with O(1) push and amortised O(1) drop-oldest. The previous
// implementation used Array.splice(0, n), which is O(n) on every overflow and
// dominated CPU under high logpoint hit rates.
class RingBuffer<T> {
  private items: Array<T | undefined>;
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    const tail = (this.head + this.size) % this.capacity;

    this.items[tail] = item;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      // Drop the oldest entry by advancing head; the slot just written becomes the newest.
      this.head = (this.head + 1) % this.capacity;
    }
  }

  toArray(): T[] {
    return this.slice(0, this.size);
  }

  // Logical-order paginated read: [offset, offset+limit). offset>=size returns [].
  // Callers can avoid materialising the entire buffer just to look at a tail or
  // a window — important for getLogpointHits/getDebuggerEvents where the wire
  // payload would otherwise grow with MAX_BUFFER_SIZE regardless of need.
  slice(offset: number, limit: number): T[] {
    if (offset < 0) offset = 0;
    if (limit < 0) limit = 0;

    const start = Math.min(offset, this.size);
    const end = Math.min(this.size, start + limit);
    const out: T[] = new Array<T>(end - start);

    for (let i = start; i < end; i++) {
      const item = this.items[(this.head + i) % this.capacity];

      if (item === undefined) {
        // Invariant: push() only ever writes T, and we read exactly `size` slots
        // starting at `head`. Reaching this branch means push() was bypassed
        // (corrupted internal state) — fail loudly instead of leaking undefined.
        throw new Error(`RingBuffer invariant violated: missing item at logical index ${i}`);
      }
      out[i - start] = item;
    }

    return out;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}

export interface DAPConnection {
  adapter: NodeJSDebugAdapter | null;
  isConnected: boolean;
}

/**
 * Bridge between the MCP tool surface and a single CDP debug session.
 *
 * Owns the lifecycle of the spawned {@link NodeJSDebugAdapter} (launch /
 * attach / disconnect), routes DAP requests through {@link sendRequest}, and
 * surfaces runtime activity (logpoint hits, debugger events, tracked
 * breakpoints) to MCP tools via bounded {@link RingBuffer} FIFOs so a long
 * session cannot grow memory unbounded.
 *
 * State transitions are emitted on the underlying {@link EventEmitter} so the
 * MCP server can re-publish them as notifications. All `attach*` /
 * `enableDebuggerPid` entry points return an {@link MCPResponse} envelope and
 * never throw to the caller.
 */
export class DAPClient extends EventEmitter {
  // Keep buffers bounded to avoid unbounded memory growth on long debugging sessions.
  // FIFO semantics: when full, the oldest entry is dropped. Override via
  // MCP_LOGPOINT_BUFFER_SIZE; values <= 0 or non-numeric fall back to default.
  private static resolveBufferSize(): number {
    const raw = process.env.MCP_LOGPOINT_BUFFER_SIZE;

    if (raw === undefined || raw === '') return DEFAULTS.MAX_BUFFER_SIZE;

    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULTS.MAX_BUFFER_SIZE;
  }
  private static readonly MAX_BUFFER_SIZE = DAPClient.resolveBufferSize();

  private readonly connection: DAPConnection = {
    adapter: null,
    isConnected: false,
  };
  private readonly logpointHits = new RingBuffer<LogpointHit>(DAPClient.MAX_BUFFER_SIZE);
  private readonly debuggerEvents = new RingBuffer<DebuggerEvent>(DAPClient.MAX_BUFFER_SIZE);
  private readonly trackedBreakpoints: Map<number, TrackedBreakpoint> = new Map();
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  private appendLogpointHit(hit: LogpointHit): void {
    this.logpointHits.push(hit);
  }

  private appendDebuggerEvent(event: DebuggerEvent): void {
    this.debuggerEvents.push(event);
  }

  constructor() {
    super();
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  get webSocketUrl(): string | null {
    // DAP doesn't use websockets - return protocol identifier for compatibility
    return this.connection.isConnected ? 'dap://in-process' : null;
  }

  // Event subscription methods for state management compatibility
  onStateChange(callback: (connected: boolean) => void): void {
    this.on('stateChange', callback);
  }

  onDebuggerPause(callback: () => void): void {
    this.on('debuggerPaused', callback);
  }

  onDebuggerResume(callback: () => void): void {
    this.on('debuggerResumed', callback);
  }

  private emitStateChange(connected: boolean): void {
    this.emit('stateChange', connected);
  }

  private setupAdapterEventHandlers(adapter: NodeJSDebugAdapter): void {
    // Adapter sendEvent is monkey-patched (DebugSession does not expose
    // generic event subscription on the public surface for these events). Tag
    // the wrapper so a second setup pass on the same adapter does not stack
    // wrappers and fan-out duplicate events to the client.
    const tagged = adapter.sendEvent as ((event: DebugProtocol.Event) => void) & {
      __mcpDapClientWrapped?: boolean;
    };

    if (tagged.__mcpDapClientWrapped) {
      return;
    }

    const originalSendEvent = adapter.sendEvent;
    const wrapped = ((event: DebugProtocol.Event) => {
      originalSendEvent.call(adapter, event);

      if (event.event === 'stopped') {
        const stoppedEvent = event as DebugProtocol.StoppedEvent;

        this.handleStoppedEvent(stoppedEvent);
      } else if (event.event === 'output') {
        const outputEvent = event as DebugProtocol.OutputEvent;

        this.handleOutputEvent(outputEvent);
      } else if (event.event === 'mcpLogpoint') {
        // Custom event from NodeJSDebugAdapter carrying bindingCalled payloads
        const McpLogpointEventBody = z.looseObject({
          executionContextId: z.number().optional(),
          name: z.string().optional(),
          payload: z.string().optional(),
        });
        const parsedBody = McpLogpointEventBody.safeParse(event.body);

        if (!parsedBody.success) {
          // Ignore malformed custom event bodies. Surface the parse error in
          // verbose mode so a debugging session can spot a misshapen logpoint
          // payload instead of silently dropping the hit.
          logVerbose('dap-client', `mcpLogpoint event body failed Zod parse: ${parsedBody.error.message}`);

          return;
        }

        const executionContextId = parsedBody.data.executionContextId ?? 0;
        const payloadRaw = parsedBody.data.payload ?? '';
        let parsed: unknown = undefined;
        let message: string | undefined;

        try {
          parsed = JSON.parse(payloadRaw);
          // Object with `message`: keep string values verbatim; serialize
          // non-string values via safeStringify so structure is preserved
          // (avoids "[object Object]" / "null" / Symbol throw). Other cases
          // (object without message, array, scalar, null): use payloadRaw so
          // arrays do not collapse to `arr.join(',')` and primitives keep
          // their JSON form.
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;

            if ('message' in obj) {
              const messageValue = obj.message;

              message = typeof messageValue === 'string'
                ? messageValue
                : (safeStringify(messageValue) ?? payloadRaw);
            } else {
              message = payloadRaw;
            }
          } else {
            message = payloadRaw;
          }
        } catch {
          // not JSON
          message = payloadRaw.length ? payloadRaw : undefined;
        }

        // Live consumers (mcp-server notification, dap-debugger-manager) get
        // the parsed payload via the emitted event. The ring buffer keeps only
        // payloadRaw; getLogpointHits lazily re-parses on read, avoiding the
        // double storage (string + parsed V8 object) for every stored hit.
        const hit: LogpointHit = {
          message,
          payloadRaw,
          payload: parsed,
          timestamp: new Date(),
          executionContextId,
          level: 'info',
        };
        const stored: LogpointHit = {
          message,
          payloadRaw,
          timestamp: hit.timestamp,
          executionContextId,
          level: 'info',
        };

        this.appendLogpointHit(stored);
        this.emit('logpointHit', hit);
      } else if (event.event === 'terminated') {
        this.handleTerminatedEvent();
      } else if (event.event === 'continued') {
        this.handleContinuedEvent();
      }
    }) as ((event: DebugProtocol.Event) => void) & { __mcpDapClientWrapped?: boolean };

    wrapped.__mcpDapClientWrapped = true;
    adapter.sendEvent = wrapped;
  }

  private handleStoppedEvent(event: DebugProtocol.StoppedEvent): void {
    const debuggerEvent: DebuggerEvent = {
      type: 'paused',
      timestamp: new Date(),
      data: {
        reason: event.body.reason,
        threadId: event.body.threadId,
        hitBreakpointIds: event.body.hitBreakpointIds,
        text: event.body.text,
      },
    };

    this.appendDebuggerEvent(debuggerEvent);
    this.emit('debuggerPaused', debuggerEvent);
  }

  private handleOutputEvent(event: DebugProtocol.OutputEvent): void {
    const { output, category = 'console', source, line, column } = event.body;

    // Logpoints arrive via custom 'mcpLogpoint' events;
    // standard output handling remains for regular console.* messages.

    // Also emit raw output for general consumption
    this.emit('output', {
      category,
      output,
      source,
      line,
      column,
    });
  }

  private handleTerminatedEvent(): void {
    const debuggerEvent: DebuggerEvent = {
      type: 'resumed',
      timestamp: new Date(),
      data: { reason: 'terminated' },
    };

    this.appendDebuggerEvent(debuggerEvent);
    this.emit('debuggerTerminated', debuggerEvent);
  }

  private handleContinuedEvent(): void {
    const debuggerEvent: DebuggerEvent = {
      type: 'resumed',
      timestamp: new Date(),
      data: {},
    };

    this.appendDebuggerEvent(debuggerEvent);
    this.emit('debuggerResumed', debuggerEvent);
  }

  // Dispatch table for DAP methods. Each handler receives (adapter, params, requestId)
  // and returns the response payload. Side-effecting handlers (attach, terminate)
  // toggle connection state inline.
  private readonly dapHandlers: Partial<Record<string, (
    adapter: NodeJSDebugAdapter,
    params: unknown,
    requestId: number,
  ) => unknown | Promise<unknown>>> = {
    initialize: (_adapter, _params, requestId) => this.buildInitializeResponse(requestId),
    attach: async (adapter, params, requestId) => {
      const attachResult = await adapter.attach(params as NodeJSAttachRequestArguments);

      if (!attachResult.success) {
        throw new ProtocolError(attachResult.message ?? 'Attach failed');
      }

      this.connection.isConnected = true;
      this.emitStateChange(true);

      return {
        seq: 0,
        type: 'response',
        request_seq: requestId,
        command: 'attach',
        success: true,
      };
    },
    launch: (_adapter, params, requestId) => this.buildLaunchResponse(requestId, params as NodeJSLaunchRequestArguments),
    setBreakpoints: (adapter, params) => adapter.setBreakpoints(params as DebugProtocol.SetBreakpointsArguments),
    continue: (adapter, params) => adapter.continueExecution(params as DebugProtocol.ContinueArguments),
    pause: (adapter, params) => adapter.pauseExecution(params as DebugProtocol.PauseArguments),
    stepIn: (adapter, params) => adapter.stepIn(params as DebugProtocol.StepInArguments),
    stepOut: (adapter, params) => adapter.stepOut(params as DebugProtocol.StepOutArguments),
    next: (adapter, params) => adapter.next(params as DebugProtocol.NextArguments),
    evaluate: (adapter, params) => adapter.evaluate(params as DebugProtocol.EvaluateArguments),
    stackTrace: (adapter, params) => adapter.stackTrace(params as DebugProtocol.StackTraceArguments),
    threads: (adapter) => adapter.threads(),
    scopes: (adapter, params) => adapter.scopes(params as DebugProtocol.ScopesArguments),
    variables: (adapter, params) => adapter.variables(params as DebugProtocol.VariablesArguments),
    setVariable: (adapter, params) => adapter.setVariable(params as DebugProtocol.SetVariableArguments),
    loadedSources: (adapter) => adapter.loadedSources(),
    exceptionInfo: (adapter, params) => adapter.exceptionInfo(params as DebugProtocol.ExceptionInfoArguments),
    setExceptionBreakpoints: (adapter, params) => adapter.setExceptionBreakpoints(params as DebugProtocol.SetExceptionBreakpointsArguments),
    breakpointLocations: (adapter, params) => adapter.breakpointLocations(params as DebugProtocol.BreakpointLocationsArguments),
    restartFrame: (adapter, params) => adapter.restartFrame(params as DebugProtocol.RestartFrameArguments),
    goto: (adapter, params) => adapter.goto(params as DebugProtocol.GotoArguments),
    terminate: async (adapter) => {
      const response = await adapter.terminate();

      this.connection.isConnected = false;
      this.emitStateChange(false);

      return response;
    },
    restart: (adapter) => adapter.restart(),
  };

  private async sendRequest<T = unknown>(
    method: string,
    params: unknown = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.connection.adapter) {
        reject(new Error('Not connected to debug adapter'));

        return;
      }

      const requestId = this.nextRequestId++;
      // Set the timeout up front and store it in the pending-request record so that
      // resolveRequest/rejectRequest can clear it atomically. Sync DAP methods
      // (initialize, threads, stackTrace, scopes, loadedSources, exceptionInfo, goto)
      // settle the promise inside the IIFE before this Promise executor returns; the
      // previous design overrode `pendingRequests.get(id)!.resolve` after the IIFE,
      // which threw a silent TypeError on those paths and leaked the timer for the
      // request lifetime.
      // Use the callback-based setTimeout from node:timers explicitly
      // (renamed scheduleTimeout) so it is visually distinguishable from the
      // promise-based `sleep` imported above. We need the timer handle here
      // for clearTimeout in resolveRequest/rejectRequest, so the promise API
      // does not fit.
      const timeout = scheduleTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`DAP request timeout: ${method}`));
        }
      }, DEFAULTS.DAP_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (error: Error) => void,
        timeout,
      });

      // Dispatch to real adapter methods (no mock handlers).
      (async () => {
        try {
          const {adapter} = this.connection;

          if (!adapter) {
            throw new NotConnectedError('Debug adapter not available');
          }

          const handler = this.dapHandlers[method];

          if (!handler) {
            throw new ValidationError(`Unsupported DAP method: ${method}`);
          }

          const response = await handler(adapter, params, requestId);

          this.resolveRequest(requestId, response);
        } catch (error) {
          // Preserve the original cause when wrapping non-Error throwables so
          // the downstream consumer (DAP request promise) can still walk the
          // chain via err.cause.
          this.rejectRequest(
            requestId,
            error instanceof Error ? error : new Error(String(error), { cause: error }),
          );
        }
      })();
    });
  }

  // ===== Response builders for in-process DAP commands =====

  // Mirror NodeJSDebugAdapter#okResponse: factor out the canonical successful
  // DAP envelope so the wire format only has to change in one place.
  private okResponse<R extends DebugProtocol.Response>(
    requestId: number,
    command: R['command'],
    body?: R['body'],
  ): R {
    const result: DebugProtocol.Response = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command,
      success: true,
      ...(body !== undefined ? { body } : {}),
    };

    return result as unknown as R;
  }

  private buildInitializeResponse(requestId: number): DebugProtocol.InitializeResponse {
    return this.okResponse<DebugProtocol.InitializeResponse>(requestId, 'initialize', {
      supportsConfigurationDoneRequest: true,
      supportsEvaluateForHovers: true,
      supportsLogPoints: true,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsSetVariable: true,
      supportsCompletionsRequest: true,
      supportsRestartFrame: true,
      supportsLoadedSourcesRequest: true,
      supportsExceptionInfoRequest: true,
      supportsBreakpointLocationsRequest: true,
    });
  }

  // launch is not supported in this build (we always attach to a running process).
  // Throwing surfaces an explicit error to the MCP client instead of pretending the
  // program was launched while the adapter never spawned anything.
  private async buildLaunchResponse(
    requestId: number,
    args: NodeJSLaunchRequestArguments,
  ): Promise<DebugProtocol.LaunchResponse> {
    void requestId;
    void args;
    throw new ValidationError(
      'launch is not supported by this MCP server; start your Node.js process with ' +
      '--inspect-brk and use the attach tool instead',
    );
  }

  private resolveRequest(requestId: number, response: unknown): void {
    const pendingRequest = this.pendingRequests.get(requestId);

    if (pendingRequest) {
      clearTimeout(pendingRequest.timeout);
      this.pendingRequests.delete(requestId);
      pendingRequest.resolve(response);
    }
  }

  private rejectRequest(requestId: number, error: Error): void {
    const pendingRequest = this.pendingRequests.get(requestId);

    if (pendingRequest) {
      clearTimeout(pendingRequest.timeout);
      this.pendingRequests.delete(requestId);
      pendingRequest.reject(error);
    }
  }

  // Public API methods (DAP interface)
  async connectDefault(): Promise<MCPResponse> {
    return this.attachToProcess({ port: DEFAULTS.INSPECTOR_PORT });
  }

  async connectUrl(url: string): Promise<MCPResponse> {
    // Parse host and port out of the URL so a remote attach against a non-localhost
    // address actually goes there. Previously we extracted only the port and dropped
    // back to localhost, silently breaking remote DAP attach.
    let port: number = DEFAULTS.INSPECTOR_PORT;
    let address: string | undefined;

    try {
      const parsed = new URL(url);

      if (parsed.port) {
        port = parseInt(parsed.port, 10);
      }
      if (parsed.hostname) {
        address = parsed.hostname;
      }
    } catch (cause) {
      // Pull only :NNNN that sits at the very end of the string (or right before
      // a trailing path), so that arbitrary substrings like "Error 2025:34:56"
      // don't get silently misread as port 34. If even that fails, surface a
      // structured error so the MCP caller sees a clear "bad URL" instead of
      // being silently attached to the default inspector port.
      const match = url.match(/:(\d+)(?:\/.*)?$/);

      if (!match?.[1]) {
        return createErrorResponse(
          'Failed to attach',
          `connectUrl: not a valid URL or :PORT suffix: ${url}`,
          'VALIDATION_ERROR',
          { url, cause: errorMessage(cause) },
        );
      }
      port = parseInt(match[1], 10);
    }

    if (!DAPClient.isValidPort(port)) {
      return createErrorResponse(
        'Failed to attach',
        `connectUrl: port out of range or not an integer: ${url}`,
        'VALIDATION_ERROR',
        { url, port },
      );
    }

    return this.attachToProcess({ port, ...(address !== undefined && { address }) });
  }

  // Best-effort check whether a CLI is available on PATH.
  private async isCommandAvailable(cmd: string, args: string[] = ["-V"]): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const p = spawn(cmd, args);
        let done = false;
        const finish = (ok: boolean) => {
          if (!done) {
            done = true;
            resolve(ok);
            try {
              p.kill();
            } catch {
              /* ignore */
            }
          }
        };

        p.once("spawn", () => { finish(true); });
        p.once("error", () => { finish(false); });

        // Fail-closed: if neither 'spawn' nor 'error' arrived within the window,
        // treat the command as unavailable. The previous default of true caused
        // strace probes to run on systems without strace and waste STRACE_TIMEOUT_MS.
        scheduleTimeout(() => { finish(false); }, DEFAULTS.COMMAND_AVAILABILITY_TIMEOUT_MS).unref();
      } catch {
        resolve(false);
      }
    });
  }

  // Probe Node inspector's /json/version endpoint to verify a port is live.
  private probeInspector(
    probePort: number,
    timeoutMs: number = DEFAULTS.PROBE_INSPECTOR_DEFAULT_TIMEOUT_MS,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: probePort, path: '/json/version', timeout: timeoutMs },
        (res) => {
          const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500;

          res.resume();
          resolve(ok);
        },
      );

      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => { resolve(false); });
    });
  }

  // Use strace to observe Node inspector activation messages (Linux only, best-effort).
  // Returns the detected port if found, undefined otherwise.
  private async detectInspectorPortViaStrace(pid: number): Promise<number | undefined> {
    if (process.platform === 'win32') return undefined;
    if (!(await this.isCommandAvailable('strace', ['-V']))) return undefined;

    let strace: ReturnType<typeof spawn>;

    try {
      strace = spawn("strace", ["-p", String(pid), "-e", "write", "-s", "200", "-f"]);
    } catch {
      return undefined;
    }

    return new Promise<number | undefined>((resolve) => {
      let detectedPort: number | undefined;
      // Declare cleanup before the listener closures so a future reorder cannot
      // re-introduce a TDZ ReferenceError when onData fires before cleanup is
      // initialised. cleanup itself only references onData/onExit lazily inside
      // its body, so closure resolution is fine.
      const cleanup = () => {
        strace.stderr?.off("data", onData);
        strace.stdout?.off("data", onData);
        strace.off("exit", onExit);
        try {
          strace.kill();
        } catch {
          /* ignore */
        }
      };
      const onData = (buf: Buffer) => {
        const out = buf.toString();
        const fullUrlMatch = out.match(/Debugger listening on (ws:\/\/[^\s]+)/);
        const portMatch = out.match(/Debugger listening on (?:port )?(\d+)/);

        if (fullUrlMatch?.[1]) {
          const m = fullUrlMatch[1].match(/:(\d+)/);

          if (m?.[1]) detectedPort = parseInt(m[1], 10);
          cleanup();
          resolve(detectedPort);
        } else if (portMatch?.[1]) {
          detectedPort = parseInt(portMatch[1], 10);
          cleanup();
          resolve(detectedPort);
        }
      };
      const onExit = () => { resolve(detectedPort); };

      strace.stderr?.on("data", onData);
      strace.stdout?.on("data", onData);
      strace.once("exit", onExit);

      scheduleTimeout(() => {
        cleanup();
        resolve(detectedPort);
      }, DEFAULTS.STRACE_TIMEOUT_MS).unref();
    });
  }

  // Poll candidate inspector ports until one responds or the deadline expires.
  // Probes within a single round run in parallel so the worst case is bounded by
  // probeTimeoutMs rather than candidates.length * probeTimeoutMs (the previous
  // sequential implementation could exceed discoverTimeoutMs in a single pass).
  private async pollForInspectorPort(opts?: {
    discoverTimeoutMs?: number | undefined;
    probeTimeoutMs?: number | undefined;
    ports?: number[] | undefined;
  }): Promise<number | undefined> {
    // Honour an explicit empty list as "do not poll" instead of silently
    // expanding to the default 9229..9250 range. `??` distinguishes undefined
    // (use default sequence) from an empty array (caller opted out of probing).
    const candidates: number[] = opts?.ports ?? Array.from(
      { length: INSPECTOR_PORT_RANGE.end - INSPECTOR_PORT_RANGE.start + 1 },
      (_, i) => INSPECTOR_PORT_RANGE.start + i,
    );

    if (candidates.length === 0) return undefined;

    const deadline = Date.now() + (opts?.discoverTimeoutMs ?? DEFAULTS.DISCOVER_TIMEOUT_MS);
    const probeTimeoutMs = opts?.probeTimeoutMs ?? DEFAULTS.PROBE_TIMEOUT_MS;
    // Exponential backoff between rounds (200 -> 400 -> 800 -> ... capped at
    // 2000 ms). Pre-1.7 we hammered all 22 candidates every 200 ms regardless
    // of how long the debuggee had been silent, which burns CPU + FD churn on
    // a misconfigured attach. The cap keeps the worst-case slip below
    // INSPECTOR_POLL_INTERVAL_MS_MAX so a debuggee that comes up mid-poll is
    // still picked up promptly.
    let delayMs: number = DEFAULTS.INSPECTOR_POLL_INTERVAL_MS;

    // do-while guarantees at least one probe round even when discoverTimeoutMs<=0,
    // so a caller passing 0 still gets a single best-effort lookup instead of
    // silently returning undefined without ever probing.
    do {
      const results = await Promise.all(
        candidates.map(async (cand) => ({ cand, ok: await this.probeInspector(cand, probeTimeoutMs) })),
      );
      const hit = results.find((r) => r.ok);

      if (hit) return hit.cand;

      if (Date.now() >= deadline) break;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, DEFAULTS.INSPECTOR_POLL_INTERVAL_MS_MAX);
    } while (Date.now() < deadline);

    return undefined;
  }

  private enrichAttachResult(
    attachResult: MCPResponse,
    activation: 'strace' | 'poll' | 'timeout',
    detectedPort: number,
  ): MCPResponse {
    let parsed: unknown;

    try {
      parsed = JSON.parse(attachResult.content[0]!.text);
    } catch {
      // attachResult.content[0].text was not JSON we could enrich; return the
      // raw result unchanged so the caller still sees attach success/failure.
      return attachResult;
    }

    const debug = { activation, detectedPort, webSocketUrl: this.webSocketUrl };

    // Arrays are "object" too, but spreading them into createSuccessResponse
    // would emit numeric-index keys; attach is expected to be an object
    // envelope, so surface the raw result unchanged when the contract drifts.
    if (Array.isArray(parsed)) {
      return attachResult;
    }

    const isRecord = typeof parsed === 'object' && parsed !== null;
    const payload = isRecord ? (parsed as Record<string, unknown>) : { value: parsed };

    // Do not promote an attach failure into a success by wrapping the failed
    // ErrorResponse in createSuccessResponse. If the parsed payload signals
    // failure, preserve the error envelope and append the diagnostic context.
    if (isRecord && (payload as { success?: unknown }).success === false) {
      const errorText = typeof payload.error === 'string' ? payload.error : 'Attach failed';
      const details = typeof payload.details === 'object' && payload.details !== null
        ? (payload.details as Record<string, unknown>)
        : {};
      const code = typeof payload.code === 'string' ? payload.code : 'ATTACH_FAILED';
      const message = typeof payload.message === 'string' ? payload.message : 'Attach result reported failure';

      return createErrorResponse(errorText, message, code, { ...details, debug });
    }

    return createSuccessResponse({ ...payload, debug });
  }

  async enableDebuggerPid(
    pid: number,
    opts?: { discoverTimeoutMs?: number | undefined; probeTimeoutMs?: number | undefined; ports?: number[] | undefined },
  ): Promise<MCPResponse> {
    try {
      let activation: 'strace' | 'poll' | 'timeout' = 'timeout';

      // Verify the target process exists before sending SIGUSR1. Without this
      // check, a typo in pid sends an arbitrary signal to whatever process
      // happens to live at that pid (for many daemons SIGUSR1 triggers a log
      // reopen / state dump).
      try {
        kill(pid, 0);
      } catch (probeError) {
        const code = (probeError as NodeJS.ErrnoException | undefined)?.code;

        return createErrorResponse(
          'Target process not found',
          `pid=${pid} cannot receive signals (${code ?? 'unknown error'}). ` +
          'Verify the PID belongs to a running Node.js process owned by the current user.',
          'PID_NOT_FOUND',
          { pid },
        );
      }

      // Linux: best-effort sanity check that the target looks like Node.js
      // before we send SIGUSR1. /proc/<pid>/comm holds the (truncated) process
      // name. If the file is unreadable or the platform is not Linux we skip
      // silently — the kill(pid, 0) gate above already enforces existence and
      // permission. On non-Node.js targets SIGUSR1 frequently has a useful
      // behaviour (log reopen, state dump) we have no right to trigger.
      if (process.platform === 'linux') {
        try {
          const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
          // /proc/<pid>/comm is truncated to TASK_COMM_LEN (16 bytes incl NUL).
          // Match common Node.js executable names: "node", "nodejs", and the
          // 15-byte "iojs"/"node ${name}" patterns produced by process.title.
          const looksLikeNode = /^(node|nodejs|iojs)\b/i.test(comm);

          if (!looksLikeNode) {
            return createErrorResponse(
              'Target process is not Node.js',
              `pid=${pid} has process name '${comm}', which is not a Node.js executable. ` +
              'SIGUSR1 to a non-Node process can trigger destructive side effects (log reopen, ' +
              'state dump). Refusing to proceed.',
              'PID_NOT_NODEJS',
              { pid, comm },
            );
          }
        } catch (commError) {
          const code = (commError as NodeJS.ErrnoException | undefined)?.code;

          // EACCES / ENOENT here just means we cannot verify; log and continue.
          logVerbose('dap-client', `Could not read /proc/${pid}/comm (${code ?? 'unknown'}), skipping Node.js sanity check`);
        }
      }

      // Send SIGUSR1 to request inspector activation.
      kill(pid, 'SIGUSR1');

      // Try to learn the port from strace output (Linux best-effort).
      let detectedPort = await this.detectInspectorPortViaStrace(pid);

      if (detectedPort !== undefined) {
        activation = 'strace';
      } else {
        // Fall back to polling well-known inspector ports.
        detectedPort = await this.pollForInspectorPort(opts);
        if (detectedPort !== undefined) activation = 'poll';
      }

      // Whatever happens, attempt the attach with the best port we have (default if unknown).
      const portToUse = detectedPort ?? DEFAULTS.INSPECTOR_PORT;
      const attachResult = await this.attachToProcess({ port: portToUse });

      return this.enrichAttachResult(attachResult, activation, portToUse);
    } catch (error) {
      return createErrorResponse(
        'Failed to enable debugger',
        errorMessage(error),
        'DEBUGGER_ENABLE_FAILED',
        { pid },
      );
    }
  }

  // Hosts that pass the loopback gate without explicit opt-in. Anything else
  // requires MCP_CDP_ALLOW_REMOTE=1 in the environment.
  private static readonly LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

  private isLoopbackHost(host: string | undefined): boolean {
    if (host === undefined) return true;

    return DAPClient.LOOPBACK_HOSTS.has(host.toLowerCase());
  }

  private static isValidPort(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
  }

  async attachToProcess(args: { port?: number; address?: string }): Promise<MCPResponse> {
    const host = args.address ?? DEFAULTS.INSPECTOR_CLIENT_HOST;
    const port = args.port ?? DEFAULTS.INSPECTOR_PORT;

    if (!DAPClient.isValidPort(port)) {
      return createErrorResponse(
        'Invalid inspector port',
        `Port must be an integer in 1..65535, got: ${String(args.port)}`,
        'VALIDATION_ERROR',
        { port: args.port },
      );
    }

    if (!this.isLoopbackHost(host) && process.env.MCP_CDP_ALLOW_REMOTE !== '1') {
      return createErrorResponse(
        'Remote inspector attach blocked',
        `Refusing to attach to non-loopback host '${host}'. ` +
        'Set MCP_CDP_ALLOW_REMOTE=1 to allow remote inspector connections.',
        'CDP_REMOTE_BLOCKED',
        { host },
      );
    }

    // Refuse to clobber an active session; require explicit disconnect first.
    if (this.connection.isConnected) {
      return createErrorResponse(
        'Already attached',
        'A previous attach session is still active. Call disconnect first.',
        'ALREADY_ATTACHED',
        { host },
      );
    }

    // Stale adapter from a prior failed attach: tear it down before creating
    // a new one so wrapped sendEvent / cdpTransport listeners do not leak and
    // late terminated events do not fire on the new connection.
    if (this.connection.adapter) {
      try {
        await this.connection.adapter.disconnect();
      } catch (error) {
        logError('Stale adapter disconnect during attachToProcess (best-effort)', error);
      }

      this.connection.adapter = null;
    }

    try {
      // Create new debug adapter instance
      this.connection.adapter = new NodeJSDebugAdapter();
      this.setupAdapterEventHandlers(this.connection.adapter);

      // Initialize the debug adapter
      await this.sendRequest('initialize', {
        clientID: 'mcp-dap-client',
        clientName: 'MCP DAP Client',
        adapterID: 'nodejs',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsLogPoints: true,
      });

      // Attach to the Node.js process. The 'attach' handler in dapHandlers already
      // toggles connection state on success; do not duplicate emitStateChange here
      // or every subscriber will get two notifications per attach.
      await this.sendRequest('attach', {
        port: args.port ?? DEFAULTS.INSPECTOR_PORT,
        address: args.address ?? DEFAULTS.INSPECTOR_CLIENT_HOST,
      });

      return createSuccessResponse({
        message: `Attached to Node.js process on ${args.address ?? DEFAULTS.INSPECTOR_CLIENT_HOST}:${args.port ?? DEFAULTS.INSPECTOR_PORT}`,
        protocol: 'DAP',
      });
    } catch (error) {
      // initialize / attach failed: dispose the freshly created adapter so the
      // wrapped sendEvent and any cdpTransport listeners do not stay around.
      if (this.connection.adapter) {
        try {
          await this.connection.adapter.disconnect();
        } catch (cleanupError) {
          logError('Adapter cleanup after attach failure (best-effort)', cleanupError);
        }

        this.connection.adapter = null;
      }

      return createErrorResponse(
        'Failed to attach to process',
        errorMessage(error),
        'ATTACH_FAILED',
        {
          port: args.port ?? DEFAULTS.INSPECTOR_PORT,
          address: args.address ?? DEFAULTS.INSPECTOR_CLIENT_HOST,
        },
      );
    }
  }

  async disconnect(): Promise<void> {
    const wasConnected = this.connection.isConnected;

    if (this.connection.adapter) {
      try {
        // Call the adapter's disconnect directly: 'disconnect' is not registered
        // in dapHandlers, and routing through sendRequest would just throw and
        // skip the actual cleanup of cdpTransport / nodeProcess.
        await this.connection.adapter.disconnect();
      } catch (error) {
        // disconnect() is best-effort cleanup; the adapter may already be torn
        // down from a debuggee crash. Log so an unexpected cleanup failure
        // (not "debuggee is gone") leaves a breadcrumb instead of vanishing.
        logError('Adapter disconnect failed during cleanup (best-effort)', error);
      }

      this.connection.adapter = null;
    }

    this.connection.isConnected = false;
    // Emit only on a real transition; disconnect() is callable multiple times
    // (defensive cleanup) and external subscribers should not see phantom
    // disconnect events when nothing actually changed.
    if (wasConnected) {
      this.emitStateChange(false);
    }
  }

  // Breakpoint management
  addTrackedBreakpoint(breakpoint: TrackedBreakpoint): void {
    this.trackedBreakpoints.set(breakpoint.breakpointId, breakpoint);
  }

  removeTrackedBreakpoint(breakpointId: number): void {
    this.trackedBreakpoints.delete(breakpointId);
  }

  getTrackedBreakpoints(): TrackedBreakpoint[] {
    return Array.from(this.trackedBreakpoints.values());
  }

  // O(1) lookup for the common "find one tracked breakpoint by its DAP id"
  // pattern. Manager.removeBreakpoint used to materialize the whole Map into
  // an array and then .find() — now it goes straight to Map.get().
  getTrackedBreakpoint(breakpointId: number): TrackedBreakpoint | undefined {
    return this.trackedBreakpoints.get(breakpointId);
  }

  /**
   * Source-map resolution captured by the adapter during placeSingleBreakpoint.
   * DAPDebuggerManager.setBreakpoints reads this instead of re-running
   * SourceMapResolver.resolveSourceMapPosition for every actual breakpoint.
   */
  getBreakpointSourceMapResolution(dapId: number): SourceMapResolution | undefined {
    return this.connection.adapter?.getBreakpointSourceMapResolution(dapId);
  }

  /**
   * Per-CDP-event-type tally of swallowed handler errors, forwarded from the
   * adapter so getDebuggerState can surface "silent" regressions without the
   * caller having to know that the adapter exists.
   */
  getAdapterEventErrorCounts(): Record<string, number> {
    return this.connection.adapter?.getEventErrorCounts() ?? {};
  }

  // Removes one breakpoint at the adapter level by DAP id without touching siblings.
  // Manager.removeBreakpoint goes through here instead of using setBreakpoints with an
  // empty list, which used to wipe every breakpoint in the same source file.
  async removeBreakpointByDapId(dapId: number): Promise<{ removed: boolean; filePath?: string }> {
    if (!this.connection.adapter) {
      throw new NotConnectedError('Not connected to debug adapter');
    }

    return this.connection.adapter.removeBreakpointByDapId(dapId);
  }

  // Logpoint and event management
  getLogpointHits(opts?: { offset?: number | undefined; limit?: number | undefined }): { items: LogpointHit[]; totalCount: number } {
    const totalCount = this.logpointHits.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? totalCount;
    const stored = this.logpointHits.slice(offset, limit);
    // Stored hits keep payloadRaw only; lazily rebuild payload on read so the
    // ring buffer does not retain the parsed JSON object alongside the source
    // string for every entry.
    const items = stored.map((hit): LogpointHit => {
      if (hit.payloadRaw === undefined || hit.payloadRaw === '') return hit;

      try {
        return { ...hit, payload: JSON.parse(hit.payloadRaw) as unknown };
      } catch {
        return hit;
      }
    });

    return { items, totalCount };
  }

  clearLogpointHits(): void {
    this.logpointHits.clear();
  }

  getDebuggerEvents(opts?: { offset?: number | undefined; limit?: number | undefined }): { items: DebuggerEvent[]; totalCount: number } {
    const totalCount = this.debuggerEvents.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? totalCount;

    return { items: this.debuggerEvents.slice(offset, limit), totalCount };
  }

  clearDebuggerEvents(): void {
    this.debuggerEvents.clear();
  }

  // Direct DAP method access
  async dapRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.sendRequest<T>(method, params);
  }
}
