import { isDeepStrictEqual } from 'node:util';
import { rowRecordSchema, type FieldRules } from '@sheetflare/contracts';
import { applyFieldRuleNormalization, coerceFieldRuleValue } from '@sheetflare/domain';
import { parseSheetCellValue, serializeSheetCell } from '@sheetflare/google-sheets';
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
 * Sheets are stringly typed, so a configured `7` may read back as `"7"`. Primitives therefore compare
 * by string form; arrays and objects must match structurally. A configured boolean is the one exception:
 * formatted Sheets reads return `TRUE`/`FALSE`, which the system's boolean coercion maps back.
 */
function valuesMatch(expected: unknown, actual: unknown) {
  if (isDeepStrictEqual(expected, actual)) {
    return true;
  }

  if (typeof expected === 'boolean' && typeof actual === 'string') {
    return coerceFieldRuleValue(actual, { type: 'boolean' }) === expected;
  }

  return isPrimitive(expected) && isPrimitive(actual) && String(expected) === String(actual);
}

/**
 * The value a successful write leaves in the sheet: field-rule normalization, then the same
 * cell serialization the Sheets adapter uses. Arrays come back as JSON text.
 */
function persistedExpectations(
  expectedValues: Record<string, unknown>,
  fieldRules: FieldRules | undefined
): Record<string, unknown> {
  const parsed = rowRecordSchema.safeParse(expectedValues);
  if (!parsed.success) {
    return expectedValues;
  }

  const normalized = applyFieldRuleNormalization(parsed.data, fieldRules);
  const persisted: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(normalized)) {
    persisted[field] = parseSheetCellValue(serializeSheetCell(value));
  }
  return persisted;
}

export function findUnpersistedValues(
  rowValues: Record<string, unknown>,
  expectedValues: Record<string, unknown>,
  fieldRules?: FieldRules
): UnpersistedValue[] {
  const persisted = persistedExpectations(expectedValues, fieldRules);
  return Object.entries(persisted)
    .filter(([field, expected]) => !valuesMatch(expected, rowValues[field]))
    .map(([field, expected]) => ({ field, expected, actual: rowValues[field] }));
}

export function assertUpdatedValuesPersisted(
  rowValues: Record<string, unknown>,
  expectedValues: Record<string, unknown>,
  stage: string,
  fieldRules?: FieldRules
) {
  const unpersisted = findUnpersistedValues(rowValues, expectedValues, fieldRules);
  if (unpersisted.length === 0) {
    return;
  }

  const details = unpersisted
    .map((entry) => `${entry.field} (expected ${JSON.stringify(entry.expected)}, read ${JSON.stringify(entry.actual) ?? 'nothing'})`)
    .join('; ');
  throw new ScriptError(`Smoke row update did not persist ${stage}: ${details}.`);
}

export type ReadinessChecks = {
  controlPlane: string;
  rateLimit: string;
};

/**
 * `/ready` returns detailed checks only to callers with admin:projects global scope.
 * Returns false when the checks were omitted (nothing verified); throws when a reported check is not `ok`.
 */
export function assertReadinessChecksOk(checks: ReadinessChecks | undefined): boolean {
  if (!checks) {
    return false;
  }
  if (checks.controlPlane !== 'ok') {
    throw new ScriptError('Readiness check reported control-plane failure.');
  }
  if (checks.rateLimit !== 'ok') {
    throw new ScriptError('Readiness check reported rate-limit failure.');
  }
  return true;
}
