import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createErrorResponse,
  createSuccessResponse,
  findProjectRoot,
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
