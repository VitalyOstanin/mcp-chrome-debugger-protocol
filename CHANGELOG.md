# Changelog

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
