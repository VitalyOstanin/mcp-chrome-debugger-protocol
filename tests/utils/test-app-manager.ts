import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { findProjectRoot } from "../../src/utils.js";
import { spawnedProcesses } from "../setup";

export interface TestAppOptions {
  enableDebugger?: boolean | undefined;
  port?: number; // For cases where we need a specific port (like connect_default)
  serverPort?: number; // Port for the HTTP server
  debug?: boolean; // Debug mode
  appType?: 'typescript' | 'javascript'; // Which test app to use
}

export class TestAppManager {
  private process: ChildProcess | null = null;
  private appPath: string;
  private port: number | null = null; // Debugger port
  private serverPort: number | null = null; // HTTP server port
  private webSocketUrl: string | null = null;
  private isRunning = false;
  private appType: 'typescript' | 'javascript';

  constructor(appType: 'typescript' | 'javascript' = 'typescript') {
    this.appType = appType;
    this.appPath = TestAppManager.resolveAppPath(appType);
  }

  private static resolveAppPath(appType: 'typescript' | 'javascript'): string {
    const relative = appType === 'javascript'
      ? ['tests', 'fixtures', 'test-app-js', 'src', 'index.js']
      : ['tests', 'fixtures', 'test-app', 'dist', 'index.js'];
    const projectRoot = findProjectRoot(__dirname);

    if (projectRoot) {
      return path.join(projectRoot, ...relative);
    }

    // Fallback to relative path if project root not found
    const fallback = appType === 'javascript'
      ? "../fixtures/test-app-js/src/index.js"
      : "../fixtures/test-app/dist/index.js";

    return path.resolve(__dirname, fallback);
  }

  async start(options: TestAppOptions = {}): Promise<{ pid: number; port?: number; serverPort?: number; webSocketUrl?: string }> {
    if (this.isRunning) {
      throw new Error("Test app is already running");
    }

    // Update app type and path if specified in options
    if (options.appType && options.appType !== this.appType) {
      this.appType = options.appType;
      this.updateAppPath();
    }

    const args: string[] = [];

    if (options.enableDebugger) {
      if (options.port) {
        args.push(`--inspect=127.0.0.1:${options.port}`);
      } else {
        args.push("--inspect=0"); // Let Node.js choose a free port
      }
    }

    args.push(this.appPath);

    const env = { ...process.env };

    if (options.serverPort) {
      env.MCP_TEST_APP_PORT = options.serverPort.toString();
    }

    this.process = spawn("node", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    if (!this.process.pid) {
      throw new Error("Failed to start test application");
    }

    // Track the process PID for cleanup
    spawnedProcesses.add(this.process.pid);
    this.isRunning = true;

    // For non-debugger cases, still need to capture server port
    if (!options.enableDebugger) {
      return new Promise((resolve, reject) => {
        let serverReady = false;

        this.process!.on("error", (error) => {
          this.isRunning = false;
          reject(error);
        });

        this.process!.on("exit", (code) => {
          this.isRunning = false;
          if (!serverReady) {
            reject(new Error(`Process exited with code ${code} before server was ready`));
          }
        });

        // Listen for HTTP server startup message
        this.process!.stdout?.on("data", (data) => {
          const output = data.toString();
          const serverPort = this.parseServerPort(output);

          if (serverPort && !serverReady) {
            this.serverPort = serverPort;
            serverReady = true;

            resolve({
              pid: this.process!.pid!,
              serverPort,
            });
          }
        });

        this.process!.stderr?.on("data", (data) => {
          // Surface stderr so a crashing fixture is not silently hidden behind
          // "Process exited with code 1 before server was ready".
          process.stderr.write(`[test-app] ${data}`);
        });
      });
    }

    // For debugger cases, wait for both debugger and server to start
    return new Promise((resolve, reject) => {
      let debuggerReady = false;
      let serverReady = false;
      let debugInfo: { port: number; webSocketUrl: string } | null = null;
      let serverPort: number | null = null;
      const tryResolve = () => {
        if (debuggerReady && serverReady && debugInfo) {
          resolve({
            pid: this.process!.pid!,
            port: debugInfo.port,
            serverPort: serverPort!,
            webSocketUrl: debugInfo.webSocketUrl,
          });
        }
      };

      this.process!.on("error", (error) => {
        this.isRunning = false;
        reject(error);
      });

      this.process!.on("exit", (code) => {
        this.isRunning = false;
        if (!(debuggerReady && serverReady)) {
          reject(new Error(`Process exited with code ${code} before services were ready`));
        }
      });

      // Listen for HTTP server startup message
      this.process!.stdout?.on("data", (data) => {
        const output = data.toString();
        const parsedServerPort = this.parseServerPort(output);

        if (parsedServerPort && !serverReady) {
          this.serverPort = parsedServerPort;
          serverPort = parsedServerPort;
          serverReady = true;
          tryResolve();
        }
      });

      // Parse stderr for debugger URL - wait until we get the message.
      // Always mirror stderr to the test runner so a crashing fixture is not silently
      // hidden behind "Process exited with code 1 before services were ready".
      this.process!.stderr?.on("data", (data) => {
        const output = data.toString();

        process.stderr.write(`[test-app] ${data}`);

        const parsedDebugInfo = this.parseDebuggerUrl(output);

        if (parsedDebugInfo && !debuggerReady) {
          this.port = parsedDebugInfo.port;
          this.webSocketUrl = parsedDebugInfo.webSocketUrl;
          debugInfo = parsedDebugInfo;
          debuggerReady = true;
          tryResolve();
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!(this.process && this.isRunning)) {
      return;
    }

    this.process.kill("SIGTERM");

    // Use modern Promise-based approach with async/await
    let processExited = false;
    const exitPromise = new Promise<void>((resolve) => {
      if (!this.process) {
        resolve();

        return;
      }

      this.process.on("exit", () => {
        processExited = true;
        resolve();
      });
    });

    try {
      // Race between process exit and timeout
      await Promise.race([
        exitPromise,
        setTimeout(5000).then(() => {
          if (!processExited && this.process && !this.process.killed) {
            this.process.kill("SIGKILL");
          }
        }),
      ]);
    } catch {
      // Ignore timeout errors
    }

    // Remove PID from tracked processes
    if (this.process.pid) {
      spawnedProcesses.delete(this.process.pid);
    }

    this.process = null;
    this.port = null;
    this.serverPort = null;
    this.webSocketUrl = null;
    this.isRunning = false;
  }

  async sendSignal(signal: NodeJS.Signals): Promise<void> {
    if (!(this.process && this.isRunning)) {
      throw new Error("Test app is not running");
    }

    this.process.kill(signal);
  }

  async enableDebugger(): Promise<number> {
    if (!(this.process && this.isRunning)) {
      throw new Error("Test app is not running");
    }

    return new Promise((resolve, reject) => {
      let debuggerReady = false;
      // Listen for debugger startup message
      const stderrHandler = (data: Buffer) => {
        const output = data.toString();
        const debugInfo = this.parseDebuggerUrl(output);

        if (debugInfo && !debuggerReady) {
          this.port = debugInfo.port;
          this.webSocketUrl = debugInfo.webSocketUrl;
          debuggerReady = true;
          this.process!.stderr!.off('data', stderrHandler);
          resolve(debugInfo.port);
        }
      };
      // Listen for process exit
      const exitHandler = (code: number | null) => {
        if (!debuggerReady) {
          this.process!.stderr!.off('data', stderrHandler);
          reject(new Error(`Process exited with code ${code} before debugger was enabled`));
        }
      };

      this.process!.stderr!.on('data', stderrHandler);
      this.process!.once('exit', exitHandler);

      // Send SIGUSR1 to enable debugger. Fire-and-forget: the surrounding
      // Promise resolves on the inspector's "Debugger listening" stderr line
      // (stderrHandler above), so awaiting sendSignal here would race with
      // its own outcome. Errors from sendSignal still propagate via the
      // exit/error handlers above.
      void this.sendSignal("SIGUSR1");
    });
  }

  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  getPort(): number | null {
    return this.port;
  }

  getServerPort(): number | null {
    return this.serverPort;
  }

  getWebSocketUrl(): string | null {
    return this.webSocketUrl;
  }

  isAppRunning(): boolean {
    return this.isRunning && this.process !== null;
  }

  getMainFilePath(): string {
    return this.appPath;
  }

  private parseServerPort(stdoutOutput: string): number | null {
    // Look for HTTP server listening message
    const pattern = /HTTP server listening on port (\d+)/;
    const match = stdoutOutput.match(pattern);

    if (match?.[1]) {
      return parseInt(match[1], 10);
    }

    return null;
  }

  private parseDebuggerUrl(stderrOutput: string): { port: number; webSocketUrl: string } | null {
    // Support different Node.js output formats including IPv6
    const patterns = [
      /Debugger listening on (ws:\/\/\[?[^\]]+\]?:\d+\/[a-f0-9-]+)/,    // Full WebSocket URL (IPv4/IPv6)
      /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/,    // IPv4 with UUID
      /Debugger listening on (ws:\/\/\[::1\]:\d+\/[a-f0-9-]+)/,        // IPv6 localhost with UUID
      /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//,             // Legacy IPv4 format
      /Debugger listening on ws:\/\/\[::1\]:(\d+)\//,                  // Legacy IPv6 format
      /Debugger listening on port (\d+)/,                              // Old format with port only
    ];

    for (const pattern of patterns) {
      const match = stderrOutput.match(pattern);

      if (match?.[1]) {
        const captured = match[1];

        if (captured.startsWith('ws://')) {
          // Full WebSocket URL found
          const webSocketUrl = captured;
          // Extract port from IPv4 or IPv6 URL
          const portMatch = webSocketUrl.match(/:(\d+)\//) ?? webSocketUrl.match(/\]:(\d+)\//);

          if (portMatch?.[1]) {
            return {
              port: parseInt(portMatch[1]),
              webSocketUrl,
            };
          }
        } else {
          // Only port number found, construct WebSocket URL (default to IPv4)
          const port = parseInt(captured);

          return {
            port,
            webSocketUrl: `ws://127.0.0.1:${port}`,
          };
        }
      }
    }

    return null;
  }

  private updateAppPath(): void {
    this.appPath = TestAppManager.resolveAppPath(this.appType);
  }
}
