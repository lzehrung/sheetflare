import { z } from 'zod';
import { rowIdSchema } from './ids';

export const rowScalarValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const rowValueSchema = z.union([
  rowScalarValueSchema,
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean())
]);

export const rowRecordSchema = z.record(z.string().min(1), rowValueSchema);

export const rowEnvelopeSchema = z.object({
  id: rowIdSchema,
  rowNumber: z.number().int().positive(),
  values: rowRecordSchema
});

export const queryScalarValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const fieldFilterSchema = z
  .object({
    eq: queryScalarValueSchema.optional(),
    neq: queryScalarValueSchema.optional(),
    gt: z.union([z.string(), z.number()]).optional(),
    gte: z.union([z.string(), z.number()]).optional(),
    lt: z.union([z.string(), z.number()]).optional(),
    lte: z.union([z.string(), z.number()]).optional(),
    in: z.array(queryScalarValueSchema).min(1).optional(),
    contains: z.string().min(1).optional(),
    startsWith: z.string().min(1).optional(),
    isNull: z.boolean().optional()
  })
  .superRefine((value, ctx) => {
    const activeOperatorCount = Object.values(value).filter((entry) => entry !== undefined).length;
    if (activeOperatorCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A filter must include at least one operator.'
      });
      return;
    }

    if (activeOperatorCount > 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A filter may include at most two operators.'
      });
    }

    const rangeOperators = ['gt', 'gte', 'lt', 'lte'].filter((operator) => value[operator as keyof typeof value] !== undefined);
    const otherOperators = ['eq', 'neq', 'in', 'contains', 'startsWith', 'isNull'].filter((operator) => value[operator as keyof typeof value] !== undefined);
    if (otherOperators.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A filter may only include one non-range operator.'
      });
    }

    if (otherOperators.length > 0 && rangeOperators.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Range operators cannot be combined with non-range operators.'
      });
    }

    if (rangeOperators.length > 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A filter may include at most two range operators.'
      });
    }
  });

export const rowFilterSchema = z.record(z.string().min(1), fieldFilterSchema);

export const inferredFieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'date',
  'datetime',
  'json',
  'unknown'
]);

export const tableSchemaFieldSchema = z.object({
  name: z.string().min(1),
  inferredType: inferredFieldTypeSchema,
  nullable: z.boolean()
});

export const tableSchemaSchema = z.object({
  fields: z.array(tableSchemaFieldSchema),
  inferredAt: z.string().datetime()
});

export const tableValidationIssueSchema = z.object({
  rowId: rowIdSchema,
  rowNumber: z.number().int().positive(),
  field: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1)
});

export const tableValidationSummarySchema = z.object({
  status: z.enum(['ok', 'warning']),
  issueCount: z.number().int().nonnegative(),
  issues: z.array(tableValidationIssueSchema)
});

export const tableExternalChangeSchema = z.object({
  pending: z.boolean(),
  lastChangedAt: z.string().datetime().nullable(),
  debounceUntil: z.string().datetime().nullable(),
  lastAutoReindexAt: z.string().datetime().nullable()
});

export const tableCacheStatusSchema = z.object({
  status: z.enum(['idle', 'syncing', 'ready', 'error']),
  cacheTtlSeconds: z.number().int().nonnegative(),
  stale: z.boolean(),
  staleReason: z.enum(['fresh', 'never-synced', 'ttl-expired', 'config-changed', 'external-change', 'error']),
  rowCount: z.number().int().nonnegative(),
  lastSyncStartedAt: z.string().datetime().nullable(),
  lastSyncCompletedAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  validation: tableValidationSummarySchema,
  externalChange: tableExternalChangeSchema
});

export const listRowsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  cursor: z.string().min(1).nullable().optional(),
  sort: z.string().min(1).nullable().optional(),
  fields: z.array(z.string().min(1)).nullable().optional(),
  filter: rowFilterSchema.nullable().optional()
}).superRefine((value, ctx) => {
  if (!value.sort) return;

  const sortParts = value.sort.split(':');
  if (sortParts.length > 2 || sortParts[0]?.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Sort must be in the form "field" or "field:asc|desc".',
      path: ['sort']
    });
    return;
  }

  if (sortParts.length === 2 && !['asc', 'desc'].includes(sortParts[1]!)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Sort direction must be "asc" or "desc".',
      path: ['sort']
    });
  }
});

export const listRowsResultSchema = z.object({
  data: z.array(rowEnvelopeSchema),
  nextCursor: z.string().min(1).nullable()
});

export type RowValue = z.infer<typeof rowValueSchema>;
export type RowRecord = z.infer<typeof rowRecordSchema>;
export type RowEnvelope = z.infer<typeof rowEnvelopeSchema>;
export type QueryScalarValue = z.infer<typeof queryScalarValueSchema>;
export type FieldFilter = z.infer<typeof fieldFilterSchema>;
export type RowFilter = z.infer<typeof rowFilterSchema>;
export type TableSchemaField = z.infer<typeof tableSchemaFieldSchema>;
export type TableSchema = z.infer<typeof tableSchemaSchema>;
export type TableValidationIssue = z.infer<typeof tableValidationIssueSchema>;
export type TableValidationSummary = z.infer<typeof tableValidationSummarySchema>;
export type TableExternalChange = z.infer<typeof tableExternalChangeSchema>;
export type TableCacheStatus = z.infer<typeof tableCacheStatusSchema>;
export type ListRowsQuery = z.infer<typeof listRowsQuerySchema>;
export type ListRowsResult = z.infer<typeof listRowsResultSchema>;
