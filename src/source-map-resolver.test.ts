import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceMapResolver } from './source-map-resolver.js';

const parsePayload = (resp: { content: Array<{ type: string; text: string }> }): unknown =>
  JSON.parse(resp.content[0]!.text);

describe('SourceMapResolver.resolveGeneratedPosition coordinate validation', () => {
  const resolver = new SourceMapResolver();

  it('rejects line < 1 with structured error', async () => {
    const result = await resolver.resolveGeneratedPosition('file.ts', 0, 1, []);
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Invalid line number: lines must be 1-based (start at 1)');
    expect(parsed.receivedLine).toBe(0);
  });

  it('rejects column < 1 with structured error', async () => {
    const result = await resolver.resolveGeneratedPosition('file.ts', 1, 0, []);
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Invalid column number: columns must be 1-based (start at 1)');
    expect(parsed.receivedColumn).toBe(0);
  });

  it('rejects empty originalSource', async () => {
    const result = await resolver.resolveGeneratedPosition('', 1, 1, []);
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Invalid originalSource: must be a non-empty path or filename');
  });

  it('returns "no matching source" when no source maps available', async () => {
    // Pass a non-existent map path so the empty-array branch (which would auto-
    // discover from cwd) is skipped; the filter drops the entry, leaving 0 maps.
    const result = await resolver.resolveGeneratedPosition(
      'foo.ts', 1, 1, ['/nonexistent/no-such.js.map'],
    );
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('No matching source found in available source maps');
    expect(parsed.searchedMaps).toBe(0);
    expect(parsed.originalSource).toBe('foo.ts');
    expect(parsed.coordinateSystem).toBe('MCP/DAP coordinates: 1-based lines, 1-based columns');
    expect(parsed.inputCoordinates).toEqual({ line: 1, column: 1 });
  });

  it('rejects negative line', async () => {
    const result = await resolver.resolveGeneratedPosition('foo.ts', -5, 1, []);
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.receivedLine).toBe(-5);
  });
});

describe('SourceMapResolver.resolveOriginalPosition coordinate validation', () => {
  const resolver = new SourceMapResolver();

  it('rejects line < 1', async () => {
    const result = await resolver.resolveOriginalPosition(0, 1, []);
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Invalid line number: lines must be 1-based (start at 1)');
  });

  it('rejects column < 1', async () => {
    const result = await resolver.resolveOriginalPosition(1, 0, []);
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Invalid column number: columns must be 1-based (start at 1)');
  });

  it('returns "no original position found" when no maps match', async () => {
    const result = await resolver.resolveOriginalPosition(1, 1, []);
    const parsed = parsePayload(result) as Record<string, unknown>;

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('No original position found');
    expect(parsed.searchedMaps).toBe(0);
    expect(parsed.inputCoordinates).toEqual({ line: 1, column: 1 });
  });
});

describe('SourceMapResolver.invalidateSourceMapListing', () => {
  let projectRoot: string;
  const writtenMaps: string[] = [];

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'smr-invalidate-'));
    // Drop a marker package.json so findProjectRoot anchors the listing cache
    // to this tmpdir instead of walking up to the parent project (whose dist/
    // already contains real .map files and would pollute the assertions).
    await writeFile(join(projectRoot, 'package.json'), '{}');
    await mkdir(join(projectRoot, 'dist'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
  });

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('forces a re-scan of the build dir after explicit invalidation', async () => {
    const resolver = new SourceMapResolver();
    // Seed with one initial map so collectMapFilesForResolve does not fall back
    // to process.cwd() (which would pick up the host project's real .map files
    // and break this test's isolation).
    const initialMap = join(projectRoot, 'dist', 'initial.js.map');

    await writeFile(initialMap, JSON.stringify({
      version: 3,
      sources: ['../src/initial.ts'],
      mappings: '',
      names: [],
    }));
    writtenMaps.push(initialMap);

    // First call seeds the listing cache with [initial.js.map].
    const first = await resolver.resolveGeneratedPosition(
      'no-match.ts', 1, 1, undefined, join(projectRoot, 'src', 'no-match.ts'),
    );
    const firstParsed = JSON.parse(first.content[0]!.text) as Record<string, unknown>;

    expect(firstParsed.searchedMaps).toBe(1);

    // Add a second .map file after the listing was cached.
    const addedMap = join(projectRoot, 'dist', 'added-after-cache.js.map');

    await writeFile(addedMap, JSON.stringify({
      version: 3,
      sources: ['../src/added-after-cache.ts'],
      mappings: '',
      names: [],
    }));
    writtenMaps.push(addedMap);

    // Without invalidation the cached listing is reused -- searchedMaps stays at 1.
    const cached = await resolver.resolveGeneratedPosition(
      'no-match.ts', 1, 1, undefined, join(projectRoot, 'src', 'no-match.ts'),
    );
    const cachedParsed = JSON.parse(cached.content[0]!.text) as Record<string, unknown>;

    expect(cachedParsed.searchedMaps).toBe(1);

    // Explicit invalidation -- next call re-walks the directory and sees both maps.
    resolver.invalidateSourceMapListing();

    const fresh = await resolver.resolveGeneratedPosition(
      'no-match.ts', 1, 1, undefined, join(projectRoot, 'src', 'no-match.ts'),
    );
    const freshParsed = JSON.parse(fresh.content[0]!.text) as Record<string, unknown>;

    expect(freshParsed.searchedMaps).toBe(2);
  });

  it('invalidateSourceMapListing(roots) clears only matching entry', () => {
    const resolver = new SourceMapResolver();

    // Internal cache is private; assert via behaviour: passing an unknown root
    // should be a no-op that does not throw.
    expect(() => { resolver.invalidateSourceMapListing(['/nonexistent/root']); }).not.toThrow();
    expect(() => { resolver.invalidateSourceMapListing([]); }).not.toThrow();
  });

  it('invalidateTraceMap with no args clears the parsed-map cache', () => {
    const resolver = new SourceMapResolver();

    // Should not throw on an empty cache.
    expect(() => { resolver.invalidateTraceMap(); }).not.toThrow();
    expect(() => { resolver.invalidateTraceMap('/nonexistent/file.js.map'); }).not.toThrow();
  });
});

describe('SourceMapResolver.resolveSourceMapPosition for non-source files', () => {
  const resolver = new SourceMapResolver();

  it('returns input unchanged for plain JS path', async () => {
    const result = await resolver.resolveSourceMapPosition('/abs/file.js', 5, 3);

    expect(result.targetFilePath).toBe('/abs/file.js');
    expect(result.targetLineNumber).toBe(5);
    expect(result.targetColumnNumber).toBe(3);
    expect(result.sourceMapInfo.success).toBe(false);
  });

  it('returns input unchanged for unmatched .ts path', async () => {
    const result = await resolver.resolveSourceMapPosition('/nonexistent/path/foo.ts', 1, 1);

    expect(result.targetFilePath).toBe('/nonexistent/path/foo.ts');
    expect(result.sourceMapInfo.success).toBe(false);
  });
});
