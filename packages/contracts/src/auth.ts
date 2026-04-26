import { z } from 'zod';
import { apiKeyIdSchema, projectSlugSchema } from './ids';

export const apiScopeSchema = z.enum([
  'project:read',
  'project:write',
  'table:read',
  'table:create',
  'table:update',
  'table:delete',
  'admin:keys',
  'admin:logs'
]);

export const apiKeyRecordSchema = z.object({
  id: apiKeyIdSchema,
  projectSlug: projectSlugSchema,
  name: z.string().min(1),
  hash: z.string().min(1),
  scopes: z.array(apiScopeSchema),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable()
});

export type ApiScope = z.infer<typeof apiScopeSchema>;
export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;
