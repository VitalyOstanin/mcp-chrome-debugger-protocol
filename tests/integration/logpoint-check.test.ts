import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPClient } from "../utils/mcp-client";
import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import { unwrapToolPayload, waitForLogpoint } from "../utils/wait-helpers";
import path from "path";

describe("MCP Chrome Debugger Protocol - TS Logpoint Check", () => {
  let mcpClient: MCPClient;
  let testApp: TestAppManager;
  let debuggerHelper: DebuggerTestHelper;
  const serverPath = path.resolve(__dirname, "../../dist/index.js");

  beforeEach(async () => {
    mcpClient = new MCPClient(serverPath);
    testApp = new TestAppManager();
    debuggerHelper = new DebuggerTestHelper(mcpClient, testApp);

    await mcpClient.connect();
  });

  afterEach(async () => {
    try {
      await debuggerHelper.disconnectFromDebugger();
    } catch { void 0; }

    await testApp.stop();
    await mcpClient.disconnect();
  });

  it("should set TS logpoints and capture interpolated output (fib/sum and count)", async () => {
    const { pid, port, serverPort } = await testApp.start({ enableDebugger: true });

    expect(pid).toBeDefined();
    expect(port).toBeDefined();
    expect(serverPort).toBeDefined();

    await debuggerHelper.connectToDebugger(port);

    // Use absolute path to TS source (Variant C - TS-first)
    const tsSourcePath = path.resolve(__dirname, "../fixtures/test-app/src/index.ts");

    // Scenario A: fib/sum
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
    // Also ensure vars include both expressions
    expect(payloadA?.vars).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(payloadA?.vars ?? {}, 'fibResult')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payloadA?.vars ?? {}, 'breakpointResult')).toBe(true);

    // Scenario B: count
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
    // Vars should include the expression key used
    expect(Object.prototype.hasOwnProperty.call(payloadB?.vars ?? {}, 'processor.getProcessCount()')).toBe(true);

    // Optional: Fallback B mapping without sourceMapPaths using originalSourcePath
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
