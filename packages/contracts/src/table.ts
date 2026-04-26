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

export const listRowsQuerySchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  cursor: z.string().min(1).nullable().optional(),
  sort: z.string().min(1).nullable().optional(),
  fields: z.array(z.string().min(1)).nullable().optional(),
  filter: z.record(z.string(), z.unknown()).nullable().optional()
});

export const listRowsResultSchema = z.object({
  data: z.array(rowEnvelopeSchema),
  nextCursor: z.string().min(1).nullable()
});

export type RowValue = z.infer<typeof rowValueSchema>;
export type RowRecord = z.infer<typeof rowRecordSchema>;
export type RowEnvelope = z.infer<typeof rowEnvelopeSchema>;
export type TableSchemaField = z.infer<typeof tableSchemaFieldSchema>;
export type TableSchema = z.infer<typeof tableSchemaSchema>;
export type ListRowsQuery = z.infer<typeof listRowsQuerySchema>;
export type ListRowsResult = z.infer<typeof listRowsResultSchema>;
