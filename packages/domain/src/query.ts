import type { FieldFilter, QueryScalarValue, RowEnvelope, RowFilter, RowRecord } from '@sheetflare/contracts';
import { BadRequestError } from '@sheetflare/contracts';

export type SqlParameter = string | number | boolean | null;

export interface QueryValidationResult {
  requiresFullScan: boolean;
}

const rangeOperators = ['gt', 'gte', 'lt', 'lte'] as const;

export function getIndexedFieldSet(indexedFields: readonly string[]) {
  return new Set(indexedFields);
}

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

export function sortRows(
  rows: readonly RowEnvelope[],
  sort: { field: string; direction: 'asc' | 'desc' }
) {
  const direction = sort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    if (sort.field === 'rowNumber') {
      return (left.rowNumber - right.rowNumber) * direction || left.id.localeCompare(right.id) * direction;
    }

    if (sort.field === 'id') {
      return left.id.localeCompare(right.id) * direction;
    }

    return (
      compareValues(left.values[sort.field], right.values[sort.field]) * direction ||
      left.id.localeCompare(right.id) * direction
    );
  });
}

export function assertQueryableField(
  field: string,
  indexedFields: readonly string[],
  options: { allowRowNumber?: boolean; allowId?: boolean }
) {
  if (options.allowRowNumber && field === 'rowNumber') {
    return;
  }

  if (options.allowId && field === 'id') {
    return;
  }

  if (!indexedFields.includes(field)) {
    throw new BadRequestError(`Field ${field} is not indexed.`, {
      field,
      indexedFields
    });
  }
}

function getScalarKind(value: QueryScalarValue) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

function getFieldAlias(fieldIndex: number) {
  return `cf${fieldIndex}`;
}

export function validateFilterCapabilities(filter: RowFilter | null, indexedFields: readonly string[]): QueryValidationResult {
  let requiresFullScan = false;

  if (!filter) {
    return { requiresFullScan };
  }

  for (const [field, definition] of Object.entries(filter)) {
    assertQueryableField(field, indexedFields, { allowId: true, allowRowNumber: true });

    if (definition.contains !== undefined) {
      requiresFullScan = true;
    }
  }

  return { requiresFullScan };
}

export function buildFilterSql(
  filter: RowFilter | null,
  indexedFields: readonly string[]
): {
  joins: string[];
  conditions: string[];
  parameters: SqlParameter[];
  requiresFullScan: boolean;
} {
  const joins: string[] = [];
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];
  let requiresFullScan = false;

  if (!filter) {
    return { joins, conditions, parameters, requiresFullScan };
  }

  for (const [fieldIndex, [field, definition]] of Object.entries(filter).entries()) {
    if (field === 'rowNumber') {
      applyRowNumberFilter(definition, conditions, parameters);
      continue;
    }

    if (field === 'id') {
      applyRowIdFilter(definition, conditions, parameters);
      continue;
    }

    assertQueryableField(field, indexedFields, { allowId: true, allowRowNumber: true });
    const alias = getFieldAlias(fieldIndex);
    joins.push(`INNER JOIN cached_cells ${alias} ON ${alias}.row_id = cr.row_id AND ${alias}.field_name = ?`);
    parameters.push(field);
    const fieldResult = applyIndexedFieldFilter(alias, definition);
    conditions.push(...fieldResult.conditions);
    parameters.push(...fieldResult.parameters);
    requiresFullScan ||= fieldResult.requiresFullScan;
  }

  return { joins, conditions, parameters, requiresFullScan };
}

function applyRowNumberFilter(definition: FieldFilter, conditions: string[], parameters: SqlParameter[]) {
  applyScalarFilter({
    fieldSql: 'cr.row_number',
    kindSql: null,
    textSql: 'CAST(cr.row_number AS TEXT)',
    numberSql: 'cr.row_number',
    booleanSql: null,
    definition,
    conditions,
    parameters
  });
}

function applyRowIdFilter(definition: FieldFilter, conditions: string[], parameters: SqlParameter[]) {
  applyScalarFilter({
    fieldSql: 'cr.row_id',
    kindSql: null,
    textSql: 'cr.row_id',
    numberSql: null,
    booleanSql: null,
    definition,
    conditions,
    parameters
  });
}

function applyIndexedFieldFilter(alias: string, definition: FieldFilter) {
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];
  applyScalarFilter({
    fieldSql: `${alias}.value_text`,
    kindSql: `${alias}.value_kind`,
    textSql: `${alias}.value_text`,
    numberSql: `${alias}.value_number`,
    booleanSql: `${alias}.value_boolean`,
    definition,
    conditions,
    parameters
  });

  return {
    conditions,
    parameters,
    requiresFullScan: definition.contains !== undefined
  };
}

function applyScalarFilter(options: {
  fieldSql: string;
  kindSql: string | null;
  textSql: string | null;
  numberSql: string | null;
  booleanSql: string | null;
  definition: FieldFilter;
  conditions: string[];
  parameters: SqlParameter[];
}) {
  const { definition, conditions, parameters } = options;

  if (definition.eq !== undefined) {
    const clause = buildEqualityClause(options, definition.eq, '=');
    conditions.push(clause.sql);
    parameters.push(...clause.parameters);
  }

  if (definition.neq !== undefined) {
    const clause = buildEqualityClause(options, definition.neq, '!=');
    conditions.push(clause.sql);
    parameters.push(...clause.parameters);
  }

  if (definition.in !== undefined) {
    const entries = definition.in;
    const entryClauses = entries.map((entry) => buildEqualityClause(options, entry, '='));
    conditions.push(`(${entryClauses.map((entry) => entry.sql).join(' OR ')})`);
    for (const entry of entryClauses) {
      parameters.push(...entry.parameters);
    }
  }

  if (definition.isNull !== undefined) {
    if (!options.kindSql) {
      conditions.push(definition.isNull ? `${options.fieldSql} IS NULL` : `${options.fieldSql} IS NOT NULL`);
    } else {
      conditions.push(definition.isNull ? `${options.kindSql} = 'null'` : `${options.kindSql} != 'null'`);
    }
  }

  for (const operator of rangeOperators) {
    const value = definition[operator];
    if (value === undefined) continue;
    const clause = buildRangeClause(options, operator, value);
    conditions.push(clause.sql);
    parameters.push(...clause.parameters);
  }

  if (definition.startsWith !== undefined) {
    if (!options.textSql) {
      throw new BadRequestError('startsWith is not supported for this field.');
    }
    if (options.kindSql) {
      conditions.push(`${options.kindSql} = 'string' AND ${options.textSql} LIKE ?`);
      parameters.push(`${definition.startsWith}%`);
    } else {
      conditions.push(`${options.textSql} LIKE ?`);
      parameters.push(`${definition.startsWith}%`);
    }
  }

  if (definition.contains !== undefined) {
    if (!options.textSql) {
      throw new BadRequestError('contains is not supported for this field.');
    }
    if (options.kindSql) {
      conditions.push(`${options.kindSql} = 'string' AND ${options.textSql} LIKE ?`);
      parameters.push(`%${definition.contains}%`);
    } else {
      conditions.push(`${options.textSql} LIKE ?`);
      parameters.push(`%${definition.contains}%`);
    }
  }
}

function buildEqualityClause(
  options: {
    kindSql: string | null;
    textSql: string | null;
    numberSql: string | null;
    booleanSql: string | null;
    fieldSql: string;
  },
  value: QueryScalarValue,
  operator: '=' | '!='
) {
  const kind = getScalarKind(value);
  if (!options.kindSql) {
    return {
      sql: `${options.fieldSql} ${operator} ?`,
      parameters: [value as SqlParameter]
    };
  }

  if (kind === 'null') {
    return {
      sql: operator === '=' ? `${options.kindSql} = 'null'` : `${options.kindSql} != 'null'`,
      parameters: [] as SqlParameter[]
    };
  }

  if (kind === 'boolean') {
    return {
      sql: `${options.kindSql} = 'boolean' AND ${options.booleanSql!} ${operator} ?`,
      parameters: [value ? 1 : 0]
    };
  }

  if (kind === 'number') {
    return {
      sql: `${options.kindSql} = 'number' AND ${options.numberSql!} ${operator} ?`,
      parameters: [value]
    };
  }

  return {
    sql: `${options.kindSql} = 'string' AND ${options.textSql!} ${operator} ?`,
    parameters: [value]
  };
}

function buildRangeClause(
  options: {
    kindSql: string | null;
    textSql: string | null;
    numberSql: string | null;
    fieldSql: string;
  },
  operator: 'gt' | 'gte' | 'lt' | 'lte',
  value: string | number
) {
  const sqlOperator = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<='
  }[operator];

  if (!options.kindSql) {
    return {
      sql: `${options.fieldSql} ${sqlOperator} ?`,
      parameters: [value as SqlParameter]
    };
  }

  if (typeof value === 'number') {
    return {
      sql: `${options.kindSql} = 'number' AND ${options.numberSql!} ${sqlOperator} ?`,
      parameters: [value]
    };
  }

  return {
    sql: `${options.kindSql} = 'string' AND ${options.textSql!} ${sqlOperator} ?`,
    parameters: [value]
  };
}
