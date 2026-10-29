import { isDeepStrictEqual } from 'node:util';
import { ScriptError } from './runtime';

export type UnpersistedValue = {
  field: string;
  expected: unknown;
  actual: unknown;
};

function isPrimitive(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Sheets are stringly typed, so a configured `7` or `true` may read back as `"7"` or `"true"`.
 * Primitives therefore compare by string form; arrays and objects must match structurally.
 */
function valuesMatch(expected: unknown, actual: unknown) {
  if (isDeepStrictEqual(expected, actual)) {
    return true;
  }

  return isPrimitive(expected) && isPrimitive(actual) && String(expected) === String(actual);
}

export function findUnpersistedValues(
  rowValues: Record<string, unknown>,
  expectedValues: Record<string, unknown>
): UnpersistedValue[] {
  return Object.entries(expectedValues)
    .filter(([field, expected]) => !valuesMatch(expected, rowValues[field]))
    .map(([field, expected]) => ({ field, expected, actual: rowValues[field] }));
}

export function assertUpdatedValuesPersisted(
  rowValues: Record<string, unknown>,
  expectedValues: Record<string, unknown>,
  stage: string
) {
  const unpersisted = findUnpersistedValues(rowValues, expectedValues);
  if (unpersisted.length === 0) {
    return;
  }

  const details = unpersisted
    .map((entry) => `${entry.field} (expected ${JSON.stringify(entry.expected)}, read ${JSON.stringify(entry.actual) ?? 'nothing'})`)
    .join('; ');
  throw new ScriptError(`Smoke row update did not persist ${stage}: ${details}.`);
}
