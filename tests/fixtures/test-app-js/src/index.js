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

    let sum = 0;
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
  app.get("/test1", (req, res) => {
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
  app.get("/test2", async (req, res) => {
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
  app.get("/health", (req, res) => {
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

  // Get port from environment variable or use get-port to find available port
  const { MCP_TEST_APP_PORT } = process.env;
  const envPort = MCP_TEST_APP_PORT ? parseInt(MCP_TEST_APP_PORT, 10) : undefined;
  const port = envPort && !isNaN(envPort) ? envPort : await getPort({ port: [3000, 3001, 3002, 3003, 3004] });

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