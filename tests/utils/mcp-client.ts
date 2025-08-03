import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChildProcess } from "child_process";
import path from "path";
import { spawnedProcesses } from "../setup";

export interface MCPToolResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export class MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private isConnected = false;

  constructor(private serverPath: string) {}

  async connect(): Promise<void> {
    if (this.isConnected) {
      throw new Error("Already connected");
    }

    const serverAbsolutePath = path.resolve(this.serverPath);

    this.transport = new StdioClientTransport({
      command: "node",
      args: [serverAbsolutePath],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined)
      ) as Record<string, string>,
    });

    this.client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await this.client.connect(this.transport);
    this.isConnected = true;

    // Track the server process PID for cleanup
    if (this.transport.pid) {
      spawnedProcesses.add(this.transport.pid);
    }

    this.transport.onerror = (error) => {
      console.error("MCP transport error:", error);
    };

    // Access stderr if needed
    const {stderr} = this.transport;

    if (stderr) {
      stderr.on("data", (data) => {
        console.error(`Server stderr: ${data}`);
      });
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      if (this.client) {
        await this.client.close();
      }
    } catch (error) {
      console.error("Error closing client:", error);
    }

    try {
      if (this.transport) {
        // Remove PID from tracked processes before closing
        if (this.transport.pid) {
          spawnedProcesses.delete(this.transport.pid);
        }
        await this.transport.close();
      }
    } catch (error) {
      console.error("Error closing transport:", error);
    }

    this.client = null;
    this.transport = null;
    this.isConnected = false;
  }

  async listTools(): Promise<unknown[]> {
    if (!this.client) {
      throw new Error("Not connected");
    }

    const response = await this.client.listTools();

    return response.tools;
  }

  async callTool(name: string, arguments_?: unknown): Promise<MCPToolResult> {
    if (!this.client) {
      throw new Error("Not connected");
    }

    try {
      const response = await this.client.callTool({
        name,
        arguments: arguments_ ? arguments_ as Record<string, unknown> : {},
      });

      return {
        content: (response.content ?? []) as Array<{ type: string; text: string }>,
        isError: response.isError as boolean | undefined,
      };
    } catch (error) {
      // Only log unexpected errors, not tool disabled errors
      if (!(error instanceof Error && error.message.includes('disabled'))) {
        console.error(`Tool call error for ${name}:`, error);
      }
      throw error;
    }
  }

  getServerProcess(): ChildProcess | null {
    return this.transport?.pid ? { pid: this.transport.pid } as ChildProcess : null;
  }

  isClientConnected(): boolean {
    return this.isConnected;
  }
}
