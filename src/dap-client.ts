import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { NodeJSDebugAdapter, type NodeJSLaunchRequestArguments, type NodeJSAttachRequestArguments } from './nodejs-debug-adapter.js';
import type { LogpointHit, DebuggerEvent, TrackedBreakpoint } from './types.js';
import { createSuccessResponse, createErrorResponse } from './utils.js';
import { kill } from 'node:process';
import { spawn } from 'node:child_process';
import http from 'node:http';

export interface DAPConnection {
  adapter: NodeJSDebugAdapter | null;
  isConnected: boolean;
}

export class DAPClient extends EventEmitter {
  private readonly connection: DAPConnection = {
    adapter: null,
    isConnected: false,
  };
  private logpointHits: LogpointHit[] = [];
  private debuggerEvents: DebuggerEvent[] = [];
  private readonly trackedBreakpoints: Map<number, TrackedBreakpoint> = new Map();
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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
        const McpLogpointEventBody = z.object({
          executionContextId: z.number().optional(),
          name: z.string().optional(),
          payload: z.string().optional(),
        }).passthrough();
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

        this.logpointHits.push(hit);
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

    this.debuggerEvents.push(debuggerEvent);
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

    this.debuggerEvents.push(debuggerEvent);
    this.emit('debuggerTerminated', debuggerEvent);
  }

  private handleContinuedEvent(): void {
    const debuggerEvent: DebuggerEvent = {
      type: 'resumed',
      timestamp: new Date(),
      data: {},
    };

    this.debuggerEvents.push(debuggerEvent);
    this.emit('debuggerResumed', debuggerEvent);
  }

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

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (error: Error) => void,
      });

      // Route to real adapter public methods where available
      (async () => {
        try {
          switch (method) {
            case 'initialize': {
              // Emit InitializedEvent and return a minimal success response
              const response: DebugProtocol.InitializeResponse = {
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
                },
              };

              this.resolveRequest(requestId, response);
              break;
            }
            case 'attach': {
              const result = await this.connection.adapter!.attach(params as NodeJSAttachRequestArguments);

              if (result.success) {
                this.connection.isConnected = true;
                this.emitStateChange(true);

                const response: DebugProtocol.AttachResponse = {
                  seq: 0,
                  type: 'response',
                  request_seq: requestId,
                  command: 'attach',
                  success: true,
                };

                this.resolveRequest(requestId, response);
              } else {
                throw new Error(result.message ?? 'Attach failed');
              }
              break;
            }
            case 'setBreakpoints': {
              const response = await this.connection.adapter!.setBreakpoints(
                params as DebugProtocol.SetBreakpointsArguments,
              );

              this.resolveRequest(requestId, response);
              break;
            }
            // For the rest, fall back to lightweight mock handlers
            case 'launch':
              this.handleLaunchRequest(requestId, params as NodeJSLaunchRequestArguments);
              break;
            case 'continue':
              this.handleContinueRequest(requestId, params as DebugProtocol.ContinueArguments);
              break;
            case 'pause':
              this.handlePauseRequest(requestId, params as DebugProtocol.PauseArguments);
              break;
            case 'stepIn':
              this.handleStepInRequest(requestId, params as DebugProtocol.StepInArguments);
              break;
            case 'stepOut':
              this.handleStepOutRequest(requestId, params as DebugProtocol.StepOutArguments);
              break;
            case 'next':
              this.handleNextRequest(requestId, params as DebugProtocol.NextArguments);
              break;
            case 'evaluate':
              this.handleEvaluateRequest(requestId, params as DebugProtocol.EvaluateArguments);
              break;
            case 'stackTrace':
              this.handleStackTraceRequest(requestId, params as DebugProtocol.StackTraceArguments);
              break;
            case 'threads':
              this.handleThreadsRequest(requestId, params as Record<string, unknown>);
              break;
            default:
              throw new Error(`Unsupported DAP method: ${method}`);
          }
        } catch (error) {
          this.rejectRequest(requestId, error instanceof Error ? error : new Error(String(error)));
        }
      })();

      // Timeout handling
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`DAP request timeout: ${method}`));
        }
      }, 10000);

      this.pendingRequests.get(requestId)!.resolve = (value: unknown) => {
        clearTimeout(timeout);
        resolve(value as T);
      };
    });
  }

  // DAP Request Handlers
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleInitializeRequest(requestId: number, _args: DebugProtocol.InitializeRequestArguments): void {
    const response: DebugProtocol.InitializeResponse = {
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
      },
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleLaunchRequest(requestId: number, _args: NodeJSLaunchRequestArguments): Promise<void> {
    try {
      // Create mock response for launch
      const response: DebugProtocol.LaunchResponse = {
        seq: 0,
        type: 'response',
        request_seq: requestId,
        command: 'launch',
        success: true,
      };

      this.resolveRequest(requestId, response);
    } catch (error) {
      this.rejectRequest(requestId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async handleAttachRequest(requestId: number, _args: NodeJSAttachRequestArguments): Promise<void> {
    try {
      const response: DebugProtocol.AttachResponse = {
        seq: 0,
        type: 'response',
        request_seq: requestId,
        command: 'attach',
        success: true,
      };

      this.resolveRequest(requestId, response);
    } catch (error) {
      this.rejectRequest(requestId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleSetBreakpointsRequest(requestId: number, args: DebugProtocol.SetBreakpointsArguments): void {
    if (!this.connection.adapter) {
      this.rejectRequest(requestId, new Error('Debug adapter not available'));

      return;
    }

    // Mock response for setBreakpoints
    const actualBreakpoints: DebugProtocol.Breakpoint[] = [];

    if (args.breakpoints) {
      args.breakpoints.forEach((bp: DebugProtocol.SourceBreakpoint, index: number) => {
        const line = args.lines?.[index] ?? bp.line;

        actualBreakpoints.push({
          id: Date.now() + index, // Simple ID generation
          verified: true,
          line,
          column: bp.column,
          source: args.source,
        });
      });
    }

    const response: DebugProtocol.SetBreakpointsResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'setBreakpoints',
      success: true,
      body: {
        breakpoints: actualBreakpoints,
      },
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleContinueRequest(requestId: number, _args: DebugProtocol.ContinueArguments): void {
    const response: DebugProtocol.ContinueResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'continue',
      success: true,
      body: { allThreadsContinued: true },
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handlePauseRequest(requestId: number, _args: DebugProtocol.PauseArguments): void {
    const response: DebugProtocol.PauseResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'pause',
      success: true,
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleStepInRequest(requestId: number, _args: DebugProtocol.StepInArguments): void {
    const response: DebugProtocol.StepInResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'stepIn',
      success: true,
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleStepOutRequest(requestId: number, _args: DebugProtocol.StepOutArguments): void {
    const response: DebugProtocol.StepOutResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'stepOut',
      success: true,
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleNextRequest(requestId: number, _args: DebugProtocol.NextArguments): void {
    const response: DebugProtocol.NextResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'next',
      success: true,
    };

    this.resolveRequest(requestId, response);
  }

  private handleEvaluateRequest(requestId: number, args: DebugProtocol.EvaluateArguments): void {
    // Mock evaluation - in real implementation would evaluate in debug context
    const response: DebugProtocol.EvaluateResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'evaluate',
      success: true,
      body: {
        result: `"${args.expression}"`,
        variablesReference: 0,
      },
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleStackTraceRequest(requestId: number, _args: DebugProtocol.StackTraceArguments): void {
    const response: DebugProtocol.StackTraceResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'stackTrace',
      success: true,
      body: {
        stackFrames: [
          {
            id: 1,
            name: 'main',
            line: 1,
            column: 0,
            source: { name: 'main.js', path: '/path/to/main.js' },
          },
        ],
        totalFrames: 1,
      },
    };

    this.resolveRequest(requestId, response);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleThreadsRequest(requestId: number, _args: Record<string, unknown>): void {
    const response: DebugProtocol.ThreadsResponse = {
      seq: 0,
      type: 'response',
      request_seq: requestId,
      command: 'threads',
      success: true,
      body: {
        threads: [
          { id: 1, name: 'Main Thread' },
        ],
      },
    };

    this.resolveRequest(requestId, response);
  }

  private resolveRequest(requestId: number, response: unknown): void {
    const pendingRequest = this.pendingRequests.get(requestId);

    if (pendingRequest) {
      this.pendingRequests.delete(requestId);
      pendingRequest.resolve(response);
    }
  }

  private rejectRequest(requestId: number, error: Error): void {
    const pendingRequest = this.pendingRequests.get(requestId);

    if (pendingRequest) {
      this.pendingRequests.delete(requestId);
      pendingRequest.reject(error);
    }
  }

  // Public API methods (DAP interface)
  async connectDefault(): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.attachToProcess({ port: 9229 });
  }

  async connectUrl(url: string): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Extract port from URL if needed
    const match = url.match(/:(\d+)/);
    const port = match ? parseInt(match[1], 10) : 9229;

    return this.attachToProcess({ port });
  }

  async enableDebuggerPid(
    pid: number,
    opts?: { discoverTimeoutMs?: number; probeTimeoutMs?: number; ports?: number[] },
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      let activation: 'strace' | 'poll' | 'timeout' = 'timeout';
      let detectedPort: number | undefined;
      let detectedUrl: string | undefined;
      // Helper: check command availability quickly
      const isCommandAvailable = async (cmd: string, args: string[] = ["-V"]): Promise<boolean> =>
        new Promise((resolve) => {
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
                  void 0;
                }
              }
            };

            p.once("spawn", () => {
              finish(true);
            });
            p.once("error", () => {
              finish(false);
            });

            setTimeout(() => {
              finish(true);
            }, 200).unref();
          } catch {
            resolve(false);
          }
        });
      // Helper: probe inspector HTTP endpoint
      const probeInspector = (probePort: number, timeoutMs = 500): Promise<boolean> => new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: probePort, path: '/json/version', timeout: timeoutMs }, (res) => {
          const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500;

          res.resume();
          resolve(ok);
        });

        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => { resolve(false); });
      });
      // Try to observe debugger activation via strace (Linux only, best-effort)
      const canUseStrace = process.platform !== 'win32' && await isCommandAvailable('strace', ['-V']);
      let strace: ReturnType<typeof spawn> | null = null;

      try {
        strace = canUseStrace ? spawn("strace", ["-p", String(pid), "-e", "write", "-s", "200", "-f"]) : null;
      } catch {
        strace = null;
      }

      let waitForDebuggerLine: () => Promise<void>;

      if (!strace) {
        waitForDebuggerLine = async () => {
          /* no-op */
        };
      } else {
        const sLocal = strace;

        waitForDebuggerLine = () =>
          new Promise<void>((resolve) => {
            const onData = (buf: Buffer) => {
              const out = buf.toString();
              // Look for typical Node inspector messages
              const fullUrlMatch = out.match(/Debugger listening on (ws:\/\/[^\s]+)/);
              const portMatch = out.match(/Debugger listening on (?:port )?(\d+)/);

              if (fullUrlMatch) {
                detectedUrl = fullUrlMatch[1];

                const m = detectedUrl.match(/:(\d+)/);

                if (m) detectedPort = parseInt(m[1], 10);
                activation = "strace";
                cleanup();
                resolve();
              } else if (portMatch) {
                detectedPort = parseInt(portMatch[1], 10);
                activation = "strace";
                cleanup();
                resolve();
              }
            };
            const onExit = () => {
              resolve();
            };
            const cleanup = () => {
              sLocal.stderr?.off("data", onData);
              sLocal.stdout?.off("data", onData);
              sLocal.off("exit", onExit);
              try {
                sLocal.kill();
              } catch {
                void 0;
              }
            };

            sLocal.stderr?.on("data", onData);
            sLocal.stdout?.on("data", onData);
            sLocal.once("exit", onExit);
            // Safety timeout
            setTimeout(() => {
              cleanup();
              resolve();
            }, 8000).unref();
          });
      }

      // Send SIGUSR1 to enable debugging
      kill(pid, 'SIGUSR1');

      // Wait for activation signal from strace (best-effort)
      await waitForDebuggerLine();

      // If we didn't see the port via strace, poll common inspector ports
      if (!detectedPort) {
        const candidates: number[] = opts?.ports?.length
          ? opts.ports
          : [
              9229, 9230, 9231, 9232, 9233, 9234, 9235, 9236, 9237, 9238, 9239, 9240, 9241, 9242, 9243, 9244, 9245,
              9246, 9247, 9248, 9249, 9250,
            ];
        const deadline = Date.now() + (opts?.discoverTimeoutMs ?? 8000);

        while (!detectedPort && Date.now() < deadline) {
          for (const cand of candidates) {
            const ok = await probeInspector(cand, opts?.probeTimeoutMs ?? 400);

            if (ok) {
              detectedPort = cand;
              activation = "poll";
              break;
            }
          }
          if (!detectedPort) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      // If no port detected, fallback to default inspector port
      const portToUse = detectedPort ?? 9229;
      const attachResult = await this.attachToProcess({ port: portToUse });

      // Enrich success response with activation details
      try {
        const parsed = JSON.parse(attachResult.content[0].text);
        const enriched = {
          ...parsed,
          debug: {
            activation,
            detectedPort: portToUse,
            webSocketUrl: this.webSocketUrl,
          },
        };

        return createSuccessResponse(enriched);
      } catch {
        return attachResult;
      }
    } catch (error) {
      return createErrorResponse(
        'Failed to enable debugger',
        JSON.stringify({ pid, error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  async attachToProcess(args: { port?: number; address?: string }): Promise<{ content: Array<{ type: string; text: string }> }> {
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

      // Attach to the Node.js process
      await this.sendRequest('attach', {
        port: args.port ?? 9229,
        address: args.address ?? 'localhost',
      });

      this.connection.isConnected = true;
      this.emitStateChange(true);

      return createSuccessResponse({
        message: `Attached to Node.js process on ${args.address ?? 'localhost'}:${args.port ?? 9229}`,
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
        await this.sendRequest('disconnect', {});
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

  // Logpoint and event management
  getLogpointHits(): LogpointHit[] {
    return [...this.logpointHits];
  }

  clearLogpointHits(): void {
    this.logpointHits = [];
  }

  getDebuggerEvents(): DebuggerEvent[] {
    return [...this.debuggerEvents];
  }

  clearDebuggerEvents(): void {
    this.debuggerEvents = [];
  }

  // Direct DAP method access
  async dapRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.sendRequest<T>(method, params);
  }
}
