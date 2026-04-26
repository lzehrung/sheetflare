import { z } from 'zod';
import { projectSlugSchema, sheetTabNameSchema, spreadsheetIdSchema, tableSlugSchema } from './ids';

export const defaultAuthModeSchema = z.enum(['private', 'public-read']);

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
  indexedFields: z.array(z.string().min(1)).max(32),
  headerRow: z.number().int().positive(),
  dataStartRow: z.number().int().positive(),
  readEnabled: z.boolean(),
  createEnabled: z.boolean(),
  updateEnabled: z.boolean(),
  deleteEnabled: z.boolean(),
  cacheTtlSeconds: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type TableConfig = z.infer<typeof tableConfigSchema>;
