import { z } from 'zod';
import { createApiKeyInputSchema, createApiKeyResultSchema, apiKeyPrincipalSchema } from './auth';
import { defaultAuthModeSchema, projectConfigSchema, tableConfigSchema } from './project';
import { apiKeyIdSchema, projectSlugSchema, rowIdSchema, spreadsheetIdSchema, tableSlugSchema } from './ids';
import { listRowsResultSchema, rowEnvelopeSchema, rowRecordSchema, tableCacheStatusSchema, tableSchemaSchema } from './table';

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

export const adminCreateApiKeyInputSchema = createApiKeyInputSchema;

export const adminListApiKeysResultSchema = z.object({
  data: z.array(apiKeyPrincipalSchema)
});

export const adminCreateApiKeyResultSchema = createApiKeyResultSchema;

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
  rowCount: z.number().int().nonnegative(),
  cache: tableCacheStatusSchema
});

export const getTableCacheStatusResultSchema = z.object({
  data: tableCacheStatusSchema
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

export const apiKeyParamsSchema = z.object({
  id: apiKeyIdSchema
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
export type GetTableCacheStatusResult = z.infer<typeof getTableCacheStatusResultSchema>;
export type AdminCreateApiKeyInput = z.infer<typeof adminCreateApiKeyInputSchema>;
export type AdminListApiKeysResult = z.infer<typeof adminListApiKeysResultSchema>;
export type AdminCreateApiKeyResult = z.infer<typeof adminCreateApiKeyResultSchema>;
