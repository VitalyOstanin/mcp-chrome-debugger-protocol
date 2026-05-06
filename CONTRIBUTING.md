# Contributing to MCP Chrome Debugger Protocol

Thanks for your interest in this project. Before submitting changes, please skim this guide so the review process stays smooth.

## Table of Contents

- [Project Status](#project-status)
- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Development Loop](#development-loop)
- [Pre-PR Checklist](#pre-pr-checklist)
- [Coding Style](#coding-style)
- [Commit Convention](#commit-convention)
- [Pull Requests](#pull-requests)
- [Reporting Issues](#reporting-issues)

## Project Status

This is a personal-use MCP server. The author may decline feature requests that fall outside personal needs. Bug fixes, security fixes, and small focused improvements are welcome regardless.

## Prerequisites

- Node.js as specified in [`.nvmrc`](.nvmrc) (current LTS, >= 22). With nvm: `nvm use`.
- npm 11+.
- A Node.js process to debug (the bundled `tests/fixtures/test-app` is used for integration tests).

## Initial Setup

```bash
git clone https://github.com/VitalyOstanin/mcp-chrome-debugger-protocol.git
cd mcp-chrome-debugger-protocol
npm install
```

## Development Loop

| Script                       | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `npm run build`              | Compile TypeScript to `dist/` and chmod the CLI entrypoint       |
| `npm run lint`               | Run ESLint                                                       |
| `npm run lint:fix`           | Run ESLint with `--fix`                                          |
| `npm test`                   | Run the unit Vitest suite once                                   |
| `npm run test:integration`   | Run integration tests against a real Node.js debug target        |

Editor settings are pinned via [`.editorconfig`](.editorconfig). Most editors pick this up automatically.

## Pre-PR Checklist

Before opening a pull request, run all of these locally and make sure they pass:

```bash
npm run lint
npm run build
npm test
```

If you touched anything in the DAP / source-map / breakpoint flow, also run the integration suite:

```bash
npm run test:integration
```

CI runs both suites automatically (see `.github/workflows/node.js.yml`).

## Coding Style

- TypeScript strict mode is enforced via `tsconfig.base.json` (`strict: true`).
- ESM is used end-to-end (`"type": "module"`). Imports keep the `.js` extension at runtime; `tsc` and Vitest (via Vite) resolve them to `.ts`.
- ESLint config (`eslint.config.mjs`) enforces:
  - `prefer-template`, `prefer-const`, `no-var`.
  - `padding-line-between-statements` for blank lines around `return` and variable declarations.
  - `consistent-type-imports`, `consistent-type-exports`.
  - `comma-dangle: always-multiline` everywhere.
- Prefer `interface` over `type` aliases for object shapes.
- Don't add comments that just restate what the code does. Comments should explain *why* something non-obvious was chosen.
- Don't add backwards-compatibility shims for code that hasn't shipped externally. If a tool was renamed, just rename it.

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>
```

Common types:

- `feat` -- new functionality.
- `fix` -- bug fix.
- `refactor` -- code change that neither fixes a bug nor adds a feature.
- `perf` -- performance improvement.
- `test` -- adding or fixing tests.
- `docs` -- documentation only.
- `chore` -- tooling, dependencies, build, CI.
- `ci` -- CI/CD configuration changes.

Scope is usually the affected module (`dap-client`, `nodejs-debug-adapter`, `mcp-server`, `ci`, `deps`, `dx`, etc.).

Keep subjects in the imperative mood and under ~72 characters. Use the body for *why*, not *what*.

## Pull Requests

- Branch off `master`.
- One logical change per PR. Refactors should not bundle unrelated functional fixes.
- Update tests when behavior changes. New tools should ship with their own integration test.
- Update `README.md` and (if relevant) this file when public surface or workflow changes.
- The CI workflow must be green before a merge.

## Reporting Issues

Open issues at <https://github.com/VitalyOstanin/mcp-chrome-debugger-protocol/issues>. For bugs, include:

- The exact reproduction steps or a minimal failing snippet.
- The MCP client you're using (Qwen Code, Cline, Claude Code, etc.).
- The Node.js version of the debug target.
- Relevant environment variables, *with secrets redacted*.
