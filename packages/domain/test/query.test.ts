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
    expect(result.joinParameters).toEqual(['status', 'score']);
    expect(result.conditionParameters).toEqual(['active', 10, 20]);
    expect(result.parameters).toEqual(['status', 'score', 'active', 10, 20]);
  });

  it('keeps user-controlled field names and values out of generated SQL text', () => {
    const suspiciousField = "status') OR 1=1 --";
    const suspiciousValue = "active' OR '1'='1";
    const result = buildFilterSql(
      {
        [suspiciousField]: { eq: suspiciousValue }
      },
      [suspiciousField]
    );

    expect(result.joins.join(' ')).not.toContain(suspiciousField);
    expect(result.conditions.join(' ')).not.toContain(suspiciousValue);
    expect(result.joinParameters).toEqual([suspiciousField]);
    expect(result.conditionParameters).toEqual([suspiciousValue]);
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

  it('escapes literal wildcard characters in string filters', () => {
    const result = buildFilterSql(
      {
        name: { startsWith: 'a_%\\' }
      },
      ['name']
    );

    expect(result.conditions).toContain("cf0.value_kind = 'string' AND cf0.value_text LIKE ? ESCAPE '\\'");
    expect(result.joinParameters).toEqual(['name']);
    expect(result.conditionParameters).toEqual(['a\\_\\%\\\\%']);
    expect(result.parameters).toEqual(['name', 'a\\_\\%\\\\%']);
  });

  it('treats neq as not-equal across kinds instead of same-kind only', () => {
    const result = buildFilterSql(
      {
        score: { neq: 10 }
      },
      ['score']
    );

    expect(result.conditions).toContain("(cf0.value_kind != 'number' OR cf0.value_number != ?)");
    expect(result.joinParameters).toEqual(['score']);
    expect(result.conditionParameters).toEqual([10]);
    expect(result.parameters).toEqual(['score', 10]);
  });

  it('handles null equality and inequality explicitly', () => {
    const result = buildFilterSql(
      {
        rowNumber: { neq: null },
        id: { eq: null },
        score: { eq: null }
      },
      ['score']
    );

    expect(result.conditions).toEqual([
      'cr.row_number IS NOT NULL',
      'cr.row_id IS NULL',
      "cf2.value_kind = 'null'"
    ]);
    expect(result.joinParameters).toEqual(['score']);
    expect(result.conditionParameters).toEqual([]);
    expect(result.parameters).toEqual(['score']);
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

  it('uses stable binary string ordering', () => {
    expect(compareQueryValues('ab1', 'a_1')).toBeGreaterThan(0);
    expect(compareQueryValues('B', 'a')).toBeLessThan(0);
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
    expect(compareRangeQueryValues('10', '2')).toBeLessThan(0);
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
