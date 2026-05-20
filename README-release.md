# Release Procedure

This document outlines the complete release procedure for the MCP Chrome Debugger Protocol project. Follow these steps in order to ensure a clean, validated release.

## Table of Contents

- [Overview](#overview)
- [Repository Hardening (one-time)](#repository-hardening-one-time)
  - [Branch Protection on `master`](#branch-protection-on-master)
  - [npm Trusted Publisher](#npm-trusted-publisher)
- [Pre-Release Checklist](#pre-release-checklist)
  - [1. Version Update](#1-version-update)
  - [2. Lock File Update](#2-lock-file-update)
  - [3. CHANGELOG Update](#3-changelog-update)
  - [4. README Verification](#4-readme-verification)
  - [5. Build and Test Validation](#5-build-and-test-validation)
  - [6. Linter Validation](#6-linter-validation)
  - [7. Git Status Check](#7-git-status-check)
- [Release Execution](#release-execution)
  - [Release Steps](#release-steps)
  - [Monitor Release Progress](#monitor-release-progress)
  - [What GitHub Actions Does](#what-github-actions-does)
- [Post-Release Verification](#post-release-verification)
- [Rollback](#rollback)
  - [Within 72 Hours: npm Deprecate + Patch Release](#within-72-hours-npm-deprecate--patch-release)
  - [After 72 Hours: Patch Release Only](#after-72-hours-patch-release-only)

## Overview

The project uses **automated CI/CD via GitHub Actions** for releases:

- **CI workflow** (`.github/workflows/node.js.yml`) — runs lint, typecheck, build, unit and integration tests on every push and PR to `master`.
- **Publish workflow** (`.github/workflows/npm-publish.yml`) — runs the same gates plus a smoke pack-and-install, then publishes to npm with provenance and creates a GitHub Release. Triggered by pushing a tag matching `v*`.

> The project ships as an npm package, not a hosted service. Server-side deployment patterns (rolling update, blue/green, canary) do not apply; pre-release semver tags (`-rc.N`) and `npm deprecate` + a patch release cover staged rollout and rollback respectively (see [Rollback](#rollback) below).

**Quick Release (TL;DR):**

```bash
npm version patch       # bump version, create commit + annotated tag
git push --follow-tags  # push commit and tag → triggers automated release
```

For detailed instructions and prerequisites, continue reading below.

## Repository Hardening (one-time)

These settings live in the GitHub UI, not in the repo, so they have to be configured once by a repository administrator. They protect the release pipeline from accidental or unauthorized publishes.

### Branch Protection on `master`

Goal: every change that lands on `master` is reviewed and gated by CI, and no one (not even an admin) can push directly. Configure under **Settings → Branches → Branch protection rules** (classic rules) or **Settings → Rules → Rulesets** (newer UI — equivalent settings).

Required settings:

- **Require a pull request before merging** — at least one review approval. Enable **Dismiss stale pull request approvals when new commits are pushed** so a force-pushed PR cannot ship under an old approval.
- **Require status checks to pass before merging** — select these checks (names match the matrix in `.github/workflows/node.js.yml`):
  - `build (22.x)`
  - `build (24.x)`
  - `audit`
- **Require branches to be up to date before merging** — prevents merging a PR whose base has moved.
- **Require linear history** — disallows merge commits, keeps `master` bisectable.
- **Do not allow bypassing the above settings** (or, in classic rules, enable **Include administrators**) — protections must apply uniformly.
- **Allow force pushes**: disabled.
- **Allow deletions**: disabled.

Optional but recommended:

- **Require signed commits** — every merged commit must be GPG/SSH-signed.
- **Require conversation resolution before merging** — outstanding review threads block merge.

### npm Trusted Publisher

The publish job authenticates to the npm registry via OIDC. There is **no `NPM_TOKEN` secret** anywhere in the repository; instead the GitHub Actions OIDC token (`id-token: write`) is exchanged for a short-lived registry token at publish time.

One-time setup on <https://www.npmjs.com>:

1. Sign in to the npm account that owns `@vitalyostanin/mcp-chrome-debugger-protocol`.
2. Go to **Package settings → Access → Trusted publisher → Add**.
3. Pick **GitHub Actions** and fill in:
   - **Repository owner**: `VitalyOstanin`
   - **Repository name**: `mcp-chrome-debugger-protocol`
   - **Workflow filename**: `npm-publish.yml`
   - **Environment name**: leave empty (this repo's publish job does not pin to a GitHub Environment).
4. Save.

Requirements that are already wired up in this repo:

- `permissions: id-token: write` on the publish job (`.github/workflows/npm-publish.yml`).
- Node.js 24 in the publish job — npm 11.5.1+ is required for Trusted Publishing, and Node 24 ships it out of the box.
- `package-manager-cache: false` in `actions/setup-node` (per npm docs; the cache otherwise interferes with the OIDC handshake).

If a `NPM_TOKEN` secret was previously configured at the repo level, **delete it** — passing it alongside OIDC suppresses the trust-check on the registry side.

## Pre-Release Checklist

### 1. Version Update

Version should follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (x.0.0) — breaking changes to MCP tool schemas or CLI behavior.
- **MINOR** (0.x.0) — new tools, new tool parameters, new functionality, backward-compatible.
- **PATCH** (0.0.x) — bug fixes, internal refactors, no externally observable changes.

Bump and tag in one step:

```bash
npm version patch    # 1.6.1 → 1.6.2
# or
npm version minor    # 1.6.1 → 1.7.0
# or
npm version major    # 1.6.1 → 2.0.0
```

`npm version` automatically updates `package.json` and `package-lock.json`, creates a commit, and creates an **annotated** git tag. **Always use `npm version`** instead of manual `git tag` — lightweight tags lose authorship/date metadata and break `git push --follow-tags`.

**Historical note (not actionable):** The tags `v1.0.0`, `v1.0.1`, `v1.1.0`, and `v1.3.0` predate this rule and were created as lightweight tags. They are intentionally **not** re-tagged: rewriting a published tag would force-push the ref and could surprise consumers that pin against it (npm tarballs are not affected because they resolve by commit SHA, but GitHub UI links, `git describe`, and downstream tooling cached state can drift). Newer tags from `v1.1.1` onward (and the restored `v1.2.0`) are annotated. Treat the gap as known and do not attempt a retroactive fix unless there's an explicit need.

### 2. Lock File Update

If you bumped a dependency or `npm version` did not refresh the lockfile:

```bash
npm install
git diff package-lock.json
```

Never commit a stale lockfile. Production publishes use `npm ci`, which fails if `package-lock.json` and `package.json` disagree.

### 3. CHANGELOG Update

Add a section for the new version at the top of `CHANGELOG.md`:

```markdown
## [1.7.0] - 2026-MM-DD

### Added
- New `Z` MCP tool that returns ...

### Fixed
- Race condition in source-map resolver for ...

### Changed
- Bumped `@modelcontextprotocol/sdk` to 1.30.0.
```

Use ISO dates (`YYYY-MM-DD`). The CI publish workflow does not parse the CHANGELOG, but the GitHub Release notes link to it, so an absent or stale entry shows up immediately after publish.

### 4. README Verification

Confirm `README.md` reflects:

- New tools and tool parameters (the **Available Tools** section).
- Updated logpoint behavior, if any (the **Logpoints** section).
- New environment variables or CLI flags.
- Updated Node.js version requirement, if `engines.node` changed.

If the **Table of Contents** drifted from the section headers, refresh it.

### 5. Build and Test Validation

Run the full local validation cycle. This mirrors what CI will run.

```bash
npm run lint        # ESLint
npm run typecheck   # tsc -p tsconfig.json (covers src + tests)
npm run build       # tsc -p tsconfig.build.json
npm test            # unit (vitest)
npm run test:integration   # integration suite (spawns real Node.js + inspector)
```

Build must complete without errors. All tests must pass.

`prepublishOnly` runs `npm run lint && npm run typecheck && npm test && npm audit --omit=dev --audit-level=high && npm run build` automatically before publish; the local cycle above mirrors it so failures surface before you push the tag.

### 6. Linter Validation

If lint flagged issues, auto-fix where possible:

```bash
npm run lint:fix
npm run lint        # confirm clean
```

### 7. Git Status Check

```bash
git status
```

Expected: `nothing to commit, working tree clean`. The `npm version` command in step 1 creates the version-bump commit; nothing else should be pending. If there are uncommitted changes, decide whether they belong in this release; either commit them on a separate PR before tagging, or revert.

## Release Execution

### Release Steps

```bash
# 1. Bump version (creates commit and annotated tag)
npm version patch    # or minor / major

# 2. Push commit and tag to GitHub
git push --follow-tags

# 3. GitHub Actions runs npm-publish.yml automatically:
#    - build job: lint, typecheck, build, unit tests, integration tests,
#      smoke pack-and-install on Node 22.
#    - publish-npm job (needs: build): npm publish via Trusted Publishing
#      OIDC with provenance, then `gh release create`.
```

### Monitor Release Progress

1. **GitHub Actions workflow:**

   ```bash
   gh run list --workflow=npm-publish.yml --limit 1
   gh run watch
   ```

   Or visit <https://github.com/VitalyOstanin/mcp-chrome-debugger-protocol/actions>.

2. **GitHub Release:** Verify the new release appears at <https://github.com/VitalyOstanin/mcp-chrome-debugger-protocol/releases> with the correct tag and CHANGELOG link.

### What GitHub Actions Does

`.github/workflows/npm-publish.yml` defines two jobs:

**build** (no special permissions; runs first):

1. Checkout, setup Node.js 22 with npm cache.
2. `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.
3. `npm run test:integration` — spawns a real Node.js inspector debuggee and exercises the MCP server end-to-end. Step capped at 18 minutes.
4. Smoke pack-and-install: build a real tarball, install it into a throwaway directory, run `mcp-chrome-debugger-protocol --help`. Catches missing files in the `files` allow-list, broken shebang, missing runtime deps.

**publish-npm** (`needs: build`):

1. Checkout, setup Node.js 24 with `package-manager-cache: false` (Trusted Publishing requirement) and `registry-url`.
2. `npm ci`.
3. `npm publish --provenance --access public` — authenticates via GitHub Actions OIDC against the npm Trusted Publisher. **No `NPM_TOKEN` secret involved**.
4. `gh release create` with installation instructions and a link to the CHANGELOG section for this tag.

If any step in `build` fails, `publish-npm` does not run and no tag-triggered publish ships.

## Post-Release Verification

### Verify npm Package

```bash
# Published version
npm view @vitalyostanin/mcp-chrome-debugger-protocol version

# Full package metadata
npm view @vitalyostanin/mcp-chrome-debugger-protocol

# Provenance signature
npm view @vitalyostanin/mcp-chrome-debugger-protocol --json | jq .dist.attestations
```

### Smoke Test Published Package

```bash
npx -y @vitalyostanin/mcp-chrome-debugger-protocol@latest --help
```

Expected: usage message prints, exit code 0.

### Verify GitHub Release

```bash
gh release view vX.Y.Z
```

Or visit <https://github.com/VitalyOstanin/mcp-chrome-debugger-protocol/releases/latest>.

Verify:

- Release is published (not draft).
- Tag matches package version.
- CHANGELOG link resolves to the right section.

## Rollback

There is no in-place rollback for npm: a published version is immutable. The two recovery paths are deprecate + patch.

### Within 72 Hours: npm Deprecate + Patch Release

Within npm's 72-hour unpublish window the broken version can be marked as `deprecated` so installers see a warning, and a patch release is published with the fix:

```bash
# 1. Mark the broken version as deprecated (no force-unpublish — that breaks anyone pinned to it)
npm deprecate @vitalyostanin/mcp-chrome-debugger-protocol@1.6.2 \
  "Broken: regression in setBreakpoints. Use 1.6.3+."

# 2. Fix the regression on master, bump and re-release
npm version patch   # 1.6.2 → 1.6.3
git push --follow-tags
```

`npm unpublish` is **not** used; unpublishing breaks every lockfile that has the version pinned.

### After 72 Hours: Patch Release Only

After 72 hours npm refuses unpublish. Deprecate-and-patch is the only path:

```bash
npm deprecate @vitalyostanin/mcp-chrome-debugger-protocol@1.6.2 \
  "Broken: regression in setBreakpoints. Use 1.6.3+."

# Fix, bump, release
npm version patch
git push --follow-tags
```

If the broken version exposes a security issue, also:

1. File a security advisory at <https://github.com/VitalyOstanin/mcp-chrome-debugger-protocol/security/advisories>.
2. Add an entry to `CHANGELOG.md` under the new patch version describing the regression and the fix.
3. Update `docs/SECURITY.md` if the threat model changed.
