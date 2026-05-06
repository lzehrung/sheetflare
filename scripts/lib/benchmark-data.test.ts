import { describe, expect, it } from 'vitest';
import { buildBenchmarkRow, buildBenchmarkRowId, chooseBenchmarkFields } from './benchmark-data';

describe('benchmark data helpers', () => {
  it('builds deterministic benchmark row ids', () => {
    expect(buildBenchmarkRowId(42)).toBe('bench-0000042');
  });

  it('chooses sort and contains fields from a writable benchmark schema', () => {
    const plan = chooseBenchmarkFields({
      idColumn: '_id',
      indexedFields: ['_id', 'name', 'status'],
      readOnlyFields: [],
      fieldRules: {
        score: {
          type: 'number'
        }
      }
    }, ['_id', 'name', 'status', 'score', 'notes']);

    expect(plan).toMatchObject({
      sortField: 'name',
      containsField: 'name',
      numericField: 'score'
    });
  });

  it('generates row values aligned to field rules and heuristics', () => {
    const row = buildBenchmarkRow(['_id', 'name', 'status', 'score', 'createdAt'], 3, {
      idColumn: '_id',
      readOnlyFields: [],
      fieldRules: {
        score: {
          type: 'number'
        },
        createdAt: {
          type: 'datetime'
        }
      }
    });

    expect(row).toMatchObject({
      _id: 'bench-0000003',
      name: 'name-0000003',
      status: 'pending',
      score: 3,
      createdAt: expect.stringMatching(/^2026-01-0[1-9]T/)
    });
  });
});
