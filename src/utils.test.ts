import { describe, expect, it } from 'vitest';
import {
  ERROR_MESSAGES,
  createErrorResponse,
  createSuccessResponse,
  requireConnection,
  withErrorHandling,
} from './utils.js';

describe('createSuccessResponse', () => {
  it('wraps data in MCP response with success=true', () => {
    const response = createSuccessResponse({ value: 42 });

    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');

    const parsed = JSON.parse(response.content[0].text);

    expect(parsed).toEqual({ success: true, data: { value: 42 } });
  });
});

describe('createErrorResponse', () => {
  it('serialises error with default code', () => {
    const response = createErrorResponse('boom');
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed).toEqual({ success: false, error: 'boom', code: 'TOOL_ERROR' });
  });

  it('omits absent message and details from the payload', () => {
    const response = createErrorResponse('e');
    const parsed = JSON.parse(response.content[0].text);

    expect('message' in parsed).toBe(false);
    expect('details' in parsed).toBe(false);
  });

  it('includes message, code and details when provided', () => {
    const response = createErrorResponse('e', 'why', 'CUSTOM', { id: 1 });
    const parsed = JSON.parse(response.content[0].text);

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
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed).toEqual({ success: true, data: { ok: true } });
  });

  it('wraps thrown Error with cause and context', async () => {
    const response = await withErrorHandling(async () => {
      throw new Error('kaboom');
    }, { operation: 'fail', extra: 'ctx' });
    const parsed = JSON.parse(response.content[0].text);

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
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.message).toBe('plain string');
  });
});

describe('requireConnection', () => {
  it('throws when not connected', () => {
    expect(() => {
      requireConnection(false);
    }).toThrow(ERROR_MESSAGES.NOT_CONNECTED);
  });

  it('does nothing when connected', () => {
    expect(() => {
      requireConnection(true);
    }).not.toThrow();
  });
});
