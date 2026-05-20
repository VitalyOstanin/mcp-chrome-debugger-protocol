# Coordinate systems

## Table of contents

- [Summary](#summary)
- [Boundaries](#boundaries)
- [Conversion table](#conversion-table)
- [Where the rule is enforced](#where-the-rule-is-enforced)

## Summary

Every MCP tool, every DAP request, and every CDP probe in this codebase uses
one of two integer coordinate systems for source positions. Mixing them is the
historical root cause of off-by-one breakpoint drift; the rule below is
mandatory for every new call site.

- **MCP / DAP boundary**: both `line` and `column` are **1-based**. The first
  line of a file is `1`, the first column on a line is `1`. This matches the
  DAP `InitializeRequest` defaults we set (`linesStartAt1: true`,
  `columnsStartAt1: true`) and what any DAP-aware IDE expects on the wire.

- **CDP / V8 / `@jridgewell/trace-mapping` internals**: `line` is **1-based**
  but `column` is **0-based**. We never expose these numbers to MCP tool
  arguments or DAP responses — they exist only inside `SourceMapResolver`,
  `nodejs-debug-adapter`, and CDP requests like `Debugger.setBreakpoint`.

## Boundaries

| Boundary                                                       | Lines    | Columns  |
|----------------------------------------------------------------|----------|----------|
| MCP tool inputs / outputs (`setBreakpoints`, `evaluate`, ...)  | 1-based  | 1-based  |
| DAP `Source`, `StackFrame`, `Breakpoint` envelope              | 1-based  | 1-based  |
| `@vscode/debugadapter` `Breakpoint(verified, line, column)`    | 1-based  | 1-based  |
| CDP `Debugger.Location`, `BreakLocation`                       | 0-based  | 0-based  |
| `trace-mapping` `TraceMap` lookups (`originalPositionFor`)     | 1-based  | 0-based  |

The only place lines diverge is CDP itself: V8 publishes 0-based line numbers,
so `placeBreakpointByScriptId` does a single `lineNumber + 1` flip when it
hands the result back to the DAP layer.

## Conversion table

When a 1-based column crosses the CDP / trace-mapping boundary, subtract one
on the way down and add one on the way back. The conversions are not deep
copies — they happen at the function boundary that owns the protocol.

```
DAP in     col_dap = 1-based                  // tool argument
CDP call   col_cdp = col_dap - 1              // 0-based, sent to V8
CDP back   col_cdp = response.columnNumber    // 0-based
DAP out    col_dap = col_cdp + 1              // back to wire
```

The same applies to `originalPositionFor` / `generatedPositionFor` against a
`TraceMap`: pass `column - 1`, surface `result.column + 1`.

## Where the rule is enforced

Comments in code reference this document instead of restating the rule:

- `src/mcp-server.ts` — boundary where every tool input is parsed
- `src/dap-debugger-manager.ts` — high-level DAP/CDP orchestration
- `src/source-map-resolver.ts` — TS<->JS coordinate mapping (multiple sites,
  one per public method)
- `src/nodejs-debug-adapter.ts` — `placeBreakpointByScriptId`,
  `setBreakPointsRequest`, `findBreakpointLocationInRange`

If you add a new call site that touches a `line` or `column` value, link it
back here so future readers do not have to reconstruct the convention from
scattered inline comments.
