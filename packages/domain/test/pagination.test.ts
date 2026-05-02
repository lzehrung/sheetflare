import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@sheetflare/contracts';
import {
  decodeQueryCursor,
  encodeQueryCursor,
  getListQueryFingerprint,
  normalizeScalarCursorValue,
  normalizeListQuery
} from '../src';

function encodeRawCursorPayload(payload: unknown) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
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

  it('round-trips unicode cursor payloads', () => {
    const query = normalizeListQuery({
      sort: 'café:asc',
      fields: ['naïve']
    });
    const fingerprint = getListQueryFingerprint(query);
    const cursor = encodeQueryCursor({
      fingerprint,
      sortField: 'café',
      sortDirection: 'asc',
      rowId: 'row-é',
      rowNumber: 3,
      value: {
        kind: 'string',
        value: 'São Paulo'
      }
    });

    expect(decodeQueryCursor(cursor, fingerprint, query.sort)).toEqual({
      fingerprint,
      sortField: 'café',
      sortDirection: 'asc',
      rowId: 'row-é',
      rowNumber: 3,
      value: {
        kind: 'string',
        value: 'São Paulo'
      }
    });
  });

  it('rejects non-finite numeric cursor values before encoding', () => {
    expect(() => normalizeScalarCursorValue(Number.NaN)).toThrow(BadRequestError);
    expect(() => normalizeScalarCursorValue(Number.POSITIVE_INFINITY)).toThrow(BadRequestError);
    expect(() =>
      encodeQueryCursor({
        fingerprint: 'query',
        sortField: 'score',
        sortDirection: 'asc',
        rowId: 'row-1',
        rowNumber: 1,
        value: {
          kind: 'number',
          value: Number.NaN
        }
      })
    ).toThrow(BadRequestError);
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
