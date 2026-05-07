# Changelog

## Unreleased

### Added
- `LICENSE` (MIT) file in repository root and added to the `files` allow-list so it ships in the published tarball.

### Changed
- Strengthened `prepublishOnly` to run lint, typecheck, tests, audit, and build (was: `npm run build` only). Brings the local guard in line with the gates already enforced in `.github/workflows/npm-publish.yml`.

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
