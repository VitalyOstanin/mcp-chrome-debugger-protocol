import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { NodeJSDebugAdapter, type NodeJSLaunchRequestArguments, type NodeJSAttachRequestArguments } from './nodejs-debug-adapter.js';
import type { LogpointHit, DebuggerEvent, TrackedBreakpoint } from './types.js';
import { createSuccessResponse, createErrorResponse, type MCPResponse } from './utils.js';
import { DEFAULTS, INSPECTOR_PORT_RANGE } from './constants.js';
import { kill } from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';

// Bounded FIFO buffer with O(1) push and amortised O(1) drop-oldest. The previous
// implementation used Array.splice(0, n), which is O(n) on every overflow and
// dominated CPU under high logpoint hit rates.
class RingBuffer<T> {
  private items: T[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T>(capacity);
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
    const out: T[] = new Array<T>(this.size);

    for (let i = 0; i < this.size; i++) {
      out[i] = this.items[(this.head + i) % this.capacity]!;
    }

    return out;
  }

  clear(): void {
    this.items = new Array<T>(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}

export interface DAPConnection {
  adapter: NodeJSDebugAdapter | null;
  isConnected: boolean;
}

export class DAPClient extends EventEmitter {
  // Keep buffers bounded to avoid unbounded memory growth on long debugging sessions.
  // FIFO semantics: when full, the oldest entry is dropped.
  private static readonly MAX_BUFFER_SIZE = DEFAULTS.MAX_BUFFER_SIZE;

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
    // Handle stopped events (breakpoints, stepping, etc.)
    const originalSendEvent = adapter.sendEvent;

    adapter.sendEvent = (event) => {
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
          // Ignore malformed custom event bodies
          return;
        }

        const executionContextId = parsedBody.data.executionContextId ?? 0;
        const payloadRaw = parsedBody.data.payload ?? '';
        let parsed: unknown = undefined;
        let message: string | undefined = undefined;

        try {
          parsed = JSON.parse(payloadRaw);
          if (parsed && typeof parsed === 'object' && 'message' in (parsed as Record<string, unknown>)) {
            message = String((parsed as Record<string, unknown>).message);
          }
        } catch {
          // not JSON
          message = payloadRaw.length ? payloadRaw : undefined;
        }

        const hit = {
          message,
          payloadRaw,
          payload: parsed,
          timestamp: new Date(),
          executionContextId,
          level: 'info',
        } as const;

        this.appendLogpointHit(hit);
        this.emit('logpointHit', hit);
      } else if (event.event === 'terminated') {
        this.handleTerminatedEvent();
      } else if (event.event === 'continued') {
        this.handleContinuedEvent();
      }
    };
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
        throw new Error(attachResult.message ?? 'Attach failed');
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
      const timeout = setTimeout(() => {
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
            throw new Error('Debug adapter not available');
          }

          const handler = this.dapHandlers[method];

          if (!handler) {
            throw new Error(`Unsupported DAP method: ${method}`);
          }

          const response = await handler(adapter, params, requestId);

          this.resolveRequest(requestId, response);
        } catch (error) {
          this.rejectRequest(requestId, error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }

  // ===== Response builders for in-process DAP commands =====

  private buildInitializeResponse(requestId: number): DebugProtocol.InitializeResponse {
    return {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'initialize',
      success: true,
      body: {
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
      },
    };
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
    throw new Error(
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
    } catch {
      // Fallback for inputs that aren't a full URL: pull just the port out of ":NNNN".
      const match = url.match(/:(\d+)/);

      if (match?.[1]) port = parseInt(match[1], 10);
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
        setTimeout(() => { finish(false); }, 1000).unref();
      } catch {
        resolve(false);
      }
    });
  }

  // Probe Node inspector's /json/version endpoint to verify a port is live.
  private probeInspector(probePort: number, timeoutMs = 500): Promise<boolean> {
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

      strace.stderr?.on("data", onData);
      strace.stdout?.on("data", onData);
      strace.once("exit", onExit);

      setTimeout(() => {
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
    const candidates: number[] = opts?.ports?.length
      ? opts.ports
      : Array.from(
        { length: INSPECTOR_PORT_RANGE.end - INSPECTOR_PORT_RANGE.start + 1 },
        (_, i) => INSPECTOR_PORT_RANGE.start + i,
      );
    const deadline = Date.now() + (opts?.discoverTimeoutMs ?? DEFAULTS.DISCOVER_TIMEOUT_MS);
    const probeTimeoutMs = opts?.probeTimeoutMs ?? DEFAULTS.PROBE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const results = await Promise.all(
        candidates.map(async (cand) => ({ cand, ok: await this.probeInspector(cand, probeTimeoutMs) })),
      );
      const hit = results.find((r) => r.ok);

      if (hit) return hit.cand;

      await sleep(200);
    }

    return undefined;
  }

  private enrichAttachResult(
    attachResult: MCPResponse,
    activation: 'strace' | 'poll' | 'timeout',
    detectedPort: number,
  ): MCPResponse {
    try {
      const parsed = JSON.parse(attachResult.content[0]!.text);

      return createSuccessResponse({
        ...parsed,
        debug: {
          activation,
          detectedPort,
          webSocketUrl: this.webSocketUrl,
        },
      });
    } catch {
      return attachResult;
    }
  }

  async enableDebuggerPid(
    pid: number,
    opts?: { discoverTimeoutMs?: number | undefined; probeTimeoutMs?: number | undefined; ports?: number[] | undefined },
  ): Promise<MCPResponse> {
    try {
      let activation: 'strace' | 'poll' | 'timeout' = 'timeout';

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
        JSON.stringify({ pid, error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  async attachToProcess(args: { port?: number; address?: string }): Promise<MCPResponse> {
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
        address: args.address ?? 'localhost',
      });

      return createSuccessResponse({
        message: `Attached to Node.js process on ${args.address ?? 'localhost'}:${args.port ?? DEFAULTS.INSPECTOR_PORT}`,
        protocol: 'DAP',
      });
    } catch (error) {
      return createErrorResponse(
        'Failed to attach to process',
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection.adapter) {
      try {
        // Call the adapter's disconnect directly: 'disconnect' is not registered
        // in dapHandlers, and routing through sendRequest would just throw and
        // skip the actual cleanup of cdpTransport / nodeProcess.
        await this.connection.adapter.disconnect();
      } catch {
        // Ignore disconnect errors
      }

      this.connection.adapter = null;
    }

    this.connection.isConnected = false;
    this.emitStateChange(false);
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

  // Removes one breakpoint at the adapter level by DAP id without touching siblings.
  // Manager.removeBreakpoint goes through here instead of using setBreakpoints with an
  // empty list, which used to wipe every breakpoint in the same source file.
  async removeBreakpointByDapId(dapId: number): Promise<{ removed: boolean; filePath?: string }> {
    if (!this.connection.adapter) {
      throw new Error('Not connected to debug adapter');
    }

    return this.connection.adapter.removeBreakpointByDapId(dapId);
  }

  // Logpoint and event management
  getLogpointHits(): LogpointHit[] {
    return this.logpointHits.toArray();
  }

  clearLogpointHits(): void {
    this.logpointHits.clear();
  }

  getDebuggerEvents(): DebuggerEvent[] {
    return this.debuggerEvents.toArray();
  }

  clearDebuggerEvents(): void {
    this.debuggerEvents.clear();
  }

  // Direct DAP method access
  async dapRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.sendRequest<T>(method, params);
  }
}
