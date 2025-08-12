import CDP from 'chrome-remote-interface';
import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import type ProtocolMappingApi from 'devtools-protocol/types/protocol-mapping';

export interface CDPTransportOptions {
  host?: string;
  port?: number;
  target?: string | ((targets: CDP.Target[]) => CDP.Target);
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
  private readonly reconnectDelay = 1000;

  constructor(private readonly options: CDPTransportOptions = {}) {
    super();
    this.options = {
      host: 'localhost',
      port: 9229,
      ...options,
    };
  }

  async connect(): Promise<CDPConnection> {
    try {
      // Get available targets from Node.js inspector
      const targets = await CDP.List({
        host: this.options.host,
        port: this.options.port,
      });

      if (targets.length === 0) {
        throw new Error('No debuggable targets found');
      }

      // Select target - use first if no selector provided
      let selectedTarget: CDP.Target;

      if (typeof this.options.target === 'function') {
        selectedTarget = this.options.target(targets);
      } else if (typeof this.options.target === 'string') {
        const found = targets.find(t => t.id === this.options.target);

        if (!found) {
          throw new Error(`Target with ID ${this.options.target} not found`);
        }
        selectedTarget = found;
      } else {
        selectedTarget = targets[0];
      }

      // Create CDP client connection
      this.client = await CDP({
        host: this.options.host,
        port: this.options.port,
        target: selectedTarget.webSocketDebuggerUrl,
      });

      this.target = selectedTarget;
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Set up event forwarding
      this.setupEventForwarding();

      this.emit('connected', { client: this.client, target: this.target });

      return { client: this.client, target: this.target };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
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
      this.handleReconnection();
    });

    // Handle errors
    this.client.on('error', (error) => {
      this.emit('error', error);
    });
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnection attempts reached'));

      return;
    }

    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts);

    try {
      await setTimeout(this.reconnectDelay * this.reconnectAttempts);
      await this.connect();
    } catch (error) {
      this.emit('reconnect-failed', error);
      this.handleReconnection();
    }
  }

  async enableDomains(domains: string[]): Promise<void> {
    if (!this.client) {
      throw new Error('CDP client not connected');
    }

    for (const domain of domains) {
      try {
        const enableMethod = `${domain}.enable` as keyof CDP.Client;

        if (typeof this.client[enableMethod] === 'function') {
          await (this.client[enableMethod] as () => Promise<void>)();
        }
      } catch (error) {
        this.emit('error', new Error(`Failed to enable domain ${domain}: ${error instanceof Error ? error.message : String(error)}`));
        throw error;
      }
    }
  }

  async sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.client) {
      throw new Error('CDP client not connected');
    }

    try {
      // Use CDP client's generic send method
      const result = await this.client.send(method as keyof ProtocolMappingApi.Commands, params);

      return result as T;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
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
