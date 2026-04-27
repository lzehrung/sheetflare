import { describe, expect, it } from 'vitest';
import { normalizeRowValues, parseManagedRowId, pickKnownColumns } from '../src';

describe('normalizeRowValues', () => {
  it('trims keys and drops blank names', () => {
    expect(
      normalizeRowValues({
        ' name ': 'Ada',
        '': 'ignored',
        '  ': 'ignored',
        email: 'ada@example.com'
      })
    ).toEqual({
      name: 'Ada',
      email: 'ada@example.com'
    });
  });
});

describe('parseManagedRowId', () => {
  it('trims string row ids before returning them', () => {
    expect(parseManagedRowId('  row-1  ')).toEqual({
      ok: true,
      rowId: 'row-1'
    });
  });
});

describe('pickKnownColumns', () => {
  it('splits known and ignored keys', () => {
    expect(
      pickKnownColumns(
        {
          name: 'Ada',
          email: 'ada@example.com',
          extra: true
        },
        ['name', 'email']
      )
    ).toEqual({
      values: {
        name: 'Ada',
        email: 'ada@example.com'
      },
      ignoredKeys: ['extra']
    });
  });
});
