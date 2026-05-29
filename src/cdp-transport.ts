import CDP from 'chrome-remote-interface';
import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import type ProtocolMappingApi from 'devtools-protocol/types/protocol-mapping';
import { DEFAULTS } from './constants.js';
import { errorMessage } from './utils.js';
import { NotConnectedError, NotFoundError, ProtocolError } from './errors.js';

export interface CDPTransportOptions {
  host?: string | undefined;
  port?: number | undefined;
  target?: string | ((targets: CDP.Target[]) => CDP.Target) | undefined;
}

export interface CDPConnection {
  client: CDP.Client;
  target: CDP.Target;
}

export class CDPTransport extends EventEmitter {
  private client: CDP.Client | null = null;
  private target: CDP.Target | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  // Exponential backoff with full jitter and an upper cap, matching the
  // discoverInspectorPort poll strategy: base doubles each attempt (1000 ->
  // 2000 -> 4000 -> ...) capped at reconnectMaxDelayMs, then jittered into
  // [delay/2, delay] so concurrent transports don't retry in lockstep.
  private readonly reconnectBaseDelayMs = 1000;
  private readonly reconnectMaxDelayMs = 8000;

  constructor(private readonly options: CDPTransportOptions = {}) {
    super();
    this.options = {
      host: DEFAULTS.INSPECTOR_CLIENT_HOST,
      port: DEFAULTS.INSPECTOR_PORT,
      ...options,
    };
  }

  async connect(): Promise<CDPConnection> {
    // Critical path: failures propagate via throw only. Previously this method
    // also called this.emit('error', error) before re-throwing, which double-
    // logged every connect failure (once via the OutputEvent subscriber, once
    // via the caller's withErrorHandling) and risked unhandledRejection if no
    // subscriber was attached yet.
    const targets = await CDP.List({
      host: this.options.host,
      port: this.options.port,
    });

    if (targets.length === 0) {
      throw new NotFoundError('No debuggable targets found');
    }

    let selectedTarget: CDP.Target;

    if (typeof this.options.target === 'function') {
      selectedTarget = this.options.target(targets);
    } else if (typeof this.options.target === 'string') {
      const found = targets.find(t => t.id === this.options.target);

      if (!found) {
        throw new NotFoundError(`Target with ID ${this.options.target} not found`);
      }
      selectedTarget = found;
    } else {
      selectedTarget = targets[0]!;
    }

    this.client = await CDP({
      host: this.options.host,
      port: this.options.port,
      target: selectedTarget.webSocketDebuggerUrl,
    });

    this.target = selectedTarget;
    this.isConnected = true;
    this.reconnectAttempts = 0;

    this.setupEventForwarding();

    this.emit('connected', { client: this.client, target: this.target });

    return { client: this.client, target: this.target };
  }

  private setupEventForwarding(): void {
    if (!this.client) return;

    // Forward CDP events
    this.client.on('event', (message) => {
      this.emit('cdp-event', message);
    });

    // Handle disconnect
    this.client.on('disconnect', () => {
      this.isConnected = false;
      this.emit('disconnected');
      // Fire-and-forget reconnection: handleReconnection logs its own errors
      // and the event handler signature is synchronous (CDP client expects
      // void). Marking with `void` documents the intentional escape and
      // satisfies @typescript-eslint/no-floating-promises.
      void this.handleReconnection();
    });

    // Handle errors
    this.client.on('error', (error) => {
      this.emit('error', error);
    });
  }

  private async handleReconnection(): Promise<void> {
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.emit('reconnecting', this.reconnectAttempts);

      try {
        const cappedDelay = Math.min(
          this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1),
          this.reconnectMaxDelayMs,
        );
        // Full jitter: sleep a random duration in [cappedDelay/2, cappedDelay].
        const jitteredDelay = cappedDelay / 2 + Math.random() * (cappedDelay / 2);

        await setTimeout(jitteredDelay);
        await this.connect();
        // Distinct from the initial 'connected' event: subscribers that need
        // to re-issue per-attach CDP setup (Runtime.addBinding, enableDomains
        // beyond what setupEventForwarding wires up) listen here. The fresh
        // client has no inherited state from the previous session.
        this.emit('reconnected');

        return;
      } catch (error) {
        this.emit('reconnect-failed', error);
      }
    }

    // Reset the counter after exhausting retries so a follow-up disconnect
    // event can start a fresh reconnect cycle instead of seeing the counter
    // pinned at maxReconnectAttempts forever.
    this.reconnectAttempts = 0;
    this.emit('error', new Error('Max reconnection attempts reached'));
  }

  async enableDomains(domains: string[]): Promise<void> {
    const {client} = this;

    if (!client) {
      throw new NotConnectedError('CDP client not connected');
    }

    // Enable each domain in parallel: CDP dispatches by request id, so these
    // calls are independent. Sequentially we paid one full RTT per domain on
    // every attach (Runtime, Debugger, Console, Profiler ≈ 4 round trips).
    // Promise.all rejects on the first error, so we still surface the first
    // failure with the same ProtocolError envelope; the others are abandoned.
    await Promise.all(domains.map(async (domain) => {
      try {
        const enableMethod = `${domain}.enable` as keyof CDP.Client;

        if (typeof client[enableMethod] === 'function') {
          await (client[enableMethod] as () => Promise<void>)();
        }
      } catch (error) {
        // Critical path: throw only. Same rationale as connect() -- a parallel
        // emit('error', ...) doubles up log lines for a single failure.
        throw new ProtocolError(`Failed to enable domain ${domain}: ${errorMessage(error)}`, { cause: error });
      }
    }));
  }

  async sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.client) {
      throw new NotConnectedError('CDP client not connected');
    }

    // Critical path: throw only. The parallel emit('error', ...) used to
    // double-log every CDP send failure via the OutputEvent subscriber on
    // top of the rejection seen by the caller. Callers that need to log
    // failures already do so via withErrorHandling or sendErrorResponse.
    const result = await this.client.send(method as keyof ProtocolMappingApi.Commands, params);

    return result as T;
  }

  getClient(): CDP.Client | null {
    return this.client;
  }

  getTarget(): CDP.Target | null {
    return this.target;
  }

  isConnectionActive(): boolean {
    return this.isConnected && this.client !== null;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        this.emit('error', error);
      }
      this.client = null;
    }

    this.target = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.emit('disconnected');
  }
}
