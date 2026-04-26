import type { ListRowsQuery } from '@sheetflare/contracts';
import { BadRequestError } from '@sheetflare/contracts';

const cursorPrefix = 'offset:';

export interface NormalizedListRowsQuery {
  limit: number;
  cursor: string | null;
  sort: string | null;
  fields: string[] | null;
  filter: Record<string, unknown> | null;
}

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));

  try {
    return atob(normalized + padding);
  } catch {
    throw new BadRequestError('Invalid pagination cursor.');
  }
}

export function normalizeListQuery(query: ListRowsQuery): NormalizedListRowsQuery {
  return {
    limit: Math.min(Math.max(query.limit ?? 50, 1), 500),
    cursor: query.cursor ?? null,
    sort: query.sort ?? null,
    fields: query.fields ?? null,
    filter: query.filter ?? null
  };
}

export function encodeOffsetCursor(offset: number): string {
  return base64UrlEncode(`${cursorPrefix}${offset}`);
}

export function decodeOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;

  const decoded = base64UrlDecode(cursor);

  if (!decoded.startsWith(cursorPrefix)) {
    throw new BadRequestError('Invalid pagination cursor.');
  }

  const parsed = Number(decoded.slice(cursorPrefix.length));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestError('Invalid pagination cursor.');
  }

  return parsed;
}
