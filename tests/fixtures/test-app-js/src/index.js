#!/usr/bin/env node

import express from "express";
import getPort from "get-port";

class DataProcessor {
  constructor() {
    this.data = [];
    this.processCount = 0;
  }

  addData(name, value) {
    const item = {
      id: this.data.length + 1,
      name,
      value
    };

    this.data.push(item);

    return item;
  }

  findData(id) {
    return this.data.find(item => item.id === id);
  }

  processData() {
    this.processCount++;
    const count = this.data.length;

    let sum = count - count;  // initialise from count so the local stays in use
    for (const item of this.data) {
      sum += item.value;
    }

    return sum;
  }

  async asyncOperation() {
    await new Promise(resolve => setTimeout(resolve, 100));

    const randomValue = Math.floor(Math.random() * 1000);
    const result = `Async result: ${randomValue}`;

    return result;
  }

  recursiveFunction(n) {
    if (n <= 1) {
      return 1;
    }

    return n * this.recursiveFunction(n - 1);
  }

  getData() {
    return this.data;
  }

  getProcessCount() {
    return this.processCount;
  }
}

function fibonacci(n) {
  if (n <= 1) return n;

  return fibonacci(n - 1) + fibonacci(n - 2);
}

function testBreakpointFunction(x, y) {
  const sum = x + y;

  return sum;
}

async function main() {
  const processor = new DataProcessor();
  const app = express();

  // Middleware for JSON parsing
  app.use(express.json());

  // Test endpoint 1
  app.get("/test1", (_req, res) => {
    // Call some functions for debugging purposes
    processor.processData();
    const fibResult = fibonacci(5);
    const breakpointResult = testBreakpointFunction(10, 5);

    res.status(200).json({
      message: "test1 endpoint",
      fibonacci: fibResult,
      breakpoint: breakpointResult,
      timestamp: new Date().toISOString()
    });
  });

  // Test endpoint 2
  app.get("/test2", async (_req, res) => {
    // Call async operation for debugging
    const asyncResult = await processor.asyncOperation();
    const recursiveResult = processor.recursiveFunction(4);

    res.status(200).json({
      message: "test2 endpoint",
      async: asyncResult,
      recursive: recursiveResult,
      timestamp: new Date().toISOString()
    });
  });

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      pid: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      data: {
        count: processor.getData().length,
        processCount: processor.getProcessCount()
      }
    });
  });

  // MCP_TEST_APP_PORT is optional. When unset (or invalid) we fall back to
  // get-port, which scans the configured pool for the first free port. The
  // strict parser rejects "8080garbage" (legacy parseInt accepted it).
  const envPort = parseOptionalPort(process.env.MCP_TEST_APP_PORT);
  const port = envPort ?? await getPort({ port: [3000, 3001, 3002, 3003, 3004] });

  const server = app.listen(port, () => {
    console.log(`HTTP server listening on port ${port}`);
    console.log(`Endpoints available:`);
    console.log(`  GET http://localhost:${port}/test1`);
    console.log(`  GET http://localhost:${port}/test2`);
    console.log(`  GET http://localhost:${port}/health`);
  });

  // Graceful shutdown handlers
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, gracefully shutting down HTTP server');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, gracefully shutting down HTTP server');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });

  process.on('SIGUSR1', () => {
    console.log('\nReceived SIGUSR1 - Node.js debugger automatically enabled');
  });

  console.log("HTTP server is running...");
  console.log("Send SIGUSR1 to enable Node.js debugger");
  console.log("Press Ctrl+C to stop");
}

// Add global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error("Application error:", error);
    process.exit(1);
  });
}

export { DataProcessor, fibonacci, testBreakpointFunction, main };

// Defined at the end of the file (JS function declarations hoist). Keeping it
// here preserves the line numbers of the Express handlers above for any
// integration test that pins breakpoints against this fixture. Accepts only
// clean non-negative integers in [0, 65535]; returns undefined otherwise so
// callers fall back to get-port's pool.
function parseOptionalPort(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) {
    console.warn(`MCP_TEST_APP_PORT='${raw}' is not a non-negative integer; falling back to get-port`);

    return undefined;
  }
  const n = Number.parseInt(raw, 10);

  if (n < 0 || n > 65535) {
    console.warn(`MCP_TEST_APP_PORT=${n} is outside TCP port range 0..65535; falling back to get-port`);

    return undefined;
  }

  return n;
}