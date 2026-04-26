import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@sheetflare/contracts';
import {
  decodeQueryCursor,
  encodeQueryCursor,
  getListQueryFingerprint,
  normalizeListQuery
} from '../src';

describe('normalizeListQuery', () => {
  it('clamps the page size', () => {
    expect(normalizeListQuery({ limit: 999 })).toMatchObject({ limit: 500 });
    expect(normalizeListQuery({ limit: 0 })).toMatchObject({ limit: 1 });
  });
});

describe('query cursors', () => {
  it('round-trips a cursor payload', () => {
    const query = normalizeListQuery({
      sort: 'score:desc',
      fields: ['name']
    });
    const fingerprint = getListQueryFingerprint(query);
    const cursor = encodeQueryCursor({
      fingerprint,
      sortField: 'score',
      sortDirection: 'desc',
      rowId: 'row-1',
      rowNumber: 3,
      value: {
        kind: 'number',
        value: 12
      }
    });

    expect(decodeQueryCursor(cursor, fingerprint, query.sort)).toEqual({
      fingerprint,
      sortField: 'score',
      sortDirection: 'desc',
      rowId: 'row-1',
      rowNumber: 3,
      value: {
        kind: 'number',
        value: 12
      }
    });
  });

  it('rejects invalid cursors', () => {
    const query = normalizeListQuery({ sort: 'score:desc' });
    expect(() => decodeQueryCursor('bad', getListQueryFingerprint(query), query.sort)).toThrow(BadRequestError);
  });
});
