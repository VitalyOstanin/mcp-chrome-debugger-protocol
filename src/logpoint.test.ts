import { describe, expect, it } from 'vitest';
import {
  buildLogpointExpression,
  extractLogpointPlaceholders,
  lookupDottedPath,
  renderLogpointMessage,
} from './logpoint.js';

describe('extractLogpointPlaceholders', () => {
  it('returns unique trimmed expressions', () => {
    expect(extractLogpointPlaceholders('hi {a} {b} {a}')).toEqual(['a', 'b']);
  });

  it('trims whitespace inside placeholders', () => {
    expect(extractLogpointPlaceholders('x {  user.name }')).toEqual(['user.name']);
  });

  it('returns empty array for messages without placeholders', () => {
    expect(extractLogpointPlaceholders('plain text')).toEqual([]);
  });

  it('drops empty placeholders', () => {
    expect(extractLogpointPlaceholders('a {} b')).toEqual([]);
  });
});

describe('renderLogpointMessage', () => {
  it('substitutes primitives via String()', () => {
    expect(renderLogpointMessage('id={n}', { n: 42 })).toBe('id=42');
  });

  it('JSON.stringifies object values', () => {
    expect(renderLogpointMessage('user={user}', { user: { id: 1 } })).toBe('user={"id":1}');
  });

  it('renders undefined and null explicitly', () => {
    expect(renderLogpointMessage('a={x} b={y}', { x: undefined, y: null })).toBe('a=undefined b=null');
  });

  it('keeps non-placeholder text unchanged', () => {
    expect(renderLogpointMessage('hello world', {})).toBe('hello world');
  });
});

describe('lookupDottedPath', () => {
  it('returns top-level value', () => {
    expect(lookupDottedPath('a', { a: 1 })).toBe(1);
  });

  it('walks nested objects', () => {
    expect(lookupDottedPath('a.b.c', { a: { b: { c: 'x' } } })).toBe('x');
  });

  it('returns undefined when path is missing without throwing', () => {
    expect(lookupDottedPath('a.b.c', { a: {} })).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    expect(lookupDottedPath('a.b', { a: null })).toBeUndefined();
  });
});

describe('buildLogpointExpression', () => {
  it('produces an executable IIFE that hits __mcpLogPoint when present', () => {
    const expr = buildLogpointExpression('hello {x}');
    const calls: string[] = [];
    const runner = new Function(
      '__mcpLogPoint',
      'x',
      `return ${expr}`,
    ) as (binding: (s: string) => void, x: unknown) => boolean;
    const ret = runner((s) => calls.push(s), 7);

    expect(ret).toBe(false);
    expect(calls).toHaveLength(1);

    const payload = JSON.parse(calls[0]!) as { message: string; vars: Record<string, unknown> };

    expect(payload.message).toBe('hello 7');
    expect(payload.vars).toEqual({ x: 7 });
  });

  it('captures undefined for placeholders that throw on access', () => {
    const expr = buildLogpointExpression('{u.v.w}');
    const calls: string[] = [];
    const runner = new Function('__mcpLogPoint', 'u', `return ${expr}`) as (
      binding: (s: string) => void,
      u: unknown,
    ) => boolean;

    runner((s) => calls.push(s), null);

    const payload = JSON.parse(calls[0]!) as { vars: Record<string, unknown> };

    expect(payload.vars).toEqual({ 'u.v.w': undefined });
  });

  it('escapes backticks and dollar signs from user-supplied text', () => {
    const expr = buildLogpointExpression('`hi` $not-a-var');
    const calls: string[] = [];
    const runner = new Function('__mcpLogPoint', `return ${expr}`) as (
      binding: (s: string) => void,
    ) => boolean;

    runner((s) => calls.push(s));

    const payload = JSON.parse(calls[0]!) as { message: string };

    expect(payload.message).toBe('`hi` $not-a-var');
  });

  it('does nothing when __mcpLogPoint is not a function', () => {
    const expr = buildLogpointExpression('x={x}');
    const runner = new Function('__mcpLogPoint', 'x', `return ${expr}`) as (
      binding: unknown,
      x: unknown,
    ) => boolean;
    const ret = runner(undefined, 1);

    expect(ret).toBe(false);
  });

  it('keeps internal lookup positional even when the placeholder expression contains quotes', () => {
    // Regression: the previous design embedded the expr text as a JS string key
    // in __vars[..] and used a quotes-only replace() that ignored backslashes.
    // The positional-key design must not depend on any escape table.
    const expr = buildLogpointExpression('value={a["k"]}');

    // Source-level checks: no occurrence of the raw expression text inside a
    // JS string lookup, and positional keys are used instead.
    expect(expr).toContain('__v0');
    expect(expr).not.toContain('__vars["a[\\"k\\"]"]');
  });
});
