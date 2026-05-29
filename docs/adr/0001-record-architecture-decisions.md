# ADR-0001: Record architecture decisions

## Status

Accepted

## Context

The project has a non-trivial architecture: an MCP server that bridges to a
Node.js inspector debuggee over CDP, exposes a DAP-style tool surface, and
performs TypeScript-to-JavaScript source-map resolution. Decisions about
coordinate systems, breakpoint placement, the logpoint transport, and the
wire-format contract have already been made and are currently scattered across
`README.md`, `CLAUDE.md`, `AGENTS.md`, and commit history. New contributors lack
a single place that records why these choices were made.

## Decision

We will use Architecture Decision Records to document architecturally
significant decisions. ADRs live in `docs/adr/`, follow Michael Nygard's
template ([template.md](template.md)), are numbered sequentially, and are
immutable once accepted (a later ADR supersedes an earlier one rather than
editing it).

## Consequences

- The rationale behind significant decisions becomes discoverable in one place.
- Each significant change carries a small documentation cost (one ADR).
- Existing implicit decisions can be back-filled as ADRs incrementally; this ADR
  does not require doing so retroactively in a single pass.
