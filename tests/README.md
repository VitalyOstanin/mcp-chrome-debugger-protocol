# MCP Chrome Debugger Protocol - Test Suite

This directory contains integration tests for the MCP Chrome Debugger Protocol server. The tests are built using [vitest](https://vitest.dev/) and exercise the server end-to-end as a real MCP client driving a real Node.js inspector debuggee.

## Test Pyramid

Three layers, each with its own scope:

| Layer       | Location                            | Runner                                                       | Scope                                                                                                                  |
|-------------|-------------------------------------|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| Unit        | `src/**/*.test.ts`                  | `npm test` -> `vitest.config.ts`                             | Pure functions and small modules. No I/O, no debuggee. `maxWorkers: '10%'`, fast feedback.                             |
| Integration | `tests/integration/**`              | `npm run test:integration` -> `vitest.integration.config.ts` | Cross-module wiring. In practice every file here is end-to-end (spawns a debuggee fixture and binds inspector ports).  |
| End-to-end  | `tests/integration/**` (same files) | same as integration                                          | Full MCP client -> server -> Node.js inspector debuggee. `maxWorkers: 1`, `fileParallelism: false`, `testTimeout: 60_000`. |

> Heuristic for new tests: if the test does not need a real debuggee, put it in `src/**/*.test.ts` next to the module it covers. Anything that spawns a Node.js debuggee or binds an inspector port belongs in `tests/integration/`.

## Test Architecture

### Test Structure
```
tests/
├── fixtures/
│   └── test-app/           # TypeScript test application (compiled per run)
├── utils/                  # Test utilities and helpers
├── integration/            # Integration test suites
├── globalSetup.ts          # Pre-suite build + post-suite debuggee teardown
├── setup.ts                # Per-file setup
└── README.md               # This file
```

### Test Components

1. **Test Application** (`fixtures/test-app/`)
   - TypeScript application that compiles to JavaScript with source maps.
   - Includes SIGUSR2 signal handler used in stepping/pause scenarios.
   - Contains a variety of code patterns (classes, async, loops, recursion) to drive debugging.

2. **MCP Client** (`utils/mcp-client.ts`)
   - Implements an MCP client using `@modelcontextprotocol/sdk`.
   - Communicates with the debugger server via stdio.
   - Manages the server child process lifecycle.

3. **Test App Manager** (`utils/test-app-manager.ts`)
   - Spawns and manages debuggee processes.
   - Allocates free debugger ports via `get-port`.
   - Supports both pre-enabled debugging (`--inspect`) and runtime debugging via SIGUSR1.

4. **Debugger Test Helper** (`utils/debugger-test-helper.ts`)
   - High-level wrapper around MCP debugger tools.
   - Provides convenience methods for common operations (attach, set breakpoints, evaluate, ...).
   - Handles cleanup and best-effort error swallowing in teardown.

## Test Suites

Files live under `tests/integration/`. Current suites:

- `basic-state-switching.test.ts` — tool availability transitions across attach/disconnect.
- `breakpoints.test.ts` — `setBreakpoints`, `removeBreakpoint`, conditional breakpoints, logpoints.
- `claude-code-behavior.test.ts` — scenarios that mirror the way Claude Code drives the server.
- `claude-code-workaround.test.ts` — regressions around Claude Code-specific quirks.
- `connection.test.ts` — `attach` (URL / processId), `disconnect`, reconnection, error handling.
- `dynamic-tools-behavior.test.ts` — runtime tool registration/unregistration behaviour.
- `execution-control.test.ts` — `pause`, `continue`, `next`, `stepIn`, `stepOut` and combinations.
- `http-server.test.ts` — debugging an HTTP server fixture.
- `javascript-app.test.ts` — debugging a plain JS (non-TS) fixture.
- `logpoint-check.test.ts` — logpoint round-trip and escaping.
- `mcp-events.test.ts` — MCP notification/event emission.
- `source-map-resolution.test.ts` — TS↔JS source-map resolution and caching.
- `tool-state.test.ts` — fine-grained tool enable/disable state machine.

## Running Tests

### Prerequisites
```bash
# Install dependencies
npm ci

# Build the main project (the global setup also does this, but doing it
# yourself catches type errors before vitest spins up).
npm run build
```

### Test Execution
```bash
# Unit tests (fast, src/*.test.ts)
npm test

# Integration tests (real Node.js inspector debuggee, slower)
npm run test:integration

# Both, sequentially
npm run test:all

# Watch mode (integration)
npm run test:integration:watch

# Run a specific file
npm run test:integration -- tests/integration/connection.test.ts

# Run by test-name pattern
npm run test:integration -- -t "should attach"

# Verbose reporter
npm run test:integration -- --reporter=verbose

# Coverage (integration only)
npm run test:integration -- --coverage
```

### Test Configuration

Two vitest configs live at the repo root:

- `vitest.config.ts` — unit tests next to source (`src/**/*.test.ts`). `maxWorkers: '10%'`.
- `vitest.integration.config.ts` — integration tests under `tests/integration/`. `maxWorkers: 1`, `fileParallelism: false`, `testTimeout: 60_000`, `hookTimeout: 60_000`. Uses `tests/globalSetup.ts` to build the project and the test fixture once per run, and to terminate any tracked debuggee PIDs after the suite.

The resource limits are intentional — real debuggee processes bind to network ports and a single hung step can tie up the whole worker. Do not raise them without a strong reason and explicit user sign-off.

## Key Features

### Port Management
- `get-port` allocates a free port per test to avoid collisions.
- Supports both pre-allocated (`--inspect=<port>`) and runtime (SIGUSR1) port assignment.

### Process Management
- Per-test process lifecycle with cleanup in `afterEach`.
- Signal handling — SIGUSR1 enables the inspector at runtime, SIGUSR2 is exercised by fixture handlers.
- `globalSetup.ts` teardown sends SIGTERM, waits a short grace window, probes liveness via `process.kill(pid, 0)`, then escalates to SIGKILL only if the debuggee is still alive.

### Source Map Support
- The TS fixture compiles to JS with inline source maps.
- Tests verify that breakpoints and stack frames resolve to original TypeScript locations.

### Error Resilience
- `afterEach` hooks swallow disconnect errors so a failing test does not poison the next one.
- Test app spawning is idempotent — leftover processes are killed in `globalSetup` teardown.

## Test Data and Scenarios

The TS fixture (`fixtures/test-app/src/index.ts`) includes:
- Class methods (DataProcessor and friends).
- Async operations with `setTimeout`/promises.
- Recursive functions (fibonacci, factorial).
- Loops and iteration over arrays.
- SIGUSR1/SIGUSR2 handlers.
- `console.log` statements that drive logpoint tests.
- Code paths that throw, for exception breakpoint testing.

## Debugging the Tests

To debug a failing test:

1. **Run the single file with verbose reporter**:
   ```bash
   npm run test:integration -- tests/integration/connection.test.ts --reporter=verbose
   ```

2. **Run a single test by name**:
   ```bash
   npm run test:integration -- -t "should connect to debugger via WebSocket URL"
   ```

3. **Inspect the test fixture directly**:
   ```bash
   cd tests/fixtures/test-app
   npm run build
   node --inspect dist/index.js
   ```

4. **Run the MCP server manually** (for ad-hoc client experiments):
   ```bash
   npm run build
   node dist/index.js
   ```

5. **Verbose debug-adapter output**: set `DAP_VERBOSE=1` in the environment to surface diagnostic `OutputEvent`s from the in-process DAP adapter.

## Contributing

When adding new tests:
1. Follow the existing structure and naming conventions (`*.test.ts`).
2. Use the helper utilities (`utils/`) for common operations rather than reaching for raw MCP calls.
3. Always clean up in `afterEach` — disconnect the debugger and stop the test app.
4. Keep timeouts realistic. The default 60 s is generous; if a test needs more, that's a signal something is wrong.
5. Test both success and error paths.
6. If you add a new utility or a non-obvious pattern, document it here.

## Troubleshooting

### Common Issues

1. **Port conflicts** — tests allocate ports dynamically, but stray manual `node --inspect` processes can still collide. `pkill -f 'node --inspect'` clears them.
2. **Process cleanup** — if a suite is interrupted (Ctrl-C), debuggee processes may linger. The next `npm run test:integration` will clean them up via `globalSetup` teardown, but a manual sweep doesn't hurt.
3. **Build issues** — the global setup builds the main project and the fixture. If either fails, vitest aborts before any test runs; check the build output, not the test output.
4. **Timeouts** — most timeouts indicate a real bug (the debuggee never paused, a breakpoint never resolved). Don't bump the timeout reflexively.
5. **Permission errors** — sending signals to spawned processes requires the same uid; running tests under a sandbox that blocks `kill` will fail.

### Performance Considerations

- Integration tests run serially (`fileParallelism: false`, `maxWorkers: 1`).
- Each test spawns a fresh debuggee for isolation.
- The fixture build is cached between runs — only the first `globalSetup` invocation pays the full cost.
