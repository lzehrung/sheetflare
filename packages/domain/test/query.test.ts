import { describe, expect, it } from 'vitest';
import { buildFilterSql, validateFilterCapabilities } from '../src';
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
