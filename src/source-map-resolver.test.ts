import { describe, expect, it } from 'vitest';
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
