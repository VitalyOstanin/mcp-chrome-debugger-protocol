import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests spawn real Node.js inspector debuggee processes and bind
    // to network ports; running suites in parallel risks port collisions and
    // cross-suite debuggee state leaking between tests. Force serial execution.
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    // Coverage for the integration suite is collected externally via
    // `NODE_V8_COVERAGE=...` + `c8 report`, not via vitest's own coverage
    // hook. The interesting code (DAP client, MCP server, debug adapter,
    // debugger manager, CDP transport) runs in spawned child processes
    // (`dist/index.js` and the test-app debuggee), and vitest's coverage
    // only instruments its own worker, which would silently miss them.
    // See `.github/workflows/node.js.yml` for how the JSON dumps are
    // merged and source-map-remapped back to `src/*.ts`.
  },
});
