import type { RowRecord, TableConfig } from '@sheetflare/contracts';

const defaultStatusCycle = ['active', 'inactive', 'pending', 'archived'] as const;

type BenchmarkFieldPlan = {
  sortField: string;
  containsField: string;
  numericField: string | null;
};

function asRowIndex(rowNumber: number) {
  return rowNumber - 1;
}

function formatBenchmarkId(rowNumber: number) {
  return `bench-${String(rowNumber).padStart(7, '0')}`;
}

function buildDateString(rowNumber: number) {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + asRowIndex(rowNumber));
  return date.toISOString().slice(0, 10);
}

function buildDateTimeString(rowNumber: number) {
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
  date.setUTCMinutes(date.getUTCMinutes() + asRowIndex(rowNumber));
  return date.toISOString();
}

function getFieldRule(table: Pick<TableConfig, 'fieldRules'>, fieldName: string) {
  return table.fieldRules[fieldName];
}

function isWritableBenchmarkField(table: Pick<TableConfig, 'idColumn' | 'readOnlyFields'>, fieldName: string) {
  return fieldName !== table.idColumn && !table.readOnlyFields.includes(fieldName);
}

function generateFieldValue(
  fieldName: string,
  rowNumber: number,
  table: Pick<TableConfig, 'idColumn' | 'fieldRules'>
): string | number | boolean {
  const rule = getFieldRule(table, fieldName);
  if (rule?.enum?.length) {
    return rule.enum[asRowIndex(rowNumber) % rule.enum.length]!;
  }

  if (rule?.type === 'number') {
    return rowNumber;
  }

  if (rule?.type === 'boolean') {
    return rowNumber % 2 === 0;
  }

  if (rule?.type === 'date') {
    return buildDateString(rowNumber);
  }

  if (rule?.type === 'datetime') {
    return buildDateTimeString(rowNumber);
  }

  const lowerFieldName = fieldName.toLowerCase();
  if (lowerFieldName.includes('status') || lowerFieldName.includes('state') || lowerFieldName.includes('phase')) {
    return defaultStatusCycle[asRowIndex(rowNumber) % defaultStatusCycle.length]!;
  }

  if (
    lowerFieldName.includes('score') ||
    lowerFieldName.includes('count') ||
    lowerFieldName.includes('rank') ||
    lowerFieldName.includes('index') ||
    lowerFieldName.includes('order') ||
    lowerFieldName.includes('priority')
  ) {
    return rowNumber;
  }

  if (lowerFieldName.includes('date')) {
    return buildDateString(rowNumber);
  }

  if (lowerFieldName.includes('time') || lowerFieldName.endsWith('at')) {
    return buildDateTimeString(rowNumber);
  }

  if (
    lowerFieldName.includes('name') ||
    lowerFieldName.includes('title') ||
    lowerFieldName.includes('label') ||
    lowerFieldName.includes('slug')
  ) {
    return `${fieldName}-${String(rowNumber).padStart(7, '0')}`;
  }

  if (
    lowerFieldName.includes('note') ||
    lowerFieldName.includes('description') ||
    lowerFieldName.includes('detail') ||
    lowerFieldName.includes('body') ||
    lowerFieldName.includes('text') ||
    lowerFieldName.includes('summary')
  ) {
    return `${fieldName} for bench row ${rowNumber} needle-${rowNumber}`;
  }

  return `${fieldName}-${String(rowNumber).padStart(7, '0')}`;
}

export function chooseBenchmarkFields(table: Pick<TableConfig, 'idColumn' | 'indexedFields' | 'readOnlyFields' | 'fieldRules'>, headers: readonly string[]): BenchmarkFieldPlan {
  const indexedSortField =
    table.indexedFields.find((field) => field !== table.idColumn && headers.includes(field) && isWritableBenchmarkField(table, field))
    ?? table.idColumn;

  const containsField =
    headers.find((field) => field !== table.idColumn && isWritableBenchmarkField(table, field) && (
      field.toLowerCase().includes('name') ||
      field.toLowerCase().includes('title') ||
      field.toLowerCase().includes('description') ||
      field.toLowerCase().includes('note') ||
      field.toLowerCase().includes('text') ||
      field.toLowerCase().includes('summary')
    ))
    ?? headers.find((field) => isWritableBenchmarkField(table, field) && field !== table.idColumn)
    ?? table.idColumn;

  const numericField =
    headers.find((field) => {
      if (!isWritableBenchmarkField(table, field) || field === table.idColumn) {
        return false;
      }

      const rule = getFieldRule(table, field);
      if (rule?.type === 'number') {
        return true;
      }

      const lowerFieldName = field.toLowerCase();
      return (
        lowerFieldName.includes('score') ||
        lowerFieldName.includes('count') ||
        lowerFieldName.includes('rank') ||
        lowerFieldName.includes('index') ||
        lowerFieldName.includes('order') ||
        lowerFieldName.includes('priority')
      );
    }) ?? null;

  return {
    sortField: indexedSortField,
    containsField,
    numericField
  };
}

export function buildBenchmarkRow(
  headers: readonly string[],
  rowNumber: number,
  table: Pick<TableConfig, 'idColumn' | 'fieldRules' | 'readOnlyFields'>
): RowRecord {
  const row: RowRecord = {};

  for (const header of headers) {
    if (header === table.idColumn) {
      row[header] = formatBenchmarkId(rowNumber);
      continue;
    }

    if (!isWritableBenchmarkField(table, header)) {
      continue;
    }

    row[header] = generateFieldValue(header, rowNumber, table);
  }

  return row;
}

export function buildBenchmarkRowId(rowNumber: number) {
  return formatBenchmarkId(rowNumber);
}
