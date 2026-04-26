import { describe, expect, it } from 'vitest';
import { applyListRowsQuery } from '../src';

const rows = [
  {
    id: 'a',
    rowNumber: 4,
    values: { name: 'Ada', score: 2 }
  },
  {
    id: 'b',
    rowNumber: 2,
    values: { name: 'Grace', score: 10 }
  },
  {
    id: 'c',
    rowNumber: 3,
    values: { name: 'Linus', score: 7 }
  }
] as const;

describe('applyListRowsQuery', () => {
  it('sorts, pages, and projects fields', () => {
    const firstPage = applyListRowsQuery(rows, {
      sort: 'score:desc',
      limit: 2,
      fields: ['name']
    });

    expect(firstPage.data).toEqual([
      { id: 'b', rowNumber: 2, values: { name: 'Grace' } },
      { id: 'c', rowNumber: 3, values: { name: 'Linus' } }
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = applyListRowsQuery(rows, {
      sort: 'score:desc',
      limit: 2,
      cursor: firstPage.nextCursor
    });

    expect(secondPage.data).toEqual([
      { id: 'a', rowNumber: 4, values: { name: 'Ada', score: 2 } }
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
