import { z } from 'zod';
import type { FieldFilter, ListRowsQuery, QueryScalarValue, RowFilter } from '@sheetflare/contracts';
import { BadRequestError } from '@sheetflare/contracts';
import { compareStableStrings } from './strings';

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));

  try {
    const binary = atob(normalized + padding);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new TextDecoder().decode(bytes);
  } catch {
    throw new BadRequestError('Invalid pagination cursor.');
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    compareStableStrings(left, right)
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

export interface QuerySortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

export interface NormalizedListRowsQuery {
  limit: number;
  cursor: string | null;
  sort: QuerySortSpec;
  fields: string[] | null;
  filter: RowFilter | null;
}

export type CursorValue =
  | { kind: 'null'; value: null }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string };

export interface QueryCursorPayload {
  fingerprint: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  rowId: string;
  rowNumber: number;
  value: CursorValue;
}

const cursorValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('null'),
    value: z.null()
  }),
  z.object({
    kind: z.literal('boolean'),
    value: z.boolean()
  }),
  z.object({
    kind: z.literal('number'),
    value: z.number().finite()
  }),
  z.object({
    kind: z.literal('string'),
    value: z.string()
  })
]) satisfies z.ZodType<CursorValue>;

const queryCursorPayloadSchema = z.object({
  fingerprint: z.string(),
  sortField: z.string().min(1),
  sortDirection: z.enum(['asc', 'desc']),
  rowId: z.string().min(1),
  rowNumber: z.number().int().safe().positive(),
  value: cursorValueSchema
}) satisfies z.ZodType<QueryCursorPayload>;

export function normalizeScalarCursorValue(value: QueryScalarValue): CursorValue {
  if (value === null) return { kind: 'null', value: null };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BadRequestError('Pagination cursor cannot contain a non-finite number.');
    }

    return { kind: 'number', value };
  }
  return { kind: 'string', value };
}

export function parseSort(sort: string | null | undefined): QuerySortSpec {
  if (!sort) {
    return {
      field: 'rowNumber',
      direction: 'asc'
    };
  }

  const [field, rawDirection] = sort.split(':');
  if (!field) {
    throw new BadRequestError('Invalid sort field.');
  }

  return {
    field,
    direction: rawDirection === 'desc' ? 'desc' : 'asc'
  };
}

export function normalizeListQuery(query: ListRowsQuery): NormalizedListRowsQuery {
  return {
    limit: Math.min(Math.max(query.limit ?? 50, 1), 500),
    cursor: query.cursor ?? null,
    sort: parseSort(query.sort),
    fields: query.fields ?? null,
    filter: query.filter ?? null
  };
}

export function getListQueryFingerprint(query: NormalizedListRowsQuery): string {
  return stableStringify({
    sort: query.sort,
    fields: query.fields,
    filter: query.filter
  });
}

function parseQueryCursorPayload(value: unknown): QueryCursorPayload | null {
  const parsed = queryCursorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function encodeQueryCursor(cursor: QueryCursorPayload): string {
  const payload = parseQueryCursorPayload(cursor);
  if (!payload) {
    throw new BadRequestError('Invalid pagination cursor.');
  }

  return base64UrlEncode(JSON.stringify(payload));
}

export function decodeQueryCursor(
  cursor: string | null | undefined,
  expectedFingerprint: string,
  expectedSort: QuerySortSpec
): QueryCursorPayload | null {
  if (!cursor) return null;

  let parsed: QueryCursorPayload;
  try {
    const decoded: unknown = JSON.parse(base64UrlDecode(cursor));
    const payload = parseQueryCursorPayload(decoded);
    if (!payload) {
      throw new BadRequestError('Invalid pagination cursor.');
    }

    parsed = payload;
  } catch {
    throw new BadRequestError('Invalid pagination cursor.');
  }

  if (
    parsed.fingerprint !== expectedFingerprint ||
    parsed.sortField !== expectedSort.field ||
    parsed.sortDirection !== expectedSort.direction
  ) {
    throw new BadRequestError('Pagination cursor does not match the current query.');
  }

  return parsed;
}

export function getFilterOperatorCount(filter: FieldFilter) {
  return Object.values(filter).filter((entry) => entry !== undefined).length;
}
