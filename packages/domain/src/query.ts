import type { ListRowsQuery, RowEnvelope, RowRecord } from '@sheetflare/contracts';
import { decodeOffsetCursor, encodeOffsetCursor, normalizeListQuery, type NormalizedListRowsQuery } from './pagination';

function compareValues(
  left: RowRecord[string] | undefined,
  right: RowRecord[string] | undefined
) {
  const leftComparable = Array.isArray(left) ? JSON.stringify(left) : left;
  const rightComparable = Array.isArray(right) ? JSON.stringify(right) : right;

  if (leftComparable === rightComparable) return 0;
  if (leftComparable === null || leftComparable === undefined) return -1;
  if (rightComparable === null || rightComparable === undefined) return 1;
  return String(leftComparable).localeCompare(String(rightComparable), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

export function sortRows(rows: readonly RowEnvelope[], sort: string | null): RowEnvelope[] {
  if (!sort) return [...rows];

  const [field, rawDirection] = sort.split(':');
  const direction = rawDirection === 'desc' ? -1 : 1;
  if (!field) return [...rows];

  return [...rows].sort((left, right) => {
    if (field === 'rowNumber') {
      return (left.rowNumber - right.rowNumber) * direction;
    }

    return compareValues(left.values[field], right.values[field]) * direction;
  });
}

export function filterFields(rows: readonly RowEnvelope[], fields: string[] | null): RowEnvelope[] {
  if (!fields || fields.length === 0) return [...rows];

  const allowed = new Set(fields);
  return rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      Object.entries(row.values).filter(([key]) => allowed.has(key))
    )
  }));
}

export function applyListRowsQuery(
  rows: readonly RowEnvelope[],
  rawQuery: ListRowsQuery
): {
  data: RowEnvelope[];
  nextCursor: string | null;
  query: NormalizedListRowsQuery;
} {
  const query = normalizeListQuery(rawQuery);
  const offset = decodeOffsetCursor(query.cursor);
  const processedRows = filterFields(sortRows(rows, query.sort), query.fields);
  const page = processedRows.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;

  return {
    data: page,
    nextCursor: nextOffset < processedRows.length ? encodeOffsetCursor(nextOffset) : null,
    query
  };
}
