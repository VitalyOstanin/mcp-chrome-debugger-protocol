import { describe, expect, it } from 'vitest';
import {
  buildLogpointExpression,
  extractLogpointPlaceholders,
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

describe('buildLogpointExpression injection hardening', () => {
  // The generated JS is interpolated into a CDP Debugger.setBreakpoint
  // `condition`. The runtime must:
  //   1. Run the IIFE successfully even when the user-supplied logMessage
  //      contains characters that look like JS source (backticks, ${...},
  //      backslashes, quotes).
  //   2. Carry the literal characters back through the __mcpLogPoint payload
  //      as part of `message`, not as evaluated JS.
  // Each case below builds the IIFE, evaluates it in a `new Function` sandbox,
  // and asserts both that no exception escapes and that the rendered message
  // equals the literal input minus the {placeholder} substitutions.
  const runExprSafely = (logMessage: string, vars: Record<string, unknown> = {}): {
    message: string;
    vars: Record<string, unknown>;
    rawSource: string;
  } => {
    const exprSrc = buildLogpointExpression(logMessage);
    const calls: string[] = [];
    const argNames = ['__mcpLogPoint', ...Object.keys(vars)];
    const argValues: unknown[] = [(s: string) => { calls.push(s); }, ...Object.values(vars)];
    const fn = new Function(...argNames, `return ${exprSrc}`) as (...a: unknown[]) => boolean;
    const ret = fn(...argValues);

    expect(ret).toBe(false);
    expect(calls).toHaveLength(1);

    const payload = JSON.parse(calls[0]!) as { message: string; vars: Record<string, unknown> };

    return { message: payload.message, vars: payload.vars, rawSource: exprSrc };
  };

  it('escapes a lone $ that is not followed by a placeholder', () => {
    // A bare `$` (no following `{`) must land in the message as literal `$`,
    // not be interpreted as the start of a template interpolation by V8 when
    // it runs the IIFE.
    const { message } = runExprSafely('cost $42');

    expect(message).toBe('cost $42');
  });

  it('rejects backtick-injected template literals in the message body', () => {
    // A naive build would close the wrapping template literal here.
    const { message } = runExprSafely('a `+globalThis.X+` b');

    expect(message).toBe('a `+globalThis.X+` b');
  });

  it('handles a backslash before a backtick (escape-table edge case)', () => {
    const { message } = runExprSafely('x\\`y');

    expect(message).toBe('x\\`y');
  });

  it('handles a backslash before a dollar (escape-table edge case)', () => {
    const { message } = runExprSafely('x\\$y');

    expect(message).toBe('x\\$y');
  });

  it('handles a literal $-not-placeholder inside a longer message body', () => {
    // Confirms the escape of bare `$` survives surrounding text in both
    // directions; nothing should be evaluated by the IIFE.
    const { message } = runExprSafely('price was $100 then $200');

    expect(message).toBe('price was $100 then $200');
  });

  it('handles double-quote inside a placeholder expression without breaking the IIFE', () => {
    // Old positional-key design risk: if the key escape were quotes-only,
    // a `\` before `"` would have closed the key string. Wire format keys are
    // JSON.stringify-quoted at build time so they survive any inner quotes.
    const { message, vars } = runExprSafely('value={obj["k"]}', {
      obj: { k: 42 },
    });

    expect(message).toBe('value=42');
    expect(vars).toEqual({ 'obj["k"]': 42 });
  });

  it('handles backslash inside a string-valued placeholder without breaking the IIFE', () => {
    // String values flow through JSON.stringify in the runtime payload; a
    // backslash inside the value must round-trip without breaking the
    // surrounding template.
    const { message, vars } = runExprSafely('s={s}', { s: 'a\\b' });

    expect(message).toBe('s=a\\b');
    expect(vars).toEqual({ s: 'a\\b' });
  });

  it('returns undefined for a placeholder expression that throws at evaluation time', () => {
    // The IIFE wraps each expression in try/catch returning undefined. A
    // crafted expression that throws via a thrower function must still resolve
    // to undefined and the whole logpoint must run cleanly.
    const { vars } = runExprSafely('value={t()}', {
      t() { throw new Error('boom'); },
    });

    expect(vars).toEqual({ 't()': undefined });
  });

  it('preserves a literal {} segment (no expression inside) after escape rules', () => {
    // Stand-alone braces with no matching expr should be left as-is since
    // PLACEHOLDER_RE requires non-empty content.
    const { message } = runExprSafely('a {} b');

    expect(message).toBe('a {} b');
  });

  it('drops whitespace-only placeholders silently (defensive idx===-1 branch)', () => {
    // PLACEHOLDER_RE matches `{ }` (single space inside braces), but
    // extractLogpointPlaceholders trims and filters empty strings, leaving
    // exprs=[]. The replace callback then sees expr=' ', trims to '', and
    // exprs.indexOf('') returns -1, falling through to the defensive `return ''`
    // guard. This documents that the two regex passes can drift in edge cases
    // and the build does not crash when it happens.
    const { message, vars } = runExprSafely('a { } b');

    expect(message).toBe('a  b');
    expect(vars).toEqual({});
  });

  it('source uses positional keys exclusively for __vars lookups regardless of input', () => {
    // Source-level check: the positional design must keep every __vars lookup
    // restricted to the __vN identifier pattern even when the placeholder
    // text contains characters that would once have been mis-escaped.
    const exprSrc = buildLogpointExpression('z={x.y}');

    expect(exprSrc).not.toMatch(/__vars\["[^"]/);
    expect(exprSrc).toMatch(/__vars\.__v0/);
  });
});
