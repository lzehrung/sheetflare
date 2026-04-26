import { z } from 'zod';
import { apiKeyIdSchema, projectSlugSchema } from './ids';

export const apiScopeSchema = z.enum([
  'project:read',
  'project:write',
  'table:read',
  'table:create',
  'table:update',
  'table:delete',
  'admin:projects',
  'admin:keys',
  'admin:logs'
]);

export const apiKeyRecordSchema = z.object({
  id: apiKeyIdSchema,
  projectSlug: projectSlugSchema.nullable(),
  name: z.string().min(1),
  hash: z.string().min(1),
  scopes: z.array(apiScopeSchema),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable()
});

export const apiKeyPrincipalSchema = apiKeyRecordSchema.omit({
  hash: true
});

export const createApiKeyInputSchema = z.object({
  name: z.string().min(1),
  projectSlug: projectSlugSchema.nullable().optional(),
  scopes: z.array(apiScopeSchema).min(1)
});

export const createApiKeyResultSchema = z.object({
  apiKey: z.string().min(1),
  record: apiKeyPrincipalSchema
});

export type ApiScope = z.infer<typeof apiScopeSchema>;
export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;
export type ApiKeyPrincipal = z.infer<typeof apiKeyPrincipalSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;
export type CreateApiKeyResult = z.infer<typeof createApiKeyResultSchema>;
