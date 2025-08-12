import type { MCPClient } from "./mcp-client";

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
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
    const data = JSON.parse(res.content[0].text) as { hits?: Array<{ message?: string; payload?: { message?: string } }> };
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
    const data = JSON.parse(res.content[0].text) as { hits?: Array<{ message?: string; payload?: { message?: string } }> };
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
    const data = JSON.parse(res.content[0].text) as { events?: Array<{ type?: string }> };
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
    const data = JSON.parse(res.content[0].text);

    return predicate(data);
  }, options);
}
