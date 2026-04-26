import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@sheetflare/contracts';
import { decodeOffsetCursor, encodeOffsetCursor, normalizeListQuery } from '../src';

describe('normalizeListQuery', () => {
  it('clamps the page size', () => {
    expect(normalizeListQuery({ limit: 999 })).toMatchObject({ limit: 500 });
    expect(normalizeListQuery({ limit: 0 })).toMatchObject({ limit: 1 });
  });
});

describe('offset cursors', () => {
  it('round-trips an offset', () => {
    const cursor = encodeOffsetCursor(75);
    expect(decodeOffsetCursor(cursor)).toBe(75);
  });

  it('rejects invalid cursors', () => {
    expect(() => decodeOffsetCursor('bad')).toThrow(BadRequestError);
  });
});
