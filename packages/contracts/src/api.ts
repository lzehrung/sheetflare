import { z } from 'zod';
import { defaultAuthModeSchema, projectConfigSchema, tableConfigSchema } from './project';
import { projectSlugSchema, rowIdSchema, spreadsheetIdSchema, tableSlugSchema } from './ids';
import { listRowsResultSchema, rowEnvelopeSchema, rowRecordSchema, tableSchemaSchema } from './table';

export const createProjectInputSchema = z.object({
  slug: projectSlugSchema,
  name: z.string().min(1),
  spreadsheetId: spreadsheetIdSchema,
  googleCredentialRef: z.string().min(1),
  defaultAuthMode: defaultAuthModeSchema.optional()
});

export const createTableInputSchema = z.object({
  tableSlug: tableSlugSchema,
  sheetTabName: z.string().min(1),
  sheetGid: z.number().int().nonnegative().optional(),
  idColumn: z.string().min(1).optional(),
  headerRow: z.number().int().positive().optional(),
  dataStartRow: z.number().int().positive().optional(),
  readEnabled: z.boolean().optional(),
  createEnabled: z.boolean().optional(),
  updateEnabled: z.boolean().optional(),
  deleteEnabled: z.boolean().optional(),
  cacheTtlSeconds: z.number().int().nonnegative().optional()
});

export const createRowInputSchema = z.object({
  values: rowRecordSchema
});

export const updateRowInputSchema = z.object({
  values: rowRecordSchema
});

export const projectSummarySchema = z.object({
  slug: projectSlugSchema,
  name: z.string().min(1),
  spreadsheetId: spreadsheetIdSchema,
  tableCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});

export const adminListProjectsResultSchema = z.object({
  data: z.array(projectSummarySchema)
});

export const adminGetProjectResultSchema = z.object({
  project: projectConfigSchema,
  tables: z.array(tableConfigSchema)
});

export const upsertTableResultSchema = z.object({
  data: tableConfigSchema
});

export const getRowResultSchema = z.object({
  data: rowEnvelopeSchema
});

export const createRowResultSchema = z.object({
  data: rowEnvelopeSchema,
  ignoredKeys: z.array(z.string())
});

export const updateRowResultSchema = createRowResultSchema;

export const deleteRowResultSchema = z.object({
  ok: z.literal(true),
  deletedId: rowIdSchema
});

export const getSchemaResultSchema = z.object({
  data: tableSchemaSchema
});

export const reindexTableResultSchema = z.object({
  ok: z.literal(true),
  rowCount: z.number().int().nonnegative()
});

export const adminProjectParamsSchema = z.object({
  project: projectSlugSchema
});

export const adminProjectTableParamsSchema = z.object({
  project: projectSlugSchema,
  table: tableSlugSchema
});

export const rowParamsSchema = z.object({
  project: projectSlugSchema,
  table: tableSlugSchema,
  id: rowIdSchema
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateTableInput = z.infer<typeof createTableInputSchema>;
export type CreateRowInput = z.infer<typeof createRowInputSchema>;
export type UpdateRowInput = z.infer<typeof updateRowInputSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type AdminListProjectsResult = z.infer<typeof adminListProjectsResultSchema>;
export type AdminGetProjectResult = z.infer<typeof adminGetProjectResultSchema>;
export type UpsertTableResult = z.infer<typeof upsertTableResultSchema>;
export type GetRowResult = z.infer<typeof getRowResultSchema>;
export type CreateRowResult = z.infer<typeof createRowResultSchema>;
export type UpdateRowResult = z.infer<typeof updateRowResultSchema>;
export type DeleteRowResult = z.infer<typeof deleteRowResultSchema>;
export type GetSchemaResult = z.infer<typeof getSchemaResultSchema>;
export type ReindexTableResult = z.infer<typeof reindexTableResultSchema>;
