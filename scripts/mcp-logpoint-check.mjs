import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function startTestApp() {
  const appPath = resolve(__dirname, '../tests/fixtures/test-app/dist/index.js');
  const child = spawn('node', ['--inspect', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => process.stdout.write(`[test-app] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[test-app] ${d}`));

  // Give the server a moment to start
  await delay(1500);
  return child;
}

async function startMcpClient() {
  const serverPath = resolve(__dirname, '../dist/index.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
  });

  const client = new Client(
    { name: 'local-check', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  return { client, transport };
}

async function main() {
  console.log('=== MCP tool + logpoint check ===');

  // Ensure project is built beforehand (use npm run build)

  // 1) Start test app with inspector
  const app = await startTestApp();

  try {
    // 2) Connect to MCP server
    const { client, transport } = await startMcpClient();

    try {
      // 3) List tools
      const toolsResp = await client.listTools();
      const tools = toolsResp.tools.map((t) => ({ name: t.name, title: t.title }));
      console.log('\nAvailable tools:');
      for (const t of tools) console.log(`- ${t.name}${t.title ? `: ${t.title}` : ''}`);

      // 4) Attach to default debugger (9229)
      const attach = await client.callTool({ name: 'attach', arguments: {} });
      console.log('\nattach:', attach.content?.[0]?.text ?? 'ok');

      // Helper to trigger /test1
      async function triggerTest1() {
        console.log('\nTriggering /test1 to hit logpoint...');
        const ports = [3000, 3001, 3002, 3003, 3004];
        for (const p of ports) {
          try {
            const curl = spawn('bash', ['-lc', `curl -sSf http://localhost:${p}/test1 >/dev/null`]);
            const code = await new Promise((res) => curl.on('exit', res));
            if (code === 0) return true;
          } catch {}
        }
        return false;
      }

      const tsPath = resolve(__dirname, '../tests/fixtures/test-app/src/index.ts');

      // Scenario A (Variant C: set on TS directly; no manual map paths)
      console.log('\n=== Scenario A (TS line 96): fib/sum ===');
      const lineA = 96;
      const msgA = 'fib={fibResult} sum={breakpointResult}';
      const reqA_set = { name: 'setBreakpoints', arguments: { source: { path: tsPath }, breakpoints: [{ line: lineA, column: 1, logMessage: msgA }] } };
      console.log('request:', JSON.stringify(reqA_set));
      const resA_set = await client.callTool(reqA_set);
      console.log('response:', resA_set.content?.[0]?.text);
      const resA_list = await client.callTool({ name: 'getBreakpoints', arguments: {} });
      console.log('getBreakpoints:', resA_list.content?.[0]?.text);
      await client.callTool({ name: 'clearLogpointHits', arguments: {} });
      await triggerTest1();
      await delay(600);
      const resA_hits = await client.callTool({ name: 'getLogpointHits', arguments: {} });
      console.log('getLogpointHits:', resA_hits.content?.[0]?.text);

      // Scenario B (Variant C)
      console.log('\n=== Scenario B (TS line 92): count ===');
      const lineB = 92;
      const msgB = 'count={processor.getProcessCount()}';
      const reqB_set = { name: 'setBreakpoints', arguments: { source: { path: tsPath }, breakpoints: [{ line: lineB, column: 1, logMessage: msgB }] } };
      console.log('request:', JSON.stringify(reqB_set));
      const resB_set = await client.callTool(reqB_set);
      console.log('response:', resB_set.content?.[0]?.text);
      const resB_list = await client.callTool({ name: 'getBreakpoints', arguments: {} });
      console.log('getBreakpoints:', resB_list.content?.[0]?.text);
      await client.callTool({ name: 'clearLogpointHits', arguments: {} });
      await triggerTest1();
      await delay(600);
      const resB_hits = await client.callTool({ name: 'getLogpointHits', arguments: {} });
      console.log('getLogpointHits:', resB_hits.content?.[0]?.text);

      // Scenario C: scan nearby lines for a working fib/sum logpoint (Variant C)
      console.log('\n=== Scenario C (TS scan around line 96): fib/sum ===');
      const scanLines = [96,95,97,94,98,93,99,92,100,91,101,90,102];
      let foundLine = null;
      for (const ln of scanLines) {
        const reqSet = { name: 'setBreakpoints', arguments: { source: { path: tsPath }, breakpoints: [{ line: ln, column: 1, logMessage: msgA }] } };
        console.log('request:', JSON.stringify(reqSet));
        const resSet = await client.callTool(reqSet);
        console.log('response:', resSet.content?.[0]?.text);
        await client.callTool({ name: 'clearLogpointHits', arguments: {} });
        await triggerTest1();
        await delay(600);
        const resHits = await client.callTool({ name: 'getLogpointHits', arguments: {} });
        console.log('getLogpointHits:', resHits.content?.[0]?.text);
        try {
          const parsed = JSON.parse(resHits.content?.[0]?.text ?? '{}');
          if (parsed.totalCount && parsed.totalCount > 0) { foundLine = ln; break; }
        } catch {}
      }
      if (foundLine) {
        console.log(`Found working TS line for fib/sum: ${foundLine}`);
      } else {
        console.warn('No working TS line found for fib/sum in scan range');
      }

      // Fallback B demo (optional): explicit resolver without sourceMapPaths using originalSourcePath
      // This should auto-discover maps via project root and build dirs
      const reqFallback = { name: 'resolveGeneratedPosition', arguments: { originalSource: 'src/index.ts', originalSourcePath: tsPath, originalLine: lineA, originalColumn: 1 } };
      console.log('\nFallback B request:', JSON.stringify(reqFallback));
      const resFallback = await client.callTool(reqFallback);
      console.log('Fallback B response:', resFallback.content?.[0]?.text);

      // 8) Also fetch debugger events
      const events = await client.callTool({ name: 'getDebuggerEvents', arguments: {} });
      console.log('\ngetDebuggerEvents:', events.content?.[0]?.text ?? 'no content');

      // 9) Cleanup
      await client.close();
      await transport.close();
    } finally {
      // nothing else
    }
  } finally {
    // Stop test app
    try {
      if (app && !app.killed) {
        app.kill('SIGTERM');
      }
    } catch {}

    // Small grace period for the process to exit and release ports
    await delay(500);

    // Ensure the process is gone; if not, force kill
    try {
      // On POSIX, sending signal 0 throws if process does not exist
      if (app && app.pid) {
        process.kill(app.pid, 0);
        // If we get here, process may still be alive, try SIGKILL
        try { app.kill('SIGKILL'); } catch {}
      }
    } catch {
      // process already exited
    }

    // Verify that Node inspector port 9229 is free again
    const isPortOpen = (port, host = '127.0.0.1', timeoutMs = 400) => new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch {}
        resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      try {
        socket.connect(port, host);
      } catch {
        finish(false);
      }
    });

    const open = await isPortOpen(9229);
    if (open) {
      console.warn('Inspector port 9229 is still in use after shutdown');
    } else {
      console.log('Inspector port 9229 is free');
    }
  }
}

main().catch((e) => {
  console.error('Check failed:', e);
  process.exit(1);
});
