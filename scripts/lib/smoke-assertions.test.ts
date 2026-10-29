import { describe, expect, it } from 'vitest';
import type { FieldRules } from '@sheetflare/contracts';
import { parseSheetCellValue, serializeSheetCell } from '@sheetflare/google-sheets';
import { assertReadinessChecksOk, assertUpdatedValuesPersisted, findUnpersistedValues } from './smoke-assertions';
import { ScriptError } from './runtime';

describe('findUnpersistedValues', () => {
  it('returns nothing when every configured update persisted', () => {
    expect(findUnpersistedValues(
      { _id: 'smoke-1', name: 'Smoke Row Updated', status: 'active' },
      { name: 'Smoke Row Updated' }
    )).toEqual([]);
  });

  it('flags a PATCH that returned 200 without changing the row (a no-op update)', () => {
    expect(findUnpersistedValues(
      { _id: 'smoke-1', name: 'Smoke Row', status: 'active' },
      { name: 'Smoke Row Updated' }
    )).toEqual([{ field: 'name', expected: 'Smoke Row Updated', actual: 'Smoke Row' }]);
  });

  it('flags every field that did not persist, including ones missing from the row', () => {
    expect(findUnpersistedValues(
      { _id: 'smoke-1', name: 'Smoke Row Updated' },
      { name: 'Smoke Row Updated', status: 'archived', score: 7 }
    )).toEqual([
      { field: 'status', expected: 'archived', actual: undefined },
      { field: 'score', expected: 7, actual: undefined }
    ]);
  });

  it('accepts sheet-typed primitives that stringify to the configured value', () => {
    expect(findUnpersistedValues({ count: '7', active: 'true' }, { count: 7, active: true })).toEqual([]);
  });

  it('does not coerce structurally different values', () => {
    expect(findUnpersistedValues({ tags: 'a,b' }, { tags: ['a', 'b'] })).toHaveLength(1);
  });

  it('expects a trim and lowercase field rule to persist the normalized string', () => {
    const fieldRules: FieldRules = { name: { normalize: ['trim', 'lowercase'] } };
    expect(findUnpersistedValues(
      { name: 'alice' },
      { name: ' Alice ' },
      fieldRules
    )).toEqual([]);
    expect(findUnpersistedValues(
      { name: ' Alice ' },
      { name: ' Alice ' },
      fieldRules
    )).toEqual([{ field: 'name', expected: 'alice', actual: ' Alice ' }]);
  });

  it('expects an array to persist as the sheets JSON text', () => {
    const persisted = parseSheetCellValue(serializeSheetCell(['a', 'b']));
    expect(findUnpersistedValues({ tags: persisted }, { tags: ['a', 'b'] })).toEqual([]);
  });

  it('expects a number to persist through sheets serialization', () => {
    const persisted = parseSheetCellValue(serializeSheetCell(7));
    expect(findUnpersistedValues({ count: persisted }, { count: 7 })).toEqual([]);
    expect(findUnpersistedValues({ count: '7' }, { count: 7 })).toEqual([]);
    expect(findUnpersistedValues({ count: '8' }, { count: 7 })).toEqual([
      { field: 'count', expected: 7, actual: '8' }
    ]);
  });
});

describe('assertUpdatedValuesPersisted', () => {
  it('throws a ScriptError naming the stage and every unpersisted field', () => {
    expect(() => assertUpdatedValuesPersisted(
      { _id: 'smoke-1', name: 'Smoke Row', status: 'active' },
      { name: 'Smoke Row Updated', status: 'archived' },
      'after the update'
    )).toThrow(ScriptError);
    expect(() => assertUpdatedValuesPersisted(
      { _id: 'smoke-1', name: 'Smoke Row', status: 'active' },
      { name: 'Smoke Row Updated', status: 'archived' },
      'after the update'
    )).toThrow(/after the update.*name.*status/s);
  });

  it('passes silently when the update persisted', () => {
    expect(() => assertUpdatedValuesPersisted({ name: 'x' }, { name: 'x' }, 'after the update')).not.toThrow();
  });
});

describe('assertReadinessChecksOk', () => {
  it('reports nothing verified and does not throw when /ready omitted the detailed checks', () => {
    expect(assertReadinessChecksOk(undefined)).toBe(false);
  });

  it('reports verified when every detailed check is ok', () => {
    expect(assertReadinessChecksOk({ controlPlane: 'ok', rateLimit: 'ok' })).toBe(true);
  });

  it('throws when the control plane reports a failure', () => {
    expect(() => assertReadinessChecksOk({ controlPlane: 'error', rateLimit: 'ok' })).toThrow(/control-plane failure/);
  });

  it('throws when the rate limiter reports a failure', () => {
    expect(() => assertReadinessChecksOk({ controlPlane: 'ok', rateLimit: 'error' })).toThrow(/rate-limit failure/);
  });
});
