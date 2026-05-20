import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createErrorResponse,
  createSuccessResponse,
  findProjectRoot,
  mapWithConcurrency,
  sleep,
  withErrorHandling,
} from './utils.js';

describe('createSuccessResponse', () => {
  it('wraps data in MCP response with success=true', () => {
    const response = createSuccessResponse({ value: 42 });

    expect(response.content).toHaveLength(1);
    expect(response.content[0]!.type).toBe('text');

    const parsed = JSON.parse(response.content[0]!.text);

    expect(parsed).toEqual({ success: true, data: { value: 42 } });
  });
});

describe('createErrorResponse', () => {
  it('serialises error with default code', () => {
    const response = createErrorResponse('boom');
    const parsed = JSON.parse(response.content[0]!.text);

    expect(parsed).toEqual({ success: false, error: 'boom', code: 'TOOL_ERROR' });
  });

  it('omits absent message and details from the payload', () => {
    const response = createErrorResponse('e');
    const parsed = JSON.parse(response.content[0]!.text);

    expect('message' in parsed).toBe(false);
    expect('details' in parsed).toBe(false);
  });

  it('includes message, code and details when provided', () => {
    const response = createErrorResponse('e', 'why', 'CUSTOM', { id: 1 });
    const parsed = JSON.parse(response.content[0]!.text);

    expect(parsed).toEqual({
      success: false,
      error: 'e',
      message: 'why',
      code: 'CUSTOM',
      details: { id: 1 },
    });
  });
});

describe('withErrorHandling', () => {
  it('returns success response when operation resolves', async () => {
    const response = await withErrorHandling(async () => ({ ok: true }), { operation: 'noop' });
    const parsed = JSON.parse(response.content[0]!.text);

    expect(parsed).toEqual({ success: true, data: { ok: true } });
  });

  it('wraps thrown Error with cause and context', async () => {
    const response = await withErrorHandling(async () => {
      throw new Error('kaboom');
    }, { operation: 'fail', extra: 'ctx' });
    const parsed = JSON.parse(response.content[0]!.text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Failed to fail');
    expect(parsed.message).toBe('kaboom');
    expect(parsed.code).toBe('OPERATION_FAILED');
    expect(parsed.details).toEqual({ operation: 'fail', extra: 'ctx' });
  });

  it('coerces non-Error throw values to string in message', async () => {
    const response = await withErrorHandling(async () => {
      throw 'plain string';
    }, { operation: 'noop' });
    const parsed = JSON.parse(response.content[0]!.text);

    expect(parsed.message).toBe('plain string');
  });
});

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    const start = Date.now();

    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe('findProjectRoot', () => {
  it('finds the directory containing package.json walking upward', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mcp-cdp-'));

    try {
      const root = await mkdtemp(join(base, 'root-'));
      const sub = join(root, 'a', 'b', 'c');

      await mkdir(sub, { recursive: true });
      await writeFile(join(root, 'package.json'), '{}');
      expect(findProjectRoot(sub)).toBe(root);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns null when no package.json is found upward', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mcp-cdp-noroot-'));

    try {
      // Use a separate workspace with no package.json above.
      const sub = join(base, 'isolated', 'inner');

      await mkdir(sub, { recursive: true });

      // Walk only within `base` -- a test cannot guarantee the absence of
      // package.json on the entire path up to /, so pass an isolated subtree
      // and limit expectations: result must be the base if a package.json is
      // present somewhere above tmpdir, otherwise null. Both outcomes prove
      // the algorithm walks upward; we assert it never throws and returns a
      // string|null.
      const result = findProjectRoot(sub);

      expect(result === null || typeof result === 'string').toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('memoises the result for the same startDir', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mcp-cdp-memo-'));

    try {
      const sub = join(base, 'x');

      await mkdir(sub, { recursive: true });
      await writeFile(join(base, 'package.json'), '{}');

      const first = findProjectRoot(sub);

      // Remove file and verify cached result is reused.
      await rm(join(base, 'package.json'));

      const second = findProjectRoot(sub);

      expect(second).toBe(first);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    // Larger items resolve sooner, so completion order is reversed relative to
    // input order. Result array must still match the input order.
    const input = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(input, 3, async (n) => {
      await sleep(20 - n * 3);

      return n * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('returns empty array for empty input', async () => {
    let called = 0;
    const results = await mapWithConcurrency<number, number>([], 4, async (n) => {
      called++;

      return n;
    });

    expect(results).toEqual([]);
    expect(called).toBe(0);
  });

  it('caps in-flight invocations at limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const input = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapWithConcurrency(input, 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;

      return n;
    });

    expect(results).toEqual(input);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // some parallelism actually happened
  });

  it('does not spawn more workers than there are items', async () => {
    // limit=8, 2 items -> only 2 worker iterations should run.
    let starts = 0;
    const results = await mapWithConcurrency([1, 2], 8, async (n) => {
      starts++;
      await sleep(2);

      return n * 2;
    });

    expect(results).toEqual([2, 4]);
    expect(starts).toBe(2);
  });

  it('propagates rejections from the worker fn', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');

        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('throws when limit is not a positive integer', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/limit must be > 0/);
    await expect(mapWithConcurrency([1], -1, async (n) => n)).rejects.toThrow(/limit must be > 0/);
  });

  it('passes the original index to the worker fn', async () => {
    const seen: Array<{ item: string; index: number }> = [];
    const results = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => {
      seen.push({ item, index });

      return `${item}:${index}`;
    });

    expect(results).toEqual(['a:0', 'b:1', 'c:2']);
    // Index pairing must match the input position, regardless of execution order.
    expect(seen.sort((x, y) => x.index - y.index)).toEqual([
      { item: 'a', index: 0 },
      { item: 'b', index: 1 },
      { item: 'c', index: 2 },
    ]);
  });
});
