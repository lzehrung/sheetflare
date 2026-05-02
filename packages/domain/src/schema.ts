import type { RowEnvelope, TableSchemaField } from '@sheetflare/contracts';

function inferScalarType(value: unknown): TableSchemaField['inferredType'] {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'json';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

export function inferTableSchema(headers: readonly string[], rows: readonly RowEnvelope[]) {
  const fieldState = new Map<
    string,
    { inferredType: TableSchemaField['inferredType']; nullable: boolean }
  >();

  for (const header of headers) {
    fieldState.set(header, {
      inferredType: 'unknown',
      nullable: false
    });
  }

  for (const row of rows) {
    for (const [name, value] of Object.entries(row.values)) {
      const entry = fieldState.get(name);
      const inferredType = inferScalarType(value);
      const nullable = value === null || value === undefined;

      if (!entry) {
        fieldState.set(name, {
          inferredType: nullable ? 'unknown' : inferredType,
          nullable
        });
        continue;
      }

      entry.nullable ||= nullable;
      if (nullable) {
        continue;
      }

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
        nullable: value.inferredType === 'unknown' ? true : value.nullable
      })),
    inferredAt: new Date().toISOString()
  };
}
