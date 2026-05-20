import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPClient } from "../utils/mcp-client";
import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import { unwrapToolPayload, waitForLogpoint } from "../utils/wait-helpers";
import path from "node:path";

describe("MCP Chrome Debugger Protocol - TS Logpoint Check", () => {
  let mcpClient: MCPClient;
  let testApp: TestAppManager;
  let debuggerHelper: DebuggerTestHelper;
  let serverPort: number;
  const serverPath = path.resolve(__dirname, "../../dist/index.js");
  const tsSourcePath = path.resolve(__dirname, "../fixtures/test-app/src/index.ts");

  beforeEach(async () => {
    mcpClient = new MCPClient(serverPath);
    testApp = new TestAppManager();
    debuggerHelper = new DebuggerTestHelper(mcpClient, testApp);

    await mcpClient.connect();

    const { pid, port, serverPort: appServerPort } = await testApp.start({ enableDebugger: true });

    expect(pid).toBeDefined();
    expect(port).toBeDefined();
    expect(appServerPort).toBeDefined();
    serverPort = appServerPort!;

    await debuggerHelper.connectToDebugger(port);
  });

  afterEach(async () => {
    try {
      await debuggerHelper.disconnectFromDebugger();
    } catch { void 0; }

    await testApp.stop();
    await mcpClient.disconnect();
  });

  it("captures fib/sum logpoint with interpolated vars at index.ts:96", async () => {
    await mcpClient.callTool("clearLogpointHits");

    const setA = await mcpClient.callTool("setBreakpoints", {
      source: { path: tsSourcePath },
      breakpoints: [
        { line: 96, column: 1, logMessage: "fib={fibResult} sum={breakpointResult}" },
      ],
    });
    const setAData = unwrapToolPayload<{ breakpoints: Array<{ verified: boolean }> }>(setA);
    const lpA = setAData.breakpoints[0]!;

    expect(lpA).toBeDefined();
    expect(lpA.verified).toBe(true);

    const respA = await fetch(`http://localhost:${serverPort}/test1`);

    expect(respA.ok).toBe(true);
    await waitForLogpoint(mcpClient, (hit) =>
      (hit.payload?.message ?? hit.message ?? "").includes("fib=5") &&
      (hit.payload?.message ?? hit.message ?? "").includes("sum=15"),
    );

    const hitsA = await mcpClient.callTool("getLogpointHits");
    const hitsAData = unwrapToolPayload<{ hits: Array<{ payload?: { message?: string; vars?: Record<string, unknown> } }>; totalCount: number }>(hitsA);

    expect(hitsAData.totalCount).toBeGreaterThan(0);

    const payloadA = hitsAData.hits[0]?.payload;
    const msgA: string | undefined = payloadA?.message;

    expect(msgA).toBeDefined();
    expect(msgA).toContain("fib=5");
    expect(msgA).toContain("sum=15");
    expect(payloadA?.vars).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(payloadA?.vars ?? {}, 'fibResult')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payloadA?.vars ?? {}, 'breakpointResult')).toBe(true);
  }, 60000);

  it("captures method-call logpoint with vars at index.ts:92", async () => {
    await mcpClient.callTool("clearLogpointHits");

    const setB = await mcpClient.callTool("setBreakpoints", {
      source: { path: tsSourcePath },
      breakpoints: [
        { line: 92, column: 1, logMessage: "count={processor.getProcessCount()}" },
      ],
    });
    const setBData = unwrapToolPayload<{ breakpoints: Array<{ verified: boolean }> }>(setB);
    const lpB = setBData.breakpoints[0]!;

    expect(lpB).toBeDefined();
    expect(lpB.verified).toBe(true);

    const respB = await fetch(`http://localhost:${serverPort}/test1`);

    expect(respB.ok).toBe(true);
    await waitForLogpoint(mcpClient, (hit) =>
      /count=\d+/.test(hit.payload?.message ?? hit.message ?? ""),
    );

    const hitsB = await mcpClient.callTool("getLogpointHits");
    const hitsBData = unwrapToolPayload<{ hits: Array<{ payload?: { message?: string; vars?: Record<string, unknown> } }>; totalCount: number }>(hitsB);

    expect(hitsBData.totalCount).toBeGreaterThan(0);

    const payloadB = hitsBData.hits[0]?.payload;
    const msgB: string | undefined = payloadB?.message;

    expect(msgB).toBeDefined();
    expect(msgB).toMatch(/count=\d+/);
    expect(Object.prototype.hasOwnProperty.call(payloadB?.vars ?? {}, 'processor.getProcessCount()')).toBe(true);
  }, 60000);

  it("resolves generated position for src/index.ts via originalSourcePath fallback", async () => {
    const mapRes = await mcpClient.callTool("resolveGeneratedPosition", {
      originalSource: "src/index.ts",
      originalSourcePath: tsSourcePath,
      originalLine: 96,
      originalColumn: 1,
    });
    // resolveGeneratedPosition path is not wrapped in withErrorHandling; it returns its own
    // {success, ...} envelope as content text, so we parse it directly.
    const mapResData = JSON.parse(mapRes.content[0]!.text) as { success: boolean; sourceMapUsed?: string };

    expect(mapResData.success).toBe(true);
    expect(mapResData.sourceMapUsed).toContain("index.js.map");
  }, 60000);
});
