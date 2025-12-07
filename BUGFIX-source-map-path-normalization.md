# Bug Fix: Source Map Path Normalization

## Problem
Logpoints on TypeScript files failed to work when source maps contained paths with multiple `../` prefixes (e.g., `../../src/...`).

## Root Cause
In `src/source-map-resolver.ts`, line 280, the path normalization only removed a single `../` prefix:

```typescript
const normalizedSource = source.replace(/^\.\.\//, '').replace(/\\/g, '/');
```

This failed for source maps with paths like `../../src/publications/publications.controller.ts`.

## Solution
Changed the regex to remove all leading `../` sequences:

```typescript
const normalizedSource = source.replace(/^(\.\.\/)+/, '').replace(/\\/g, '/');
```

## Testing
- Manual test: Successfully set logpoint on TypeScript file and captured JSON.stringify output
- Integration tests: All 13 source map resolution tests passed
- Logpoint check test: TypeScript logpoint interpolation test passed

## Impact
- TypeScript breakpoints and logpoints now work correctly with any source map structure
- JSON.stringify() in logpoint expressions works as expected
- No breaking changes to existing functionality
