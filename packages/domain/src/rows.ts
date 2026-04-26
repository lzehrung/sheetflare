import type { RowRecord } from '@sheetflare/contracts';

export function normalizeRowValues(input: RowRecord): RowRecord {
  const output: RowRecord = {};

  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    output[key] = value;
  }

  return output;
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
