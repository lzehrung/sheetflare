import type { RowRecord } from '@sheetflare/contracts';

export type ManagedRowIdParseResult =
  | { ok: true; rowId: string }
  | { ok: false; reason: 'missing' | 'invalid-type' };

export function normalizeRowValues(input: RowRecord): RowRecord {
  const output: RowRecord = {};

  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    output[key] = value;
  }

  return output;
}

export function parseManagedRowId(value: RowRecord[string] | undefined): ManagedRowIdParseResult {
  if (value === null || value === undefined) {
    return {
      ok: false,
      reason: 'missing'
    };
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0
      ? {
          ok: true,
          rowId: normalized
        }
      : {
          ok: false,
          reason: 'missing'
        };
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return {
      ok: true,
      rowId: String(value)
    };
  }

  return {
    ok: false,
    reason: 'invalid-type'
  };
}

export function pickKnownColumns(
  values: RowRecord,
  headers: readonly string[]
): { values: RowRecord; ignoredKeys: string[] } {
  const allowedHeaders = new Set(headers);
  const next: RowRecord = {};
  const ignoredKeys: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (allowedHeaders.has(key)) {
      next[key] = value;
      continue;
    }

    ignoredKeys.push(key);
  }

  return { values: next, ignoredKeys };
}
