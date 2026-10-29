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

  it('accepts a configured boolean that Sheets reads back as its formatted TRUE/FALSE text', () => {
    expect(findUnpersistedValues({ active: 'TRUE', archived: 'FALSE' }, { active: true, archived: false })).toEqual([]);
  });

  it('still flags a configured boolean that reads back as the opposite formatted value', () => {
    expect(findUnpersistedValues({ active: 'FALSE' }, { active: true })).toHaveLength(1);
  });

  it('compares a configured string "TRUE" as a string, not as a boolean', () => {
    expect(findUnpersistedValues({ label: 'TRUE' }, { label: 'TRUE' })).toEqual([]);
    expect(findUnpersistedValues({ label: 'true' }, { label: 'TRUE' })).toHaveLength(1);
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

  it('reads a configured field name with surrounding whitespace back under its trimmed name', () => {
    expect(findUnpersistedValues({ name: 'Smoke Row Updated' }, { ' name ': 'Smoke Row Updated' })).toEqual([]);
  });

  it('applies a field rule to a configured field name with surrounding whitespace, as the write path does', () => {
    const fieldRules: FieldRules = { email: { normalize: ['trim', 'lowercase'] } };
    expect(findUnpersistedValues({ email: 'alice' }, { ' email ': ' Alice ' }, fieldRules)).toEqual([]);
    expect(findUnpersistedValues({ email: ' Alice ' }, { ' email ': ' Alice ' }, fieldRules)).toEqual([
      { field: 'email', expected: 'alice', actual: ' Alice ' }
    ]);
  });

  it('finds a field rule keyed by a padded name, since rule names are trimmed the same way', () => {
    expect(findUnpersistedValues({ email: 'alice' }, { email: ' Alice ' }, { ' email ': { normalize: ['trim', 'lowercase'] } })).toEqual([]);
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

  it('accepts a configured number that Sheets reads back with grouping or a currency symbol', () => {
    expect(findUnpersistedValues({ amount: '1,234' }, { amount: 1234 })).toEqual([]);
    expect(findUnpersistedValues({ amount: '$1,234.00' }, { amount: 1234 })).toEqual([]);
    expect(findUnpersistedValues({ amount: '1\u00A0234' }, { amount: 1234 })).toEqual([]);
    expect(findUnpersistedValues({ amount: '1\u202F234' }, { amount: 1234 })).toEqual([]);
    expect(findUnpersistedValues({ amount: '1234' }, { amount: 1234 })).toEqual([]);
  });

  it('still flags a configured number whose read-back is another number, a percentage, or empty', () => {
    expect(findUnpersistedValues({ amount: '1,235' }, { amount: 1234 })).toHaveLength(1);
    expect(findUnpersistedValues({ amount: '12.34%' }, { amount: 1234 })).toHaveLength(1);
    expect(findUnpersistedValues({ amount: '' }, { amount: 0 })).toHaveLength(1);
    expect(findUnpersistedValues({ amount: '$' }, { amount: 0 })).toHaveLength(1);
  });

  it('does not read decimal-comma or misgrouped text as a grouped number', () => {
    expect(findUnpersistedValues({ amount: '12,34' }, { amount: 1234 })).toHaveLength(1);
    expect(findUnpersistedValues({ amount: '1,23,4' }, { amount: 1234 })).toHaveLength(1);
    expect(findUnpersistedValues({ amount: '1 2 3 4' }, { amount: 1234 })).toHaveLength(1);
    expect(findUnpersistedValues({ amount: '1234,5' }, { amount: 12345 })).toHaveLength(1);
    expect(findUnpersistedValues({ amount: '-$1,234,567.50' }, { amount: -1234567.5 })).toEqual([]);
  });

  it('compares a configured string with grouping exactly, not as a number', () => {
    expect(findUnpersistedValues({ code: '1,234' }, { code: '1,234' })).toEqual([]);
    expect(findUnpersistedValues({ code: '1234' }, { code: '1,234' })).toHaveLength(1);
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

  it('says numbers are compared after removing grouping and currency symbols when a numeric value does not persist', () => {
    expect(() => assertUpdatedValuesPersisted({ amount: '12.34%' }, { amount: 1234 }, 'after the update'))
      .toThrow(/removing grouping and currency symbols.*plain number formatting/s);
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
