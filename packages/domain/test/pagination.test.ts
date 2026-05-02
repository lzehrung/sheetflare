import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@sheetflare/contracts';
import {
  decodeQueryCursor,
  encodeQueryCursor,
  getListQueryFingerprint,
  normalizeListQuery
} from '../src';

function encodeRawCursorPayload(payload: unknown) {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

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

  it('rejects structurally invalid cursor payloads', () => {
    const query = normalizeListQuery({ sort: 'score:desc' });
    const fingerprint = getListQueryFingerprint(query);
    const basePayload = {
      fingerprint,
      sortField: query.sort.field,
      sortDirection: query.sort.direction,
      rowId: 'row-1',
      rowNumber: 3,
      value: {
        kind: 'number',
        value: 12
      }
    };

    const invalidPayloads = [
      { ...basePayload, value: undefined },
      { ...basePayload, value: { kind: 'json', value: '{}' } },
      { ...basePayload, value: { kind: 'number', value: '12' } },
      { ...basePayload, rowId: '' },
      { ...basePayload, rowNumber: 0 },
      { ...basePayload, sortDirection: 'sideways' }
    ];

    for (const payload of invalidPayloads) {
      expect(() => decodeQueryCursor(encodeRawCursorPayload(payload), fingerprint, query.sort)).toThrow(BadRequestError);
    }
  });

  it('rejects cursors generated for another query', () => {
    const query = normalizeListQuery({ sort: 'score:desc' });
    const otherQuery = normalizeListQuery({ sort: 'score:asc' });
    const cursor = encodeQueryCursor({
      fingerprint: getListQueryFingerprint(otherQuery),
      sortField: otherQuery.sort.field,
      sortDirection: otherQuery.sort.direction,
      rowId: 'row-1',
      rowNumber: 3,
      value: {
        kind: 'number',
        value: 12
      }
    });

    expect(() => decodeQueryCursor(cursor, getListQueryFingerprint(query), query.sort)).toThrow(BadRequestError);
  });
});
