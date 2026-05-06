import type { MCPClient } from "./mcp-client";

export interface WaitOptions {
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
}

// All MCP tools backed by withErrorHandling return { success: true, data: <T> }. A handful of
// non-manager tools (e.g. getDebuggerState assembled inline in mcp-server.ts) still respond with
// flat objects. unwrapToolPayload accepts both: it returns parsed.data when present, otherwise
// the parsed object itself, so callers can rely on a single shape.
export function unwrapToolPayload<T = unknown>(result: { content: Array<{ text: string }>; isError?: boolean | undefined }): T {
  if (result.isError) {
    throw new Error(`tool error: ${result.content[0]?.text ?? '<no body>'}`);
  }

  const parsed = JSON.parse(result.content[0]!.text) as { success?: boolean; error?: string; message?: string; data?: T } & Record<string, unknown>;

  if (parsed.success === false) {
    throw new Error(parsed.message ?? parsed.error ?? 'unknown failure');
  }

  if (parsed.data !== undefined) {
    return parsed.data;
  }

  return parsed as unknown as T;
}

async function waitFor(predicate: () => Promise<boolean>, { timeoutMs = 5000, intervalMs = 100 }: WaitOptions = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;


  for (;;) {
    if (await predicate()) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error("waitFor: timeout exceeded");
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function waitForLogpoint(
  client: MCPClient,
  filter: (hit: { message?: string; payload?: { message?: string } }) => boolean,
  options?: WaitOptions,
): Promise<void> {
  await waitFor(async () => {
    const res = await client.callTool("getLogpointHits");
    const data = unwrapToolPayload<{ hits?: Array<{ message?: string; payload?: { message?: string } }> }>(res);
    const hits = Array.isArray(data.hits) ? data.hits : [];

    return hits.some(filter);
  }, options);
}

export async function waitForLogpointCount(
  client: MCPClient,
  filter: (hit: { message?: string; payload?: { message?: string } }) => boolean,
  minCount: number,
  options?: WaitOptions,
): Promise<void> {
  await waitFor(async () => {
    const res = await client.callTool("getLogpointHits");
    const data = unwrapToolPayload<{ hits?: Array<{ message?: string; payload?: { message?: string } }> }>(res);
    const hits = Array.isArray(data.hits) ? data.hits : [];
    const count = hits.filter(filter).length;

    return count >= minCount;
  }, options);
}

export async function waitForDebuggerEvent(
  client: MCPClient,
  predicate: (event: { type?: string }) => boolean,
  options?: WaitOptions,
): Promise<void> {
  await waitFor(async () => {
    const res = await client.callTool("getDebuggerEvents");
    const data = unwrapToolPayload<{ events?: Array<{ type?: string }> }>(res);
    const events = Array.isArray(data.events) ? data.events : [];

    return events.some(predicate);
  }, options);
}

export async function waitForDebuggerState(
  client: MCPClient,
  predicate: (state: unknown) => boolean,
  options?: WaitOptions,
): Promise<void> {
  await waitFor(async () => {
    const res = await client.callTool("getDebuggerState");
    const data = unwrapToolPayload(res);

    return predicate(data);
  }, options);
}
