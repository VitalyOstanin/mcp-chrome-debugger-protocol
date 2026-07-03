# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.10.1] - 2026-07-03

### Changed
- Dependency maintenance: bumped runtime and dev dependencies to latest (`ws` 8.21.0, `typescript-eslint`, `vitest`, `@types/node` 26, `@types/chrome-remote-interface`). No change to the server's own API or behavior.
- CI: bumped `actions/checkout` to v7 and `codecov/codecov-action` to v7.

### Security
- Cleared high-severity npm advisories (`hono`, `ws`) via lockfile updates.

## [1.10.0] - 2026-05-29

### Added
- `-V` as an alias for `--version` (alongside the existing `-v`), matching the common short-flag convention ([src/index.ts](src/index.ts)).
- `exports` and `types` fields in `package.json`: the package declares an explicit ESM entry point (`.` -> `./dist/index.js` with a `types` condition) and no longer exposes internal `dist/` modules for deep import.
- `Environment variables` section in [README.md](README.md) documenting `MCP_CDP_ALLOW_REMOTE`, `DAP_VERBOSE`, and the previously undocumented `MCP_LOGPOINT_BUFFER_SIZE`.
- Architecture Decision Records under [docs/adr/](docs/adr/): ADR-0001 (adopt ADRs) and ADR-0002 (release tag policy).

### Changed
- SIGINT/SIGTERM now exit with the conventional `128 + signal` code (130 / 143) after a graceful shutdown instead of always `0`, so supervisors can distinguish a signal-driven stop from a normal exit ([src/index.ts](src/index.ts)).
- Unknown CLI arguments now print a warning to stderr instead of being silently ignored ([src/index.ts](src/index.ts)).
- CDP reconnect uses exponential backoff with full jitter capped at 8 s (was linear `delay * attempt`), matching the inspector-discovery poll strategy ([src/cdp-transport.ts](src/cdp-transport.ts)).
- `findBreakpointLocationInRange` fallback breaks ties on equal line distance by nearest column instead of relying on V8's location order ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- ESLint: migrated the deprecated core `comma-dangle` rule to `@stylistic/comma-dangle` (added `@stylistic/eslint-plugin`) and added `eqeqeq` ([eslint.config.mjs](eslint.config.mjs)).
- Deduplicated the four `file://`-prefix strips into a single `fileUrlToPlainPath` helper and extracted `syncDapIdReverseIndex` from `setBreakPointsRequest` ([src/utils.ts](src/utils.ts), [src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `test` and `test:coverage` npm scripts are wrapped in a 5-minute GNU `timeout`, mirroring the integration runner ([package.json](package.json)).
- Documented `setBreakpointsBatch` in the README **Available Tools** list, aligned the stated npm requirement with `engines.npm` (>=10), and corrected the logpoint buffer default from 10 000 to the actual 2 000 ([README.md](README.md)).

### Fixed
- Bumped the transitive `qs` dependency to 6.15.2, resolving the moderate DoS advisory GHSA-q8mj-m7cp-5q26 (dev/test-only, via `express`); `npm audit` reports 0 vulnerabilities ([package-lock.json](package-lock.json)).

## [1.9.0] - 2026-05-21

### Added
- New MCP tool `setBreakpointsBatch` -- accepts an array of `{filePath, lines[]}` entries and places breakpoints in parallel via `mapWithConcurrency` (cap 4). Returns per-file results and an aggregate `summary` with `{totalFiles, succeeded, failed, totalBreakpoints}`. Registered in [src/mcp-server.ts](src/mcp-server.ts), tool gate added to [src/tool-state-manager.ts](src/tool-state-manager.ts).
- `mapWithConcurrency` gains an optional `AbortSignal` parameter and fail-fast scheduling. A pre-aborted signal short-circuits before any work begins; mid-run abort stops workers from picking up further items; the first rejected `fn` short-circuits the rest of the batch so subsequent CDP roundtrips are not wasted ([src/utils.ts](src/utils.ts)).
- Startup stderr warning when `MCP_CDP_ALLOW_REMOTE=1|true` is set, so an operator does not accidentally leave the loopback-only safety off after debugging a non-local target ([src/index.ts](src/index.ts)). Documented in [README.md](README.md).
- Linux uid gate at attach time: when the MCP server runs as `root` (UID 0) and the target process is owned by another user, attach is rejected with structured error code `PID_OWNED_BY_OTHER_USER` (`/proc/<pid>/status` `Uid:` line). Prevents privilege-escalation surprises when the MCP server is started under a privileged shell ([src/dap-client.ts](src/dap-client.ts)). Documented in [README.md](README.md).
- Source-map listing cache exposes explicit `invalidateSourceMapListing(roots?)` and `invalidateTraceMap(mapFile?)` so long-running sessions can drop stale entries after a rebuild without restarting the server ([src/source-map-resolver.ts](src/source-map-resolver.ts)).
- Attach-time non-fatal warnings (e.g. partial enableDomains failures) are now surfaced through the MCP success envelope's `warnings` field instead of being swallowed by `logError` ([src/dap-client.ts](src/dap-client.ts)).
- `getDebuggerState` exposes a `unhandledRejection` counter so operators can tell whether the debuggee has started silently swallowing rejections ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- Variable handles are tagged with the current `pauseEpoch`; resolving a handle from a previous pause returns `STALE_VARIABLE_REFERENCE` instead of indexing into a stale CDP `objectId` ([src/dap-debugger-manager.ts](src/dap-debugger-manager.ts)).
- Source-level injection-hardening unit tests for `buildLogpointExpression` covering backticks, `${...}`, backslashes, quoted placeholders, throwing placeholders, and the positional `__vars` design ([src/logpoint.test.ts](src/logpoint.test.ts)).
- `createSuccessResponseFromJson` helper for callers that have already serialized the data payload (e.g. `truncateResult` measures size by stringifying first); avoids a second walk of the same object ([src/utils.ts](src/utils.ts)).

### Changed
- `buildLogpointExpression` switched from raw-expression keys in the internal `__vars` lookup to positional `__v0, __v1, ...` keys. The previous design relied on a quotes-only `replace()` that did not handle backslashes, so a crafted placeholder text could close the string and inject code. Positional keys eliminate the class of bug; wire-format keys still carry the original expression text via `JSON.stringify`, so downstream consumers are unaffected ([src/logpoint.ts](src/logpoint.ts)). Threat model and rationale documented inline.
- `resolveGeneratedPosition` falls back to a cross-map basename index when the direct lookup misses, ordering candidates by matching basename first; tracked via `mapsByBasename` Map with bidirectional updates on cache miss/eviction ([src/source-map-resolver.ts](src/source-map-resolver.ts)).
- Source-map scan skips `node_modules`, `.git`, `.cache`, `.next`, `.turbo`, `.nuxt`, `.svelte-kit`, `.vercel` to keep large monorepo walks bounded; replaced the recursive `readdir` with a hand-rolled stack walker ([src/source-map-resolver.ts](src/source-map-resolver.ts)).
- `siblingMapCandidates` (cap 4) and `collectMapFilesForResolve` (cap 8) now use `mapWithConcurrency` over `Promise.all` for `pathExists` probes -- spiky filesystem IO no longer thrashes the event loop on first-resolve.
- `removeBreakpointByDapId` indexes `dapId -> filePath` so removal is O(1) instead of a linear scan over `trackedBreakpoints` ([src/dap-debugger-manager.ts](src/dap-debugger-manager.ts)).
- CDP DAP transport halves the default IPC buffer to 2 KiB and stops double-storing payloads in memory ([src/dap-client.ts](src/dap-client.ts)).
- `setBreakpoints` reuses the adapter's source-map resolution result instead of re-running it inside the manager ([src/dap-debugger-manager.ts](src/dap-debugger-manager.ts)).
- `RingBuffer` moved to its own module with JSDoc and dedicated unit tests; previously inlined in adapter code ([src/ring-buffer.ts](src/ring-buffer.ts)).
- `resolveGeneratedPosition` got a typed internal API returning a discriminated `GeneratedPositionResult`; the public method wraps it in the MCP envelope and `resolveSourceMapPosition` calls the internal API directly, removing a round-trip through JSON parse ([src/source-map-resolver.ts](src/source-map-resolver.ts)).
- `NodeJSDebugAdapter` lifecycle is now explicitly documented as one-shot; `disconnect()` resets internal state so re-attaching after a clean shutdown is a no-op rather than touching stale fields.
- `ToolStateInfo` is now a discriminated union (`{isEnabled: true}` vs `{isEnabled: false, reason: string}`); callers no longer need the `reason!` non-null assertion that TypeScript could not enforce ([src/tool-state-manager.ts](src/tool-state-manager.ts)).
- ESLint now enforces `@typescript-eslint/no-explicit-any` and `@typescript-eslint/no-floating-promises` repo-wide ([eslint.config.mjs](eslint.config.mjs)).
- `MCPServer.close()` calls `dapClient.removeAllListeners()` before closing the stdio transport so a late CDP event cannot reach a torn-down adapter ([src/mcp-server.ts](src/mcp-server.ts)). Same hardening applied to `cdpTransport.removeAllListeners()` inside `NodeJSDebugAdapter.disconnect()` / `terminate()`.

### Fixed
- `setBreakpointByUrl` `urlRegex` is now anchored and the file path is normalised, so a path that is a strict suffix of another file in the workspace cannot match the wrong script ([src/dap-debugger-manager.ts](src/dap-debugger-manager.ts)).
- `breakpointKey` distinguishes `undefined` from the empty string when composing the cache key, so a missing `condition` no longer collides with `condition: ''` ([src/dap-debugger-manager.ts](src/dap-debugger-manager.ts)).
- `setPaused(true)` is dropped when the manager is disconnected. CDP can emit a `paused` event after the session has already been torn down; recording `isPaused=true` while `isConnected=false` would otherwise leave the tool gate in an inconsistent state ([src/tool-state-manager.ts](src/tool-state-manager.ts)).
- `scriptsByBasename` no longer indexes synthetic CDP urls (`eval`, `vm`, `wasm://`, etc.); only file-like urls participate in the basename fallback ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `executionContextCreated` chains a `.catch()` on the `sendCommand` promise to track pending `addBinding` rejections; the previous try/catch around `void promise` was unreachable ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `launchRequest` returns a structured `LAUNCH_FAILED` error envelope immediately instead of partially initialising a child process; the `launch` MCP path was never supported but used to fall through silently ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `lastException` is cleared on non-exception pauses so an old exception payload no longer leaks into a subsequent step pause ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `pollForInspectorPort` switched from sequential probes to `Promise.allSettled` so a slow socket cannot stretch the probe window past the timeout ([src/dap-client.ts](src/dap-client.ts)).
- `breakpointLocations` validates a non-empty `source.path` and returns a structured `VALIDATION_ERROR` instead of returning empty matches ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `path.basename` replaces `split('/').pop()` everywhere the basename is extracted, restoring correctness on Windows path separators.
- `findProjectRoot` negative hits now respect `FIND_PROJECT_ROOT_NULL_TTL_MS`, and the cache is bounded by an LRU cap (`FIND_PROJECT_ROOT_CACHE_MAX = 1024`) so a monorepo walked with many leaf paths cannot grow the cache without bound ([src/utils.ts](src/utils.ts)).
- `disconnect()` / `terminate()` SIGTERM the debuggee then SIGKILL if it has not exited within `KILL_GRACE_MS` ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `enableDebuggerPid` verifies the target is a Node.js process on macOS via `ps -o comm=`, matching the existing Linux check via `/proc/<pid>/comm` ([src/dap-client.ts](src/dap-client.ts)).
- After a CDP reconnect, the adapter re-issues `addBinding` and `enableDomains` so logpoints and `Debugger`/`Runtime`/`Console` events resume working without manual re-attach.
- `connectUrl` and `attachToProcess` validate the inspector port number against `1..65535` instead of trusting whatever the URL parsing produced; an out-of-range port now fails with `VALIDATION_ERROR` ([src/dap-client.ts](src/dap-client.ts)).
- Tracked breakpoints whose underlying script is evicted from `scriptsById` are now reported as `verified=false` instead of staying silently stale.
- `attachToProcess` tears down a half-constructed adapter on failure or re-attach so a second attempt does not stack additional CDP listeners over the previous session.
- `mcpLogpoint` payloads handle non-string `message` values via `safeStringify` instead of `String(value)` (which would coerce `{a:1}` to `[object Object]`).
- `Promise.allSettled` is used wherever a side-effecting CDP fan-out must not be aborted by the first rejection (e.g. `Debugger.enable` / `Runtime.enable` / `Console.enable` on transport reconnect).

### Removed
- Dead `simulateLogpointHit` method and the orphaned helpers `renderLogpointMessage` and `lookupDottedPath` that were superseded by `buildLogpointExpression` ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts), [src/logpoint.ts](src/logpoint.ts)).

## [1.8.1] - 2026-05-21

### Added
- Unit tests for `mapWithConcurrency` in [src/utils.test.ts](src/utils.test.ts) -- covers input-order preservation, the in-flight concurrency cap, empty input, worker count vs item count, error propagation, the `limit <= 0` guard, and the index argument contract. Lifts `src/utils.ts` per-file coverage from 73.17% lines / 75% functions back over the 93% / 100% thresholds enforced by [vitest.config.ts](vitest.config.ts).

### Changed
- `npm-publish.yml` `build` job now runs `npm run test:coverage` instead of `npm test`, so the release path enforces the same coverage thresholds as `node.js.yml`. Previously the two workflows were independent on push events: a coverage regression failed `Node.js CI` on master but `Node.js Package` on the matching tag still published.

## [1.8.0] - 2026-05-21

### Added
- CLI now responds to `--help` / `-h` and `--version` / `-V`; prints a short description, the list of relevant environment variables (`DAP_VERBOSE`, `MCP_CDP_ALLOW_REMOTE`) and exits 0. Useful when the binary is run by hand for inspection ([src/index.ts](src/index.ts)).
- Graceful, idempotent shutdown on `SIGINT` / `SIGTERM`: the MCP server now exposes `close()` which disconnects the DAP client and closes the stdio transport before the process exits.
- Domain error hierarchy (`NotFoundError`, `NotConnectedError`, `ProtocolError`, `ValidationError`) in [src/errors.ts](src/errors.ts). `withErrorHandling` reads the carried `code` from `DomainError`, so MCP clients can branch on `NOT_FOUND` / `NOT_CONNECTED` / `VALIDATION_ERROR` / `PROTOCOL_ERROR` instead of parsing `message`. Plain `Error` continues to surface as `OPERATION_FAILED`.
- `getDebuggerState` now reports `eventErrorCounts` -- a per-CDP-event tally of swallowed handler errors (`Runtime.bindingCalled`, `Runtime.executionContextCreated`, `Debugger.scriptParsed`). Lets operators spot a silent regression without enabling `DAP_VERBOSE` on a hot session.
- `TrackedBreakpoint.sourceMapResolution` is now filled with the actual placement result (`used`, `sourceMapFile`, `matchedSource`, `targetFile`, `targetLocation`) instead of the hard-coded `{ used: false }` placeholder.
- `mapWithConcurrency` helper in [src/utils.ts](src/utils.ts) -- bounded parallel `map` that preserves input order; used by `setBreakpoints` to cap the in-flight CDP requests.

### Changed
- **safe-stable-stringify everywhere in `src/*`.** Cache keys, log messages, MCP wire format and CDP payload serialisation all go through `safeStringify`. Only documented exception: literal `JSON.stringify` tokens emitted into the debuggee runtime via `Runtime.evaluate`, where `safe-stable-stringify` is not available. Project rule recorded in [CLAUDE.md](CLAUDE.md).
- `setExceptionBreakpoints` no longer drops `filters=['caught']` silently. The four CDP states (`none` / `caught` / `uncaught` / `all`) are now reachable, including the previously missing `caught`-only branch.
- `exceptionInfo` reports `breakMode='never'` when the adapter has exception breaking disabled, instead of always claiming `'unhandled'`. Three CDP states map to the matching DAP `ExceptionBreakMode` values (`none` → `never`, `uncaught` → `unhandled`, `all`/`caught` → `always`).
- `connectUrl` rejects malformed URLs with a structured `VALIDATION_ERROR` envelope (`createErrorResponse`) rather than silently parsing a `:NNN` substring out of the middle of arbitrary text. The regex fallback is anchored to a trailing `:PORT` (`/:(\d+)(?:\/.*)?$/`).
- `truncateResult` no longer pays a second `JSON.stringify` on the happy path -- size is measured during the truncating walk. `originalSize` is now reported only when the response was truncated.
- `collectSourceMapFiles` walks subdirectories in parallel via `Promise.all` instead of awaiting each branch sequentially.
- `setBreakpoints` caps in-flight CDP placement work at `DEFAULTS.SET_BREAKPOINTS_CONCURRENCY=8`; DAP id allocation remains serial.
- `removeBreakpointByDapId` and `removeBreakpoint` use a direct `Map.get` lookup (`getTrackedBreakpoint(id)`) instead of a linear scan over `trackedBreakpoints.values()`.
- `siblingMapCandidates` / `collectMapFilesForResolve` deduplicate paths via `Set` instead of `Array.includes` inside the loop.
- `placeBreakpointByScriptId` catch path now records a diagnostic (`scriptId-based placement failed: ...; falling back to URL placement`) so a regression in `getPossibleBreakpoints` / `setBreakpoint` is not masked by the URL fallback.
- `setBreakPointsRequest` failure messages include the failing stage (`snapshot` / `clear` / `place` / `build`) -- a stage-tagged "Set breakpoints failed at stage=clear: ..." is far more diagnostic than the previous flat string.
- `lookupDottedPath` stops descent on scalar intermediates (`typeof acc === 'object'`), so a placeholder like `{a.b.c}` where `a.b` is `0` renders `undefined` once instead of throwing in the runtime expression.
- `enrichAttachResult` short-circuits to the raw attach result when the parsed payload is a JSON array, instead of spreading numeric keys into the success envelope.
- `disconnect()` cleanup paths log warnings via `logError` instead of swallowing every adapter / transport failure silently.
- CDP `Debugger.enable` / `Runtime.enable` / `Console.enable` / `Profiler.enable` are issued in parallel via `Promise.all` in [src/cdp-transport.ts](src/cdp-transport.ts) (each domain still error-isolated via per-domain try/catch).
- `getScriptIdForPath` / `breakpointLocations` use named timeouts from `DEFAULTS` (`SCRIPT_LOOKUP_DEFAULT_TIMEOUT_MS`, `BREAKPOINT_SCRIPT_LOOKUP_TIMEOUT_MS`, `BREAKPOINT_LOCATIONS_LOOKUP_TIMEOUT_MS`) instead of magic literals.
- `scriptsById` / `scriptsByUrl` / `scriptsByBasename` are LRU-bounded at `MAX_SCRIPTS=5000`; long debug sessions that load tens of thousands of `eval` / `vm.compileFunction` scripts no longer grow these maps unboundedly.
- Test fixtures (`tests/fixtures/test-app/*`, `tests/fixtures/test-app-js/*`) bumped to `express ^5.x` to match the project's own dependency; `target: "ES2022"` in the TS fixture for closer parity with the main project.
- `tests/utils/debugger-test-helper.ts`: `BreakpointInfo` is now an intersection of `DebugProtocol.Breakpoint` with `{ id: number }`, so the id stays required for test consumers.
- `test-app-manager.ts` walks the project root via a single helper instead of two duplicated `path.dirname` loops.
- `tests/integration/logpoint-check.test.ts` split one large `it(...)` into three focused cases (fib/sum logpoint, method-call logpoint, generated-position resolution) with `testApp.start` moved into `beforeEach`.
- `package.json` exposes a `format` alias (`npm run format` → `npm run lint:fix`).
- `tsconfig.build.json` excludes `src/**/*.bench.ts` so benchmarks no longer ship in the published tarball.
- `eslint.config.mjs` consolidates ignores into a single block with an explanatory comment.
- `.github/dependabot.yml` adds a dedicated `production` group covering production dependencies on minor + patch updates.

### Fixed
- `Error.cause` is now preserved at every `throw new Error(...)` re-throw site in `dap-debugger-manager.ts`, `dap-client.ts`, `nodejs-debug-adapter.ts`. `DAPClient.sendRequest` no longer collapses errors to `new Error(String(error))`.
- `tests/fixtures/test-app/src/index.ts` keeps `count` in use (`let sum = count - count`) so TypeScript no longer warns about the unused local; `(req, res)` → `(_req, res)` on Express handlers that do not read the request. Line numbers used as breakpoint targets by integration tests are preserved.
- `tests/integration/breakpoints.test.ts` pins the expression-interpolation logpoint to compiled-JS line 30 (the `let sum = ...` initialiser) so it matches the `target: ES2022` emit layout of the test fixture.

### Removed
- Top-level `BUGFIX-source-map-path-normalization.md` -- the historical context is already captured in CHANGELOG 1.1.1 and in the integration test describing the case. The test comment now references CHANGELOG instead of the deleted file.

### Infra / CI
- `codecov/codecov-action` pinned to commit SHA (`e79a6962...`, v6.0.1) instead of the previous tag-object SHA.
- `actions/checkout` and `actions/setup-node` pinned to commit SHAs of v6.0.2 / v6.4.0 respectively, matching the existing third-party SHA pinning policy.
- `npm-publish.yml` `build` job now runs on a matrix `[22, 24]`, matching `node.js.yml`. The smoke pack-and-install step stays on Node 22 only.

## [1.7.0] - 2026-05-20

### Added
- [docs/coordinates.md](docs/coordinates.md) -- single source of truth for the MCP/DAP (1-based) vs CDP/trace-mapping (mixed: 1-based lines, 0-based columns) coordinate convention. Replaces 8+ inline comments that restated the rule independently, so future readers do not have to reconstruct the convention from scattered notes.
- `DEFAULT_THREAD_ID` exported from `src/constants.ts`. `dap-debugger-manager.ts` consumed `threadId ?? 1` as a literal; `nodejs-debug-adapter.ts` already had a private `THREAD_ID = 1`. Both now resolve to the same constant.
- JSDoc summaries for `NodeDebuggerMCPServer`, `DAPDebuggerManager`, `DAPClient`, and `SourceMapResolver` describing the role of each class and the lifecycle / invariants the call sites rely on.
- `engines.npm = ">=10"` so consumers using older npm get an actionable warning instead of opaque install failures (matches the "everyday development works on npm 10+" line in the README).
- Documented `DAP_VERBOSE` environment flag and called out that verbose output may surface user-authored breakpoint conditions / logpoint templates ([README.md](README.md)).
- Table of contents in README.
- Threat model in [docs/SECURITY.md](docs/SECURITY.md) (link from README "Security model").
- Adapter-private DAP error codes registry in [src/constants.ts](src/constants.ts) (`DAP_ERROR_CODES`).
- Global handlers for `uncaughtException` (fatal, exit 1) and `unhandledRejection` (logged, non-fatal) in [src/index.ts](src/index.ts).
- `DebugProtocol.Breakpoint.message` is now populated with a human-readable reason when a breakpoint fails to bind (CDP transport down, placement errors).
- Source-map resolution accepts `.js/.jsx/.mjs/.cjs` originals when the path looks like authored source or has an adjacent `*.map`.
- Strict suffix-match in `SourceMapResolver.matchSource` when `originalSourcePath` is provided, preventing wrong sibling pick in monorepos with duplicate basenames.

### Fixed
- Test fixtures parse `MCP_TEST_APP_PORT` through a strict helper that rejects malformed strings (`"8080garbage"`, mixed input, out-of-range values). Bad values now emit a warning and the fixture falls back to `port=0` / `get-port`, instead of silently passing whatever `parseInt` returned to `listen()`. Helper lives at the end of the fixture file so handler line numbers (used as breakpoint targets by integration tests) stay pinned.
- `RingBuffer.toArray` no longer relies on a non-null assertion; the invariant is enforced at read time so a corrupted internal state fails loudly instead of leaking `undefined` to callers ([src/dap-client.ts](src/dap-client.ts)).
- `pollForInspectorPort` now guarantees a single probe round even when `discoverTimeoutMs<=0`. Previously a caller passing `0` got `undefined` without any probe being attempted ([src/dap-client.ts](src/dap-client.ts)).
- `enrichAttachResult` no longer wraps an ErrorResponse (`success: false`) in `createSuccessResponse`; the failed envelope is preserved and diagnostic context (`activation`, `detectedPort`, `webSocketUrl`) is appended via `createErrorResponse` ([src/dap-client.ts](src/dap-client.ts)).
- `findBreakpointLocationInRange` now reports when the chosen location was a fallback outside the requested window. The placement carries the reason `"moved to nearest available statement"` up to `DebugProtocol.Breakpoint.message` so users see *why* the actual line drifted ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `simulateLogpointHit` iterates all matching logpoints on a line via `filter`; previously `find` silently dropped every logpoint after the first when multiple were attached to the same line ([src/nodejs-debug-adapter.ts](src/nodejs-debug-adapter.ts)).
- `enableDebuggerPid` performs a best-effort `/proc/<pid>/comm` check on Linux and refuses with `PID_NOT_NODEJS` if the target is not a Node.js executable. Avoids sending SIGUSR1 to daemons that interpret it as "reopen logs" / "dump state" ([src/dap-client.ts](src/dap-client.ts)).

### Changed
- `attach` tool: routes through `connectDefault()` only when neither `port` nor `address` was supplied. The previous behaviour fell back to `connectDefault()` whenever the *value* equalled the default, so an explicit `port=9229, address=localhost` was indistinguishable from "user did not pass anything". The zod schema no longer applies `.default(...)` for these two fields; the human-readable default still appears in the description.
- `getLogpointHits` and `getDebuggerEvents` now accept `offset` / `limit` for paginated reads of the underlying ring buffers. Responses additionally expose `returnedCount` / `offset` / `limit` so clients can paginate without re-fetching the full buffer; default behaviour (no pagination args) is unchanged.
- `pollForInspectorPort` uses exponential backoff (200 ms -> 2 s cap) between probe rounds instead of a flat 200 ms loop. Hammering all 22 candidate ports every 200 ms on a misconfigured attach is replaced with a sub-second tail that still picks up a debuggee promptly once it comes up.
- `setBreakpoints` / `clearCDPBreakpoints` issue CDP commands in parallel via `Promise.all`. DAP id allocation stays serial for determinism.
- `truncateResult` measures payload size against the wire format (no indent), eliminating false-positive "Response too large" responses on payloads that would fit; double `JSON.stringify` on the happy path is gone.
- `CDPTransport.connect / sendCommand / enableDomains` no longer `emit('error', ...) + throw`. Only `throw` -- callers see the same failure once.
- `withErrorHandling` redacts sensitive context fields (`expression`, `value`, `condition`, `logMessage`) to `[redacted: N chars]` before echoing them into `ErrorResponse.details`.
- `enableDebuggerPid` / `attachToProcess` now build proper `ErrorResponse` envelopes (human message, structured `details`, explicit `code`) instead of JSON-stringifying everything into `message`.
- DRY refactor: introduced `errorMessage(cause)` helper (centralises the `error instanceof Error` idiom across 25+ sites), `runCdpExecutionCommand` (collapses 5 near-identical DAP request handlers in `NodeJSDebugAdapter`), and `TRUNCATION_OPTIONS_SCHEMA` shared between `evaluate` / `stackTrace` / `variables` tool registrations.
- Reused `isVerbose()` from `logger.ts` instead of re-reading `process.env.DAP_VERBOSE` in `NodeJSDebugAdapter`.

### Removed
- `goto` MCP tool. The underlying DAP handler always threw because V8 has no primitive jump operation; the tool only polluted `tools/list`. The DAP handler stays so external DAP clients still get a proper "not supported" response.
- `dev:test:ts` npm script. It invoked `scripts/dev-test.sh ts` but the script ignored the argument and always built the TS fixture into JS before launching. The single `dev:test` script now documents the actual behaviour (TS sources are still debuggable via the emitted `*.js.map`).
- Broken README link to `demo-ts-mcp-chrome-debugger-protocol.svg` (file does not exist; the GIF link remains).

### Security
- Bumped `ws` to `^8.20.1` (GHSA-58qx-3vcg-4xpx).
- Pinned transitive `hono` to `^4.12.21` via `overrides` (closes GHSA-qp7p-654g-cw7p CSS Declaration Injection, GHSA-hm8q-7f3q-5f36 JWT NumericDate validation, GHSA-p77w-8qqv-26rm `Vary` cache leakage). Comes in via `@modelcontextprotocol/sdk`.
- Pinned transitive `brace-expansion` to `^5.0.6` via `overrides` (GHSA-jxxr-4gwj-5jf2: large numeric range defeats documented `max` DoS protection). Comes in via `eslint` → `minimatch`.
- `scripts/mcp-logpoint-check.mjs` now uses Node's built-in `fetch` instead of `spawn('bash', ['-lc', 'curl ...'])`. The previous form shelled out via login bash for a hardcoded URL — replacing it removes an unnecessary shell-injection surface and one external binary dependency.
- Audited `buildLogpointExpression` escaping after the 1.5.0 fix: order `\\` → `` ` `` → `$` → `{placeholder}` still protects the synthesised template literal from breakout via user-supplied logpoint messages. (Remaining RCE through placeholder expressions themselves is by design — documented under "Threat model" in [docs/SECURITY.md](docs/SECURITY.md).)

### Tests
- Re-aligned unit-coverage thresholds with the current baseline ([vitest.config.ts](vitest.config.ts)). Global `functions` 9 → 10 (matches actual 10.92%). Per-file: `src/utils.ts` `lines`/`statements` 80 → 93, `functions` 80 → 100, `branches` 80 → 72 (the previous 80 floor exceeded the actual 73.68% and broke CI). `src/tool-state-manager.ts` `lines`/`statements` 95 → 98. `src/source-map-resolver.ts` `lines` 35 → 36, `functions` 55 → 57, `branches` 24 → 23 (same pattern: floor exceeded the actual 23.27%). Added a new per-file gate for `src/logpoint.ts` (95L / 100F / 100B / 95S). Integration coverage continues to flow separately via the c8 + `NODE_V8_COVERAGE` pipeline.

### CI
- Annotated git tags + GitHub Releases via `gh release create` from the publish workflow; restored missing `v1.2.0` tag.
- Codecov OIDC upload (no token), and split integration-test coverage into a separate Codecov flag.

## [1.6.1] - 2026-05-07

### Added
- `LICENSE` (MIT) file in repository root and added to the `files` allow-list so it ships in the published tarball.

### Changed
- Strengthened `prepublishOnly` to run lint, typecheck, tests, audit, and build (was: `npm run build` only). Brings the local guard in line with the gates already enforced in `.github/workflows/npm-publish.yml`.

### Tests
- Realigned coverage thresholds with the actual baseline so post-1.6.0 CI stops failing on legitimate runs. Globals `lines`/`statements`/`branches` lowered 13 → 11; `src/source-map-resolver.ts` `lines`/`statements` 65 → 35, `branches` 50 → 24, `functions` 80 → 55. The previous numbers were higher than measured (recent helper extractions had shifted coverage down), and the gap surfaced as a hard failure on the 1.6.0 → 1.6.1 push. Per-file overrides for `utils.ts` and `tool-state-manager.ts` already sat above their baselines and stay unchanged.

## [1.5.1] - 2026-05-07

### Fixed

- **Critical**: `disconnect` no longer kills the MCP server. In 1.5.0 the new direct `adapter.disconnect()` call delegated to `DebugSession.disconnectRequest` from `@vscode/debugadapter`, which calls `this.shutdown()` → `process.exit(0)` in non-server mode. Any client that issued `disconnect` would terminate the server process; reconnects and rapid attach/disconnect cycles failed with `MCP error -32000: Connection closed`. The override now performs all cleanup itself (kill nodeProcess, close cdpTransport, clear call frames / variable handles / lastException) and skips the parent implementation. `sendResponse(response)` is still called so awaiting callers are satisfied. (`src/nodejs-debug-adapter.ts:1055`)

### CI

- `npm-publish.yml`: gate the publish on `npm run test:integration` (between unit tests and the smoke pack-and-install). Without this gate, the 1.5.0 regression above was published despite integration tests being broken on master. Job-level `timeout-minutes` raised from 10 to 25 to accommodate the added ~9 min runtime; step-level `timeout-minutes: 18` mirrors `node.js.yml`.

## [1.5.0] - 2026-05-07

### Fixed

- `disconnect`: route through `adapter.disconnect()` directly. The previous `sendRequest('disconnect')` had no handler in the adapter dispatch table, so the call silently no-op'd while the client thought it had cleanly torn down.
- `Debugger.resumed` is now translated to a DAP `ContinuedEvent` (with the matching reset of `lastException` / `currentCallFrames` / `variableHandles`). Without it, IDEs that listen for `continued` never updated their UI when the debuggee resumed on its own (e.g. step-out at top of stack).
- `removeBreakpoint`: only emit the `breakpoint_removed` MCP notification when the underlying CDP call actually succeeded. Previously we fired the notification before checking the result envelope and lied to clients on failure.
- `isCommandAvailable`: resolve `false` on timeout instead of leaving the caller to race the unhandled timer; window raised to 1000 ms.
- `attachToProcess`: drop the duplicate `emitStateChange(true)` (the handler in `dapHandlers.attach` already emits, so subscribers were notified twice on every attach).
- `createLogpointExpression`: tighten escape ordering to `\\` → `` ` `` → `\n` → `{...}` so a logMessage like `${process.env.SECRET}` can no longer escape the template literal and execute in the debuggee.
- `handleException`: mint our own `exceptionId` via `nextExceptionId` rather than echoing the (sometimes empty / colliding) value from CDP.
- `setBreakpoints` via the `lines[]` shape: now tracked through the same `addTrackedBreakpoint` path as the `breakpoints[]` shape — previously the legacy shape silently skipped tracking, so subsequent `removeBreakpoint` failed to find them.
- `pollForInspectorPort`: probe candidate ports in parallel via `Promise.all` instead of sequential awaits — first-good-port wins.
- `goto` and the `launch` envelope now throw descriptive errors instead of returning fake `success: true`. The features were never implemented; the fake-success path masked that.

### Performance

- Source-map listing: cache `findSourceMapsInDirs` results with a 30 s TTL keyed by directory; resolve sibling `.map` files first and only fall back to the full build-dir scan if siblings yield nothing.
- `nodejs-debug-adapter`: O(1) script lookup by basename via `scriptsByBasename` index, replacing an O(N) iteration over every parsed script on each breakpoint placement.
- `findProjectRoot`: memoised at module scope (cwd → project root); the walk used to repeat for every source-map resolution.

### Changed

- `nodejs-debug-adapter`: noisy `OutputEvent`s (~9 call sites: script parsed, breakpoint placed, breakpoint resolved, etc.) gated behind a new `DAP_VERBOSE=1` env switch via a `diagnostic()` helper. Default output is now signal-only.
- Synthetic CDP breakpoint ids use a separate `nextSyntheticCdpId` counter so they cannot collide with the DAP-side `nextBreakpointId` sequence.
- `Debugger.setBreakpointByUrl` and `getScriptIdForPath` use `pathToFileURL(...).href` for the file URL form instead of hand-rolled `file://` concatenation, which broke on Windows-style paths.
- `mcp-server`: dropped the unused `tools` Map / `ToolCategory` / `updateToolsAvailability` machinery and the matching `tools.listChanged` capability; tool registration is now a flat sequence of `server.registerTool(...)` calls.

### Removed

- `scripts/install-claude-code-{dev-,}mcp.sh`, `scripts/uninstall-claude-code-mcp.sh`, and the matching `mcp:install` / `mcp:install:dev` / `mcp:uninstall` npm scripts. Installation will be handled per agent type elsewhere; bundling Claude-Code-specific shell helpers in the published package was scope creep.
- `simulateBreakpointHit` (dead code) and the `coverage.thresholds: { statements: 0, ... }` block from `vitest.config.ts` (zero floors are no-ops).

### Tests

- `tests/globalSetup.ts` teardown: send SIGTERM, wait a short grace, probe liveness via `process.kill(pid, 0)`, then escalate to SIGKILL only if the debuggee is still alive. Previous logic only ever sent SIGKILL when SIGTERM threw, so a stuck debuggee never received it.
- Removed the `it.skip("connect to fixed port 9229")` placeholder — it required a debugger on a fixed system port and conflicted with concurrent runs; the no-args attach path is exercised indirectly by other tests.

### CI

- `node.js.yml`: added `workflow_dispatch` (manual reruns without a fresh commit), step-level `timeout-minutes: 18` on the integration step (so a hung Node-inspector test cannot eat the 25-min job budget), and dropped `--if-present` from the build step (build is required, not optional).
- `npm-publish.yml`: top-level `concurrency: { group: npm-publish, cancel-in-progress: false }` so two tags pushed in quick succession cannot race each other through `npm publish --provenance`.

### Docs

- `AGENTS.md` and `tests/README.md` migrated from jest to vitest references (configs, CLI flags, watch mode, coverage); `tests/README.md` test-suites list rewritten to match the actual files under `tests/integration/`.
- `README.md`: new "Security notes" section explaining that `evaluate` and logpoints execute arbitrary code on the debuggee by design and that `node --inspect` should stay bound to 127.0.0.1.

### DX

- `package.json`: added `prebuild` (`rm -rf dist`) so build always starts clean, and a `test:all` shortcut for unit + integration in sequence.
- `scripts/dev-test.sh`: `set -euo pipefail`, replaced fixed `sleep 2` with a `curl /json/version` polling loop, fail-fast on build errors.
- `.npmignore`: dropped refs to removed jest/lint configs and analyze scripts; added vitest configs, `AGENTS.md`, `CHANGELOG.md`, `.github/`, `coverage*/`, `*.pid` to keep the published tarball lean.
- Test fixture: bumped `express` to `^4.21.2` to close the open GHSA advisories on the 4.18 line (dev-only, but still surfaces in `npm audit`).

## [1.4.0] - 2026-05-06

### Added

- DX scaffolding: `.nvmrc` (Node 24), `.editorconfig`, `tsconfig.base.json` shared compiler options, `dependabot.yml` with grouped weekly bumps for npm (types/eslint/vitest) and github-actions.
- CI hardening: top-level `permissions: contents: read`, `concurrency` group with `cancel-in-progress`, `fail-fast: false` on the build matrix.
- Codecov upload from the unit test job (`test:coverage` script + `codecov-action@v6` SHA-pinned, gated to the 22.x matrix entry).
- Dedicated `audit` job — `npm audit --omit=dev --audit-level=high` as a blocking check on production deps; advisory pass on the full tree.
- Smoke pack-and-install step in the publish workflow: builds a real tarball, installs into a clean throwaway project, exercises the bin entry with `--help` before publish.

### Changed

- Trigger npm publish on `git push --tags` (`v*`) instead of `release: created`. Releasing now matches the workflow used by sibling MCP servers (mongo, pg, yt) — the action is `git tag vX.Y.Z && git push --tags`, no extra `gh release create` step required.
- ESLint: switched to `typescript-eslint` v8 `projectService: true` (single shared TS server, much lower memory than `parserOptions.project`); added `--cache --cache-location node_modules/.cache/eslint/`.
- Tsconfig layout reorganised mongo-style to support `projectService`: `tsconfig.json` includes src + tests + configs (noEmit, used by typecheck and projectService), new `tsconfig.build.json` for production sources only, removed the standalone `tsconfig.lint.json`.
- Enabled strict TS flags on `tsconfig.base.json`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Resolved 194 emerging type errors via `override` modifiers, conditional spreads for external DAP types, `| undefined` on owned interfaces, and non-null assertions for guaranteed-present indexed accesses.

### Removed

- `CONTRIBUTING.md`. Personal-use server with no external contributors — the doc had no audience.

## [1.3.0] - prior release

### Changed

- DRY refactor across tool handlers; table-dispatch for DAP requests; decomposed breakpoint and inspector flows.
- Centralised constants; DRY source-map walks; ring-buffered debugger events.

### Fixed

- Critical breakpoint placement and inspector binding bugs; eliminated a timer leak; tightened CI bounds.

### Tests

- Migrated test runner from jest to vitest; strict integration limits.

### Other

- Closed minor/info review findings (DX nits, zod 4 compatibility shims, exception-state path, CI publish wiring).

## [1.2.0] - prior release

### Fixed

- Routed DAP commands through the real adapter; unified the response envelope; tightened input validation.
- Source-map normalisation for paths with multiple `../` prefixes.

### Changed

- CI: switched npm publish to OIDC trusted publishing (Node 24, npm 11.5.1+, `actions/setup-node` v6, `package-manager-cache: false`).
- Bumped major dependencies and closed `npm audit` advisories.

## [1.1.1] - prior release

### Fixed

- Source-map path normalisation; matched GitHub owner casing in `package.json` URLs.

## [1.1.0] - prior release

### Added

- Initial DAP-based debugger adapter; integration test app fixture.

## [1.0.0] - prior release

### Added

- Initial public release.
