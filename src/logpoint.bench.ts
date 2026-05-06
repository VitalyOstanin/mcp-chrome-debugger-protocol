// Optional micro-benchmarks for logpoint helpers. Run via `npm run bench`.
// These are not part of the unit test gate (vitest separates bench from run);
// they exist so a future change to the placeholder regex / template builder
// can be measured against the current implementation in CI on demand.

import { bench, describe } from 'vitest';
import {
  extractLogpointPlaceholders,
  buildLogpointExpression,
  renderLogpointMessage,
  lookupDottedPath,
} from './logpoint.js';

const SHORT_MESSAGE = 'user={user} action={action} ts={Date.now()}';
const LONG_MESSAGE = Array.from({ length: 32 }, (_, i) => `arg${i}={obj.fields[${i}].value}`).join(' | ');
const VARS: Record<string, unknown> = {
  user: 'alice',
  action: 'login',
  'Date.now()': 1_700_000_000_000,
  obj: { fields: Array.from({ length: 32 }, (_, i) => ({ value: i })) },
};

describe('logpoint helpers', () => {
  bench('extractLogpointPlaceholders (short)', () => {
    extractLogpointPlaceholders(SHORT_MESSAGE);
  });

  bench('extractLogpointPlaceholders (long)', () => {
    extractLogpointPlaceholders(LONG_MESSAGE);
  });

  bench('buildLogpointExpression (short)', () => {
    buildLogpointExpression(SHORT_MESSAGE);
  });

  bench('renderLogpointMessage (short)', () => {
    renderLogpointMessage(SHORT_MESSAGE, VARS);
  });

  bench('lookupDottedPath (deep)', () => {
    lookupDottedPath('obj.fields.0.value', VARS);
  });
});
