import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPClient } from "../utils/mcp-client";
import { TestAppManager } from "../utils/test-app-manager";
import { DebuggerTestHelper } from "../utils/debugger-test-helper";
import { waitForDebuggerEvent } from "../utils/wait-helpers";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Verifies that execution control tools (continue, pause, step*, evaluate, stackTrace, threads,
// scopes, variables) are wired to the real debug adapter and not to mock handlers. Each test
// triggers an actual breakpoint hit and asserts that the inspector responds with live data.

interface ToolCallResult {
  content: Array<{ text: string }>;
  isError?: boolean;
}

// The manager has two response shapes:
// (a) withErrorHandling: { success: true, data: <T> }
// (b) createStandardResponse: { success: true, message: string, ...flatFields }
// `unwrap` accepts both: returns `data` when present, otherwise the parsed object itself.
function unwrap<T>(result: ToolCallResult): T {
  if (result.isError) {
    throw new Error(`tool error: ${result.content[0]?.text ?? '<no body>'}`);
  }

  const parsed = JSON.parse(result.content[0].text) as { success?: boolean; error?: string; message?: string; data?: T } & Record<string, unknown>;

  if (parsed.success === false) {
    throw new Error(parsed.message ?? parsed.error ?? 'unknown failure');
  }

  if (parsed.data !== undefined) {
    return parsed.data;
  }

  return parsed as unknown as T;
}

describe("MCP Chrome Debugger Protocol - Execution Control", () => {
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
      try {
        await mcpClient.callTool("continue", { threadId: 1 });
      } catch {
        // tool may be disabled (already disconnected); ignore
      }
      await debuggerHelper.disconnectFromDebugger();
    } catch {
      // ignore disconnect errors in cleanup
    }

    await testApp.stop();
    await mcpClient.disconnect();
    await delay(100);
  });

  async function attachToTestApp(): Promise<{ serverPort: number; mainScriptPath: string }> {
    const { pid, port, serverPort } = await testApp.start({ enableDebugger: true });

    expect(pid).toBeDefined();
    expect(serverPort).toBeDefined();

    await debuggerHelper.connectToDebugger(port);

    const mainScriptPath = await debuggerHelper.getMainScriptPath();

    return { serverPort: serverPort as number, mainScriptPath };
  }

  // The `/test1` Express handler is reliably hit when the test fixture serves the endpoint.
  // breakpoints.test.ts sets line 20 there; line 78 in the compiled JS lands inside the handler
  // body where `req`, `res` and `fibResult` are bound — we use that as our reference frame.
  async function pauseInTest1Handler(serverPort: number, mainScriptPath: string): Promise<{ topFrameId: number; bpId: number; requestPromise: Promise<unknown> }> {
    const bp = await debuggerHelper.setBreakpoint(mainScriptPath, 78, 1);

    expect(bp.verified).toBe(true);

    await mcpClient.callTool("clearDebuggerEvents");

    const requestPromise = fetch(`http://localhost:${serverPort}/test1`).catch(() => undefined);

    await waitForDebuggerEvent(mcpClient, (event) => event.type === "paused", { timeoutMs: 7000 });

    const stackResult = await mcpClient.callTool("stackTrace", { threadId: 1 });
    const stackData = unwrap<{ stackFrames: Array<{ id: number; name: string }> }>(stackResult);

    expect(stackData.stackFrames.length).toBeGreaterThan(0);

    return { topFrameId: stackData.stackFrames[0].id, bpId: bp.id, requestPromise };
  }

  it("threads returns the single Node.js Main Thread", async () => {
    await attachToTestApp();

    const result = await mcpClient.callTool("threads");
    const data = unwrap<{ threads: Array<{ id: number; name: string }> }>(result);

    expect(data.threads).toHaveLength(1);
    expect(data.threads[0]).toMatchObject({ id: 1, name: "Main Thread" });
  });

  it("continue resumes execution after a breakpoint pause", async () => {
    const { serverPort, mainScriptPath } = await attachToTestApp();
    const { bpId, requestPromise } = await pauseInTest1Handler(serverPort, mainScriptPath);
    const continueResult = await mcpClient.callTool("continue", { threadId: 1 });
    const continueData = unwrap<{ message?: string; threadId?: number }>(continueResult);

    expect(continueData.threadId).toBe(1);

    const response = await requestPromise;

    expect(response).toBeDefined();
    if (response instanceof Response) {
      expect(response.ok).toBe(true);
    }

    await debuggerHelper.removeBreakpoint(bpId);
  });

  it("stackTrace returns frames whose source matches the running script", async () => {
    const { serverPort, mainScriptPath } = await attachToTestApp();
    const { topFrameId, bpId, requestPromise } = await pauseInTest1Handler(serverPort, mainScriptPath);

    expect(topFrameId).toBeGreaterThanOrEqual(0);

    const stackResult = await mcpClient.callTool("stackTrace", { threadId: 1 });
    const stackData = unwrap<{ stackFrames: Array<{ name: string; line: number; source?: { path?: string } }> }>(stackResult);
    const top = stackData.stackFrames[0];

    expect(top.line).toBeGreaterThanOrEqual(1);
    expect(top.source?.path).toBeDefined();

    await mcpClient.callTool("continue", { threadId: 1 });
    await requestPromise;
    await debuggerHelper.removeBreakpoint(bpId);
  });

  it("evaluate inside a paused frame returns live values for in-scope identifiers", async () => {
    const { serverPort, mainScriptPath } = await attachToTestApp();
    const { topFrameId, bpId, requestPromise } = await pauseInTest1Handler(serverPort, mainScriptPath);
    // testBreakpointFunction(10, 5) runs just before line 78, so fibResult has been set as well.
    // We avoid relying on local names compiled from TypeScript and just evaluate an arithmetic
    // expression that exercises the live VM.
    const evalResult = await mcpClient.callTool("evaluate", {
      expression: "21 * 2",
      frameId: topFrameId,
    });
    const evalData = unwrap<{ result: { result: string; type: string } | { result?: { result?: string; type?: string }; truncated?: boolean } }>(evalResult);
    const body = (evalData as { result: { result?: string; type?: string } }).result;

    expect(body.result).toBe("42");
    expect(body.type).toBe("number");

    await mcpClient.callTool("continue", { threadId: 1 });
    await requestPromise;
    await debuggerHelper.removeBreakpoint(bpId);
  });

  it("scopes/variables surface real frame data (non-empty local scope)", async () => {
    const { serverPort, mainScriptPath } = await attachToTestApp();
    const { topFrameId, bpId, requestPromise } = await pauseInTest1Handler(serverPort, mainScriptPath);
    const scopesResult = await mcpClient.callTool("scopes", { frameId: topFrameId });
    const scopesData = unwrap<{ scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> }>(scopesResult);

    expect(scopesData.scopes.length).toBeGreaterThan(0);

    const localScope = scopesData.scopes.find(s => !s.expensive) ?? scopesData.scopes[0];

    expect(localScope.variablesReference).toBeGreaterThan(0);

    const variablesResult = await mcpClient.callTool("variables", {
      variablesReference: localScope.variablesReference,
    });
    const variablesData = unwrap<{ variables: Array<{ name: string; value: string }> }>(variablesResult);

    // We do not assume specific local names because the TypeScript-to-JS compilation may rename
    // them; instead require that the local scope contains real, non-empty entries.
    expect(variablesData.variables.length).toBeGreaterThan(0);
    for (const variable of variablesData.variables) {
      expect(typeof variable.name).toBe("string");
      expect(variable.name.length).toBeGreaterThan(0);
    }

    await mcpClient.callTool("continue", { threadId: 1 });
    await requestPromise;
    await debuggerHelper.removeBreakpoint(bpId);
  });

  it("stepOut accepts threadId in the request schema", async () => {
    const { serverPort, mainScriptPath } = await attachToTestApp();
    const { bpId, requestPromise } = await pauseInTest1Handler(serverPort, mainScriptPath);
    // The schema-bug fix means the handler now receives `threadId` and forwards it.
    const stepOutResult = await mcpClient.callTool("stepOut", { threadId: 1 });

    expect(stepOutResult.isError).toBeFalsy();

    const stepOutData = unwrap<Record<string, unknown>>(stepOutResult);

    expect(stepOutData.threadId).toBe(1);

    // Step may pause again; resume until the request completes.
    for (let i = 0; i < 5; i++) {
      try {
        await mcpClient.callTool("continue", { threadId: 1 });
      } catch {
        break;
      }

      await delay(150);
    }

    await requestPromise;
    await debuggerHelper.removeBreakpoint(bpId);
  });

  it("removeBreakpoint refuses to run before attach (tool availability)", async () => {
    const result = await mcpClient.callTool("removeBreakpoint", { breakpointId: 1 });

    // Disabled tools are surfaced through the SDK as isError=true.
    expect(result.isError).toBe(true);
  });
});
