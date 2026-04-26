import { describe, expect, it } from 'vitest';
import { buildFilterSql, compareQueryValues, compareRangeQueryValues, sortRows, validateFilterCapabilities } from '../src';
import { BadRequestError } from '@sheetflare/contracts';

describe('buildFilterSql', () => {
  it('builds indexed filter sql', () => {
    const result = buildFilterSql(
      {
        status: { eq: 'active' },
        score: { gte: 10, lt: 20 }
      },
      ['status', 'score', '_id']
    );

    expect(result.joins).toHaveLength(2);
    expect(result.conditions.join(' ')).toContain("value_kind = 'string'");
    expect(result.conditions.join(' ')).toContain("value_kind = 'number'");
    expect(result.parameters).toEqual(['status', 'active', 'score', 10, 20]);
  });

  it('rejects non-indexed filters', () => {
    expect(() =>
      buildFilterSql(
        {
          status: { eq: 'active' }
        },
        ['score']
      )
    ).toThrow(BadRequestError);
  });
});

describe('validateFilterCapabilities', () => {
  it('flags contains as scan-heavy', () => {
    expect(
      validateFilterCapabilities(
        {
          name: { contains: 'ada' }
        },
        ['name']
      )
    ).toEqual({ requiresFullScan: true });
  });
});

describe('compareQueryValues', () => {
  it('uses the same kind ordering as indexed SQL queries', () => {
    expect(compareQueryValues(null, false)).toBeLessThan(0);
    expect(compareQueryValues(false, true)).toBeLessThan(0);
    expect(compareQueryValues(true, 1)).toBeLessThan(0);
    expect(compareQueryValues(2, '2')).toBeLessThan(0);
    expect(compareQueryValues('alpha', ['alpha'])).toBeLessThan(0);
  });
});

describe('compareRangeQueryValues', () => {
  it('rejects mixed-type range comparisons that indexed SQL would not match', () => {
    expect(compareRangeQueryValues(10, '2')).toBeNull();
    expect(compareRangeQueryValues('10', 2)).toBeNull();
    expect(compareRangeQueryValues(true, true)).toBeNull();
    expect(compareRangeQueryValues(['a'], 'a')).toBeNull();
  });

  it('compares matching numeric and string kinds', () => {
    expect(compareRangeQueryValues(10, 2)).toBeGreaterThan(0);
    expect(compareRangeQueryValues('10', '2')).toBeGreaterThan(0);
  });
});

describe('sortRows', () => {
  it('sorts mixed typed values consistently with indexed SQL ordering', () => {
    const rows = sortRows([
      {
        id: 'row-json',
        rowNumber: 5,
        values: {
          value: ['z']
        }
      },
      {
        id: 'row-number',
        rowNumber: 3,
        values: {
          value: 2
        }
      },
      {
        id: 'row-null',
        rowNumber: 1,
        values: {
          value: null
        }
      },
      {
        id: 'row-string',
        rowNumber: 4,
        values: {
          value: '2'
        }
      },
      {
        id: 'row-boolean',
        rowNumber: 2,
        values: {
          value: true
        }
      }
    ], {
      field: 'value',
      direction: 'asc'
    });

    expect(rows.map((row) => row.id)).toEqual([
      'row-null',
      'row-boolean',
      'row-number',
      'row-string',
      'row-json'
    ]);
  });
});
