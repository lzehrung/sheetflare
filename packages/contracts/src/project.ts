import { z } from 'zod';
import { projectSlugSchema, sheetTabNameSchema, spreadsheetIdSchema, tableSlugSchema } from './ids';

export const defaultAuthModeSchema = z.enum(['private', 'public-read']);
export const maxIndexedFieldCount = 32;
export const fieldNormalizationSchema = z.enum(['trim', 'lowercase']);
export const constrainedFieldTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'datetime']);
export const fieldRuleSchema = z.object({
  required: z.boolean().optional(),
  type: constrainedFieldTypeSchema.optional(),
  enum: z.array(z.string().min(1)).min(1).optional(),
  unique: z.boolean().optional(),
  normalize: z.array(fieldNormalizationSchema).min(1).optional()
});
export const fieldRulesSchema = z.record(z.string().min(1), fieldRuleSchema);

function validateTableLayout(
  value: {
    headerRow: number;
    dataStartRow: number;
    indexedFields: string[];
  },
  ctx: z.RefinementCtx
) {
  if (value.dataStartRow <= value.headerRow) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'dataStartRow must be greater than headerRow.',
      path: ['dataStartRow']
    });
  }

  if (value.indexedFields.length > maxIndexedFieldCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `A table may index at most ${maxIndexedFieldCount} fields including the managed ID column.`,
      path: ['indexedFields']
    });
  }
}

export const projectConfigSchema = z.object({
  slug: projectSlugSchema,
  name: z.string().min(1),
  spreadsheetId: spreadsheetIdSchema,
  googleCredentialRef: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  defaultAuthMode: defaultAuthModeSchema
});

export const tableConfigSchema = z.object({
  projectSlug: projectSlugSchema,
  tableSlug: tableSlugSchema,
  sheetTabName: sheetTabNameSchema,
  sheetGid: z.number().int().nonnegative().optional(),
  idColumn: z.string().min(1),
  indexedFields: z.array(z.string().min(1)).max(maxIndexedFieldCount),
  readOnlyFields: z.array(z.string().min(1)).default([]),
  fieldRules: fieldRulesSchema.default({}),
  headerRow: z.number().int().positive(),
  dataStartRow: z.number().int().positive(),
  readEnabled: z.boolean(),
  createEnabled: z.boolean(),
  updateEnabled: z.boolean(),
  deleteEnabled: z.boolean(),
  cacheTtlSeconds: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine(validateTableLayout);

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type TableConfig = z.infer<typeof tableConfigSchema>;
export type FieldNormalization = z.infer<typeof fieldNormalizationSchema>;
export type ConstrainedFieldType = z.infer<typeof constrainedFieldTypeSchema>;
export type FieldRule = z.infer<typeof fieldRuleSchema>;
export type FieldRules = z.infer<typeof fieldRulesSchema>;
