import { z } from 'zod';

export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const projectSlugSchema = z.string().min(1).regex(slugPattern);
export const tableSlugSchema = z.string().min(1).regex(slugPattern);
export const apiKeyIdSchema = z.string().min(1);
export const rowIdSchema = z.string().min(1);
export const sheetTabNameSchema = z.string().min(1);
export const spreadsheetIdSchema = z.string().min(1);

export type ProjectSlug = z.infer<typeof projectSlugSchema>;
export type TableSlug = z.infer<typeof tableSlugSchema>;
export type ApiKeyId = z.infer<typeof apiKeyIdSchema>;
export type RowId = z.infer<typeof rowIdSchema>;
export type SheetTabName = z.infer<typeof sheetTabNameSchema>;
export type SpreadsheetId = z.infer<typeof spreadsheetIdSchema>;
