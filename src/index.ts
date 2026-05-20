#!/usr/bin/env node

import { NodeDebuggerMCPServer } from "./mcp-server.js";
import { logError } from "./logger.js";
import { packageManifest } from "./package-manifest.js";

// Fire-and-forget paths exist throughout the codebase (CDP event handlers,
// `void this.cdpTransport.sendCommand(...)` in nodejs-debug-adapter, async
// listeners passed to EventEmitter.on). Without these top-level handlers a
// rejection from any of those would either be swallowed by Node's default
// unhandledRejection behaviour or terminate the process abruptly without
// stderr context, leaving MCP clients with nothing but a stdio disconnect.
//
// uncaughtException is treated as fatal: the process state is undefined past
// this point, so we log and exit non-zero so the host (Claude Code, etc) can
// restart us cleanly. unhandledRejection is logged but does not exit -- many
// rejections come from event handlers whose failure should not take down the
// whole debug session.
process.on('uncaughtException', (error: Error) => {
  logError('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logError('Unhandled promise rejection', reason);
});

function printHelp(): void {
  // stdout is reserved for MCP JSON-RPC traffic when the server is running, but
  // --help is invoked before the transport starts, so stdout is the right place
  // for human-readable text (matches conventions for CLI tooling).
  process.stdout.write(`${packageManifest.name} v${packageManifest.version}

Usage: mcp-chrome-debugger-protocol [--help|--version]

This binary implements a Model Context Protocol (MCP) server that exposes the
Chrome DevTools Protocol (CDP) Node.js debugger over stdio. It is not an
interactive CLI — it is meant to be launched by an MCP client (Claude Code,
similar agents) which speaks JSON-RPC on stdin/stdout.

Options:
  --help, -h       Print this help message and exit.
  --version, -v    Print the version and exit.

Environment variables:
  DAP_VERBOSE             When set to "1" or "true", emit verbose adapter
                          diagnostics on stderr (source-map resolution,
                          breakpoint placement, CDP fallbacks, reconnect
                          attempts). Do not enable in production / shared
                          environments — output may include user-supplied
                          breakpoint conditions and resolved file paths.
  MCP_CDP_ALLOW_REMOTE    When set to "1" or "true", allow the attach tool
                          to target non-loopback addresses. Default is off
                          (only 127.0.0.1 / localhost are accepted) so a
                          stray attach can't expose a remote inspector.

Configuration (claude mcp add example):
  claude mcp add chrome-debugger -- mcp-chrome-debugger-protocol

See README.md for tool reference and supported MCP operations.
`);
}

function parseArgsAndMaybeExit(argv: string[]): void {
  // argv = process.argv.slice(2) -- a tiny native parser is enough; pulling in
  // commander/yargs would add a dependency for two flags.
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`${packageManifest.version}\n`);
      process.exit(0);
    }
  }
}

async function main() {
  parseArgsAndMaybeExit(process.argv.slice(2));

  const server = new NodeDebuggerMCPServer();
  // Track shutdown to make SIGINT/SIGTERM idempotent: a second signal during
  // graceful shutdown shouldn't re-enter close() and race the first one.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    // stderr only -- stdout is the MCP transport.
    process.stderr.write(`Received ${signal}, shutting down...\n`);

    try {
      await server.close();
    } catch (error) {
      logError(`Error during shutdown on ${signal}`, error);
    }

    // 128 + signal number is the standard exit code for "killed by signal";
    // SIGINT = 2, SIGTERM = 15. We approximate by exiting 0 after a clean
    // shutdown since the host expects a graceful close, not signal status.
    process.exit(0);
  };

  process.on('SIGINT', (signal) => { void shutdown(signal); });
  process.on('SIGTERM', (signal) => { void shutdown(signal); });

  await server.run();
}

main().catch((error) => {
  logError("Server error", error);
  process.exit(1);
});
