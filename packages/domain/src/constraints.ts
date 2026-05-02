import type { FieldFilter, FieldRule, FieldRules, QueryScalarValue, RowFilter, RowRecord } from '@sheetflare/contracts';

export type ConstraintViolationCode = 'REQUIRED' | 'TYPE' | 'ENUM';

export type ConstraintViolation = {
  field: string;
  code: ConstraintViolationCode;
  message: string;
};

function isBlankValue(value: RowRecord[string] | undefined) {
  return value === undefined || value === null || (typeof value === 'string' && value.length === 0);
}

export function normalizeFieldRule(rule: FieldRule | undefined): FieldRule | undefined {
  if (!rule) {
    return undefined;
  }

  return {
    ...(rule.required !== undefined ? { required: rule.required } : {}),
    ...(rule.type !== undefined ? { type: rule.type } : {}),
    ...(rule.unique !== undefined ? { unique: rule.unique } : {}),
    ...(rule.enum ? { enum: [...new Set(rule.enum.map((entry) => entry.trim()).filter(Boolean))] } : {}),
    ...(rule.normalize ? { normalize: [...new Set(rule.normalize)] } : {})
  };
}

function isIsoDateString(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function isIsoDateTimeString(value: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function isCanonicalNumberString(value: string) {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function isCanonicalBooleanString(value: string) {
  return /^(?:true|false)$/i.test(value);
}

export function coerceFieldRuleValue(
  value: RowRecord[string] | undefined,
  rule: FieldRule | undefined
): RowRecord[string] | undefined {
  if (value === undefined || value === null || Array.isArray(value) || !rule?.type) {
    return value;
  }

  switch (rule.type) {
    case 'string':
      return value;
    case 'number':
      if (typeof value === 'number') {
        return value;
      }

      return typeof value === 'string' && isCanonicalNumberString(value)
        ? Number(value)
        : value;
    case 'boolean':
      if (typeof value === 'boolean') {
        return value;
      }

      return typeof value === 'string' && isCanonicalBooleanString(value)
        ? value.toLowerCase() === 'true'
        : value;
    case 'date':
      return typeof value === 'string' && isIsoDateString(value) ? value : value;
    case 'datetime':
      return typeof value === 'string' && isIsoDateTimeString(value) ? value : value;
  }
}

function coerceFieldRuleScalarValue(
  value: QueryScalarValue | undefined,
  rule: FieldRule | undefined
): QueryScalarValue | undefined {
  const coerced = coerceFieldRuleValue(value, rule);
  if (coerced === undefined || coerced === null) {
    return coerced;
  }

  if (Array.isArray(coerced)) {
    return value;
  }

  return coerced;
}

function coerceComparableFieldRuleScalarValue(
  value: string | number | undefined,
  rule: FieldRule | undefined
): string | number | undefined {
  const coerced = coerceFieldRuleScalarValue(value, rule);
  return typeof coerced === 'string' || typeof coerced === 'number' ? coerced : value;
}

export function coerceFieldFilterDefinition(definition: FieldFilter, rule: FieldRule | undefined): FieldFilter {
  return {
    ...(definition.eq !== undefined ? { eq: coerceFieldRuleScalarValue(definition.eq, rule) } : {}),
    ...(definition.neq !== undefined ? { neq: coerceFieldRuleScalarValue(definition.neq, rule) } : {}),
    ...(definition.gt !== undefined ? { gt: coerceComparableFieldRuleScalarValue(definition.gt, rule) } : {}),
    ...(definition.gte !== undefined ? { gte: coerceComparableFieldRuleScalarValue(definition.gte, rule) } : {}),
    ...(definition.lt !== undefined ? { lt: coerceComparableFieldRuleScalarValue(definition.lt, rule) } : {}),
    ...(definition.lte !== undefined ? { lte: coerceComparableFieldRuleScalarValue(definition.lte, rule) } : {}),
    ...(definition.in !== undefined
      ? { in: definition.in.map((value) => coerceFieldRuleScalarValue(value, rule) ?? null) }
      : {}),
    ...(definition.contains !== undefined ? { contains: definition.contains } : {}),
    ...(definition.startsWith !== undefined ? { startsWith: definition.startsWith } : {}),
    ...(definition.isNull !== undefined ? { isNull: definition.isNull } : {})
  };
}

export function coerceRowFilter(filter: RowFilter | null, fieldRules: FieldRules): RowFilter | null {
  if (!filter) {
    return filter;
  }

  const normalizedEntries = Object.entries(filter).map(([field, definition]) => {
    if (field === 'id' || field === 'rowNumber') {
      return [field, definition] as const;
    }

    return [field, coerceFieldFilterDefinition(definition, fieldRules[field])] as const;
  });

  return Object.fromEntries(normalizedEntries);
}

function matchesConstrainedType(value: RowRecord[string] | undefined, expectedType: NonNullable<FieldRule['type']>) {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && isIsoDateString(value);
    case 'datetime':
      return typeof value === 'string' && isIsoDateTimeString(value);
  }
}

export function normalizeFieldRules(fieldRules: FieldRules | undefined): FieldRules {
  if (!fieldRules) {
    return {};
  }

  const normalized: FieldRules = {};
  for (const [rawFieldName, rule] of Object.entries(fieldRules)) {
    const fieldName = rawFieldName.trim();
    if (!fieldName) {
      continue;
    }

    const nextRule = normalizeFieldRule(rule);
    if (!nextRule) {
      continue;
    }

    normalized[fieldName] = nextRule;
  }

  return normalized;
}

export function normalizeFieldValue(value: RowRecord[string], rule: FieldRule | undefined): RowRecord[string] {
  if (typeof value !== 'string' || !rule?.normalize || rule.normalize.length === 0) {
    return value;
  }

  let normalized = value;
  for (const operation of rule.normalize) {
    if (operation === 'trim') {
      normalized = normalized.trim();
      continue;
    }

    if (operation === 'lowercase') {
      normalized = normalized.toLowerCase();
    }
  }

  return normalized;
}

export function applyFieldRuleNormalization(values: RowRecord, fieldRules: FieldRules | undefined): RowRecord {
  const normalizedRules = normalizeFieldRules(fieldRules);
  const normalizedValues: RowRecord = {};

  for (const [fieldName, value] of Object.entries(values)) {
    normalizedValues[fieldName] = normalizeFieldValue(value, normalizedRules[fieldName]);
  }

  return normalizedValues;
}

export function validateFieldRules(values: RowRecord, fieldRules: FieldRules | undefined): ConstraintViolation[] {
  const normalizedRules = normalizeFieldRules(fieldRules);
  const normalizedValues = applyFieldRuleNormalization(values, normalizedRules);
  const violations: ConstraintViolation[] = [];

  for (const [fieldName, rule] of Object.entries(normalizedRules)) {
    const value = normalizedValues[fieldName];
    const typedValue = coerceFieldRuleValue(value, rule);

    if (rule.required && isBlankValue(value)) {
      violations.push({
        field: fieldName,
        code: 'REQUIRED',
        message: `${fieldName} is required.`
      });
      continue;
    }

    if (rule.type && !isBlankValue(value) && !matchesConstrainedType(typedValue, rule.type)) {
      violations.push({
        field: fieldName,
        code: 'TYPE',
        message: `${fieldName} must be a ${rule.type}.`
      });
      continue;
    }

    if (rule.enum && !isBlankValue(value)) {
      if (typeof value !== 'string' || !rule.enum.includes(value)) {
        violations.push({
          field: fieldName,
          code: 'ENUM',
          message: `${fieldName} must be one of: ${rule.enum.join(', ')}.`
        });
      }
    }
  }

  return violations;
}
