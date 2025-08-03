import CDP from "chrome-remote-interface";
import { EventEmitter } from "events";
import { DebuggerConnection, LogpointHit, DebuggerEvent, TrackedBreakpoint } from "./types.js";
import type { Protocol } from 'devtools-protocol';
import { sleep } from "./utils.js";

export class CDPClient extends EventEmitter {
  private debugger: DebuggerConnection = {
    client: null,
    isConnected: false,
  };
  private logpointHits: LogpointHit[] = [];
  private debuggerEvents: DebuggerEvent[] = [];
  private trackedBreakpoints: Map<string, TrackedBreakpoint> = new Map();

  constructor() {
    super();
  }

  private setupEventHandlers(client: CDP.Client) {
    // Listen for console API calls (includes logpoint outputs)
    client.Runtime.consoleAPICalled((params: Protocol.Runtime.ConsoleAPICalledEvent) => {
      this.handleConsoleAPICall(params);
    });

    // Listen for debugger paused events
    client.Debugger.paused((params: Protocol.Debugger.PausedEvent) => {
      this.handleDebuggerPaused(params);
    });

    // Listen for debugger resumed events
    client.Debugger.resumed(() => {
      this.handleDebuggerResumed();
    });
  }

  private handleDebuggerPaused(params: Protocol.Debugger.PausedEvent) {
    const debuggerEvent: DebuggerEvent = {
      type: 'paused',
      timestamp: new Date(),
      data: params
    };

    this.debuggerEvents.push(debuggerEvent);
    this.emit('debuggerPaused', debuggerEvent);
  }

  private handleDebuggerResumed() {
    const debuggerEvent: DebuggerEvent = {
      type: 'resumed',
      timestamp: new Date(),
      data: {} as Record<string, never>
    };

    this.debuggerEvents.push(debuggerEvent);
    this.emit('debuggerResumed', debuggerEvent);
  }

  // Event subscription methods for state management
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

  private handleConsoleAPICall(params: Protocol.Runtime.ConsoleAPICalledEvent) {
    // Process console.log calls from logpoints
    const args = params.args ?? [];

    const message = args.map((arg: Protocol.Runtime.RemoteObject) => {
      if (arg.type === 'string') return String(arg.value);
      if (arg.type === 'undefined') return 'undefined';
      if (arg.type === 'object' && arg.value) return JSON.stringify(arg.value);

      return String(arg.value ?? arg.type);
    }).join(' ');

    // Check if this is a logpoint message
    if (message.includes('LOGPOINT:')) {
      const logpointHit: LogpointHit = {
        message,
        timestamp: new Date(params.timestamp),
        executionContextId: params.executionContextId,
        stackTrace: params.stackTrace
      };

      this.logpointHits.push(logpointHit);
      this.emit('logpointHit', logpointHit);
    }
  }

  getLogpointHits(): LogpointHit[] {
    return [...this.logpointHits];
  }

  clearLogpointHits() {
    this.logpointHits = [];
  }

  getDebuggerEvents(): DebuggerEvent[] {
    return [...this.debuggerEvents];
  }

  clearDebuggerEvents() {
    this.debuggerEvents = [];
  }

  // Breakpoint tracking methods
  addTrackedBreakpoint(breakpoint: TrackedBreakpoint) {
    this.trackedBreakpoints.set(breakpoint.breakpointId, breakpoint);
  }

  removeTrackedBreakpoint(breakpointId: string) {
    this.trackedBreakpoints.delete(breakpointId);
  }

  getTrackedBreakpoints(): TrackedBreakpoint[] {
    return Array.from(this.trackedBreakpoints.values());
  }

  getTrackedBreakpoint(breakpointId: string): TrackedBreakpoint | undefined {
    return this.trackedBreakpoints.get(breakpointId);
  }

  clearTrackedBreakpoints() {
    this.trackedBreakpoints.clear();
  }

  private async enableDomains(client: CDP.Client) {
    await client.Runtime.enable();
    await client.Debugger.enable();

    // Enable source map support
    await client.Debugger.setPauseOnExceptions({ state: "none" });
    await client.Debugger.setAsyncCallStackDepth({ maxDepth: 32 });
  }

  get client(): CDP.Client | null {
    return this.debugger.client;
  }

  get isConnected(): boolean {
    return this.debugger.isConnected;
  }

  get webSocketUrl(): string | undefined {
    return this.debugger.webSocketUrl;
  }

  async connectDefault() {
    try {
      const client = await CDP({ port: 9229 });

      this.debugger.client = client;
      this.debugger.isConnected = true;

      await this.enableDomains(client);
      this.setupEventHandlers(client);
      this.emitStateChange(true);

      return {
        content: [
          {
            type: "text",
            text: "Successfully connected to Node.js debugger on port 9229",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to connect to debugger: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  async connectUrl(url: string) {
    try {
      const client = await CDP({ target: url });

      this.debugger.client = client;
      this.debugger.isConnected = true;
      this.debugger.webSocketUrl = url;

      await this.enableDomains(client);
      this.setupEventHandlers(client);
      this.emitStateChange(true);

      return {
        content: [
          {
            type: "text",
            text: `Successfully connected to debugger at ${url}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to connect to debugger: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  async enableDebuggerPid(pid: number, port: number = 9229) {
    try {
      process.kill(pid, "SIGUSR1");

      await sleep(1000);

      const client = await CDP({ port });

      this.debugger.client = client;
      this.debugger.isConnected = true;

      await this.enableDomains(client);
      this.setupEventHandlers(client);
      this.emitStateChange(true);

      return {
        content: [
          {
            type: "text",
            text: `Successfully enabled debugger for PID ${pid} and connected on port ${port}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to enable debugger for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  async disconnect() {
    if (this.debugger.client) {
      await this.debugger.client.close();
      this.debugger.client = null;
      this.debugger.isConnected = false;
      this.debugger.webSocketUrl = undefined;
      this.emitStateChange(false);
    }
  }
}
