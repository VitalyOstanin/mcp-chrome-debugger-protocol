// Shared logpoint helpers used by both the live runtime path (binding-based) and
// the simulated test path. Centralising them here removes a long-standing
// duplication between createLogpointExpression and simulateLogpointHit and keeps
// placeholder syntax consistent in one place.

import safeStringify from "safe-stable-stringify";

const PLACEHOLDER_RE = /\{([^}]+)\}/g;

/**
 * Extract unique placeholder expressions from a logpoint message body.
 *
 * Limitation: the parser does not handle nested braces inside an expression
 * (e.g. `{user.profile ?? { default: 1 }}`). Such expressions truncate at the
 * first `}`. This matches the runtime evaluator below; document at the schema
 * level if richer syntax is needed.
 */
export function extractLogpointPlaceholders(message: string): string[] {
  const matches = message.match(PLACEHOLDER_RE) ?? [];

  return Array.from(new Set(
    matches
      .map((m) => m.slice(1, -1).trim())
      .filter(Boolean),
  ));
}

/**
 * Build a JS expression for `Debugger.setBreakpoint` `condition`. When run in
 * the debuggee, the expression sends a `__mcpLogPoint` binding payload with the
 * rendered message and per-placeholder values, then returns false (never pause).
 *
 * Exception to the project-wide ban on JSON.stringify: the literal `JSON.stringify`
 * tokens below are emitted into the debuggee runtime (via CDP setBreakpoint
 * condition / Runtime.evaluate). safe-stable-stringify is not available in the
 * debuggee process, so the standard JSON global is the only stable choice here.
 * Adapter-side serialization continues to use safeStringify.
 */
export function buildLogpointExpression(logMessage: string): string {
  const exprs = extractLogpointPlaceholders(logMessage);
  const varsEntries = exprs.map((expr) => {
    const key = expr.replace(/"/g, '\\"');

    // IIFE with try/catch guards ReferenceErrors and other runtime failures so
    // a single broken placeholder does not silently kill the whole logpoint.
    return `"${key}":(()=>{try{return ${expr}}catch(_){return undefined}})()`;
  }).join(',');
  // Escaping order matters:
  //   1. backslash first  -- so subsequent passes don't double-escape inserted '\'
  //   2. backtick         -- closes the template literal we wrap below
  //   3. literal '$'      -- otherwise user-supplied "${...}" would be parsed as
  //                          a template interpolation by the runtime (the regex
  //                          below only handles bare "{...}" placeholders)
  //   4. {expr} placeholders -> "${...}" referring to the precomputed __vars map
  const tpl = logMessage
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(PLACEHOLDER_RE, (_m, expr: string) => {
      const key = expr.trim().replace(/"/g, '\\"');

      return `\${typeof __vars["${key}"]==="object"?JSON.stringify(__vars["${key}"]):__vars["${key}"]}`;
    });

  return `(()=>{try{const __vars={${varsEntries}};typeof __mcpLogPoint==='function'&&__mcpLogPoint(JSON.stringify({message:\`${tpl}\`,vars:__vars,time:Date.now()}))}catch(_){};return false})()`;
}

/**
 * Render a logpoint message against a static variables map (no debuggee
 * involvement). Used by the simulated logpoint path in tests; mirrors the
 * runtime path so live and simulated paths stay observationally consistent.
 *
 * Object values are JSON-stringified (matching the runtime expression);
 * primitives are coerced via String().
 */
export function renderLogpointMessage(logMessage: string, vars: Record<string, unknown>): string {
  return logMessage.replace(PLACEHOLDER_RE, (_m, expression: string) => {
    const key = expression.trim();
    const val = vars[key];

    if (val !== null && typeof val === 'object') {
      // safe-stable-stringify handles cycles by returning '[Circular]' instead
      // of throwing, which JSON.stringify can't do without a custom replacer.
      return safeStringify(val);
    }

    return String(val);
  });
}

/**
 * Resolve a dotted-path placeholder against a variables map without throwing.
 * Errors collapse to undefined, matching the runtime expression's try/catch
 * fallback. Used by the simulated path.
 */
export function lookupDottedPath(expr: string, variables: Record<string, unknown>): unknown {
  const parts = expr.split('.');

  // Stop descent on scalar intermediates so {a.b.c} renders undefined the same
  // way as optional chaining: `(0)['x']` is undefined in JS, but treating `0`
  // like a Record still hides that the path broke at a scalar.
  return parts.reduce<unknown>(
    (acc, part) => (acc !== null && typeof acc === 'object'
      ? (acc as Record<string, unknown>)[part]
      : undefined),
    variables,
  );
}
