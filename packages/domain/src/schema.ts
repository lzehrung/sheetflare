import type { RowEnvelope, TableSchemaField } from '@sheetflare/contracts';

function inferScalarType(value: unknown): TableSchemaField['inferredType'] {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'json';
  if (typeof value !== 'string') return 'unknown';

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (!Number.isNaN(Date.parse(value)) && /T/.test(value)) return 'datetime';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return 'number';
  if (/^(?:true|false)$/i.test(value)) return 'boolean';

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return 'json';
  } catch {
    return 'string';
  }

  return 'string';
}

export function inferTableSchema(rows: readonly RowEnvelope[]) {
  const fieldState = new Map<
    string,
    { inferredType: TableSchemaField['inferredType']; nullable: boolean }
  >();

  for (const row of rows) {
    for (const [name, value] of Object.entries(row.values)) {
      const entry = fieldState.get(name);
      const inferredType = inferScalarType(value);

      if (!entry) {
        fieldState.set(name, {
          inferredType,
          nullable: value === null
        });
        continue;
      }

      entry.nullable ||= value === null;
      if (entry.inferredType !== inferredType) {
        entry.inferredType = entry.inferredType === 'unknown' ? inferredType : 'json';
      }
    }
  }

  return {
    fields: [...fieldState.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({
        name,
        inferredType: value.inferredType,
        nullable: value.nullable
      })),
    inferredAt: new Date().toISOString()
  };
}
