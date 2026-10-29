import { z } from 'zod';
import type {
  AdminRegisterSpreadsheetWatchesResult,
  AdminListSpreadsheetWatchRetryAdviceResult,
  AdminListSpreadsheetWatchesResult,
  AdminCreateApiKeyResult,
  AdminGetProjectResult,
  AdminInspectSpreadsheetTabResult,
  AdminListApiKeysResult,
  AdminListProjectsResult,
  AdminListSpreadsheetTabsResult,
  DeleteProjectResult,
  DeleteRowResult,
  DeleteTableResult,
  GetTableCacheStatusResult,
  GetRowResult,
  GetSchemaResult,
  RefreshTableCacheResult,
  ReindexTableResult,
  UpdateRowResult,
  UpsertTableResult
} from './api';
import {
  adminCreateApiKeyInputSchema,
  adminStopSpreadsheetWatchesInputSchema,
  createProjectInputSchema,
  createRowInputSchema,
  updateRowInputSchema
} from './api';
import type { ApiKeyPrincipal } from './auth';
import { apiKeyIdSchema, projectSlugSchema, rowIdSchema, tableSlugSchema } from './ids';
import type { ProjectConfig, TableConfig } from './project';
import { fieldRulesSchema, maxIndexedFieldCount, tableConfigSchema } from './project';
import type { ListRowsResult, TableDataGeneration } from './table';
import { listRowsQuerySchema } from './table';

export const tableRequestContextSchema = z.object({
  requestId: z.string().min(1),
  route: z.string().min(1),
  principal: z.string().min(1),
  syncSource: z.enum(['request', 'external-change']).optional()
});

export const resolvedTableConfigSnapshotSchema = tableConfigSchema.extend({
  spreadsheetId: z.string().min(1),
  googleCredentialRef: z.string().min(1)
});

const createTableRpcInputSchema = z.object({
  tableSlug: tableSlugSchema,
  sheetTabName: z.string().min(1),
  sheetGid: z.number().int().nonnegative().optional(),
  idColumn: z.string().min(1).optional(),
  indexedFields: z.array(z.string().min(1)).max(maxIndexedFieldCount).optional(),
  readOnlyFields: z.array(z.string().min(1)).optional(),
  fieldRules: fieldRulesSchema.optional(),
  headerRow: z.number().int().positive().optional(),
  dataStartRow: z.number().int().positive().optional(),
  readEnabled: z.boolean().optional(),
  createEnabled: z.boolean().optional(),
  updateEnabled: z.boolean().optional(),
  deleteEnabled: z.boolean().optional(),
  cacheTtlSeconds: tableConfigSchema.shape.cacheTtlSeconds.optional()
});

export const controlPlaneDoRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('control.projects.list') }),
  // Registers a project or updates its registration, which also ends its reservation. A pairing of spreadsheet and
  // credential ref that the project is not registered with yet is checked like a reservation and rejected with CONFLICT
  // when other projects, registered or being created, use the spreadsheet under a different ref. That backs up a
  // reservation that expired or was never made. Updating the pairing a project is registered with always succeeds.
  // ProjectDO also sends it to restore the registration of a project whose update did not complete, when the answer to
  // the update was lost and the control plane may have applied it.
  z.object({
    type: z.literal('control.project.upsert'),
    summary: z.object({
      slug: projectSlugSchema,
      name: z.string().min(1),
      spreadsheetId: z.string().min(1),
      googleCredentialRef: z.string().min(1),
      tableCount: z.number().int().nonnegative(),
      updatedAt: z.string().datetime()
    })
  }),
  // Sent by ProjectDO before it writes a new project or moves one to another spreadsheet or credential ref. In one step
  // the control plane rejects a spreadsheet that other projects, registered or being created, use under a different
  // credential ref, and otherwise records the project's claim to the spreadsheet so that a concurrent create sees it.
  // Reserving again for the same slug replaces its claim. The claim ends with the project's upsert or delete, with a
  // release, or after a few minutes, so a ProjectDO that dies before its write cannot hold the spreadsheet for good.
  // When `revokeApiKeys` is set because the slug has no project yet, API keys left bound to the slug by an earlier
  // project are revoked.
  z.object({
    type: z.literal('control.project.reserve'),
    projectSlug: projectSlugSchema,
    spreadsheetId: z.string().min(1),
    googleCredentialRef: z.string().min(1),
    revokeApiKeys: z.boolean()
  }),
  // Sent by ProjectDO when the write that follows a reservation fails, so the reservation stops holding the spreadsheet.
  z.object({
    type: z.literal('control.project.release'),
    projectSlug: projectSlugSchema
  }),
  // Removes a project from the registry, ends its reservation, revokes the API keys bound to its slug and stops Drive
  // watches that no remaining project uses. It is idempotent. ProjectDO sends it to delete a project, and to unregister
  // a project whose create did not complete when the answer to its registration was lost and the control plane may
  // have applied it.
  z.object({
    type: z.literal('control.project.delete'),
    projectSlug: projectSlugSchema
  }),
  z.object({ type: z.literal('control.spreadsheet-watches.list') }),
  z.object({ type: z.literal('control.spreadsheet-watches.retry-advice.list') }),
  z.object({
    type: z.literal('control.spreadsheet-watches.register'),
    webhookUrl: z.string().url(),
    webhookToken: z.string().min(1),
    debounceSeconds: z.number().int().positive(),
    expirationMs: z.number().int().positive().nullable().optional()
  }),
  z.object({
    type: z.literal('control.spreadsheet-watches.stop'),
    input: adminStopSpreadsheetWatchesInputSchema
  }),
  z.object({
    type: z.literal('control.spreadsheet-watch.notify'),
    channelId: z.string().min(1),
    resourceId: z.string().min(1),
    resourceState: z.string().min(1),
    messageNumber: z.string().nullable(),
    changedAt: z.string().datetime(),
    channelExpiration: z.string().nullable()
  }),
  z.object({
    type: z.literal('control.api-key.create'),
    input: adminCreateApiKeyInputSchema
  }),
  z.object({
    type: z.literal('control.api-keys.list'),
    projectSlug: projectSlugSchema.nullable().optional()
  }),
  z.object({
    type: z.literal('control.api-key.get'),
    apiKeyId: apiKeyIdSchema
  }),
  z.object({
    type: z.literal('control.api-key.verify'),
    apiKeyId: apiKeyIdSchema,
    hash: z.string().min(1)
  }),
  z.object({
    type: z.literal('control.api-key.touch'),
    apiKeyId: apiKeyIdSchema,
    usedAt: z.string().datetime()
  }),
  z.object({
    type: z.literal('control.api-key.revoke'),
    apiKeyId: apiKeyIdSchema,
    revokedAt: z.string().datetime()
  })
]);

export const projectDoRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project.get'),
    projectSlug: projectSlugSchema
  }),
  z.object({
    type: z.literal('project.create'),
    input: createProjectInputSchema,
    allowExisting: z.boolean().optional()
  }),
  z.object({
    type: z.literal('project.table.create'),
    projectSlug: projectSlugSchema,
    input: createTableRpcInputSchema,
    allowExisting: z.boolean().optional()
  }),
  z.object({
    type: z.literal('project.table.delete'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema
  }),
  z.object({
    type: z.literal('project.delete'),
    projectSlug: projectSlugSchema
  }),
  z.object({
    type: z.literal('project.table.list'),
    projectSlug: projectSlugSchema
  }),
  z.object({
    type: z.literal('project.table.get'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema
  }),
  z.object({
    type: z.literal('project.table.resolve'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema
  }),
  z.object({
    type: z.literal('project.spreadsheet.tabs.list'),
    projectSlug: projectSlugSchema
  }),
  z.object({
    type: z.literal('project.spreadsheet.tab.inspect'),
    projectSlug: projectSlugSchema,
    tab: z.string().min(1),
    headerRow: z.number().int().positive().optional()
  })
]);

export const tableDoRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('table.rows.list'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    query: listRowsQuerySchema,
    resolvedConfig: resolvedTableConfigSnapshotSchema.optional(),
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.row.get'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    rowId: rowIdSchema,
    resolvedConfig: resolvedTableConfigSnapshotSchema.optional(),
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.row.create'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    input: createRowInputSchema,
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.row.update'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    rowId: rowIdSchema,
    input: updateRowInputSchema,
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.row.delete'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    rowId: rowIdSchema,
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.schema.get'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    resolvedConfig: resolvedTableConfigSnapshotSchema.optional(),
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.cache.get'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    resolvedConfig: resolvedTableConfigSnapshotSchema.optional(),
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.cache.refresh'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    resolvedConfig: resolvedTableConfigSnapshotSchema.optional(),
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.cache.clear'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.external-change.record'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    changedAt: z.string().datetime(),
    debounceUntil: z.string().datetime().nullable(),
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.reindex'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    resolvedConfig: resolvedTableConfigSnapshotSchema.optional(),
    requestContext: tableRequestContextSchema.optional()
  }),
  z.object({
    type: z.literal('table.generation.get'),
    projectSlug: projectSlugSchema,
    tableSlug: tableSlugSchema,
    resolvedConfig: resolvedTableConfigSnapshotSchema.optional(),
    requestContext: tableRequestContextSchema.optional()
  })
]);

export const rateLimitDoRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rate-limit.check'),
    key: z.string().min(1),
    limit: z.number(),
    windowSeconds: z.number(),
    nowMs: z.number().optional()
  })
]);

export type ControlPlaneDoRequest = z.infer<typeof controlPlaneDoRequestSchema>;

// Result of control.spreadsheet-watch.notify. `changed` is true only when the notification recorded a new content
// change; sync messages and duplicate, replayed or out-of-order message numbers report false. `projectSlugs` lists the
// projects registered on the notified spreadsheet and is empty when the notification was not accepted.
export const spreadsheetWatchNotifyResultSchema = z.object({
  accepted: z.boolean(),
  spreadsheetId: z.string().min(1).nullable(),
  debounceUntil: z.string().datetime().nullable(),
  changed: z.boolean(),
  projectSlugs: z.array(projectSlugSchema)
});

export type SpreadsheetWatchNotifyResult = z.infer<typeof spreadsheetWatchNotifyResultSchema>;

export type ControlPlaneDoResponse =
  | { type: 'control.projects.list.result'; result: AdminListProjectsResult }
  | { type: 'control.project.upsert.result'; result: { ok: true } }
  | { type: 'control.project.reserve.result'; result: { ok: true } }
  | { type: 'control.project.release.result'; result: { ok: true } }
  | { type: 'control.project.delete.result'; result: { ok: true } }
  | { type: 'control.spreadsheet-watches.list.result'; result: AdminListSpreadsheetWatchesResult }
  | { type: 'control.spreadsheet-watches.retry-advice.list.result'; result: AdminListSpreadsheetWatchRetryAdviceResult }
  | { type: 'control.spreadsheet-watches.register.result'; result: AdminRegisterSpreadsheetWatchesResult }
  | { type: 'control.spreadsheet-watches.stop.result'; result: AdminRegisterSpreadsheetWatchesResult }
  | { type: 'control.spreadsheet-watch.notify.result'; result: SpreadsheetWatchNotifyResult }
  | { type: 'control.api-key.create.result'; result: AdminCreateApiKeyResult }
  | { type: 'control.api-keys.list.result'; result: AdminListApiKeysResult }
  | { type: 'control.api-key.get.result'; result: { record: ApiKeyPrincipal | null } }
  | { type: 'control.api-key.verify.result'; result: { record: ApiKeyPrincipal | null } }
  | { type: 'control.api-key.touch.result'; result: { ok: true } }
  | { type: 'control.api-key.revoke.result'; result: { ok: true } };

export type ProjectDoRequest = z.infer<typeof projectDoRequestSchema>;

export type ProjectDoResponse =
  | { type: 'project.get.result'; result: AdminGetProjectResult }
  | { type: 'project.create.result'; result: { data: AdminGetProjectResult; created: boolean } }
  | { type: 'project.table.create.result'; result: { data: UpsertTableResult['data']; created: boolean } }
  | { type: 'project.table.delete.result'; result: DeleteTableResult }
  | { type: 'project.delete.result'; result: DeleteProjectResult }
  | { type: 'project.table.list.result'; result: { data: UpsertTableResult['data'][] } }
  | { type: 'project.table.get.result'; result: UpsertTableResult }
  | { type: 'project.table.resolve.result'; result: { data: ResolvedProjectTableResult } }
  | { type: 'project.spreadsheet.tabs.list.result'; result: AdminListSpreadsheetTabsResult }
  | { type: 'project.spreadsheet.tab.inspect.result'; result: AdminInspectSpreadsheetTabResult };

export type ResolvedTableConfigSnapshot = z.infer<typeof resolvedTableConfigSnapshotSchema>;

export type ResolvedProjectTableResult = {
  project: Pick<ProjectConfig, 'slug' | 'spreadsheetId' | 'googleCredentialRef' | 'defaultAuthMode'>;
  table: TableConfig;
  resolvedConfig: ResolvedTableConfigSnapshot;
};

export type TableDoRequest = z.infer<typeof tableDoRequestSchema>;

export type TableDoResponse =
  | { type: 'table.rows.list.result'; result: ListRowsResult }
  | { type: 'table.row.get.result'; result: GetRowResult }
  | { type: 'table.row.create.result'; result: import('./api').CreateRowResult }
  | { type: 'table.row.update.result'; result: UpdateRowResult }
  | { type: 'table.row.delete.result'; result: DeleteRowResult }
  | { type: 'table.schema.get.result'; result: GetSchemaResult }
  | { type: 'table.cache.get.result'; result: GetTableCacheStatusResult }
  | { type: 'table.cache.refresh.result'; result: RefreshTableCacheResult }
  | { type: 'table.cache.clear.result'; result: { ok: true } }
  | { type: 'table.external-change.record.result'; result: { ok: true } }
  | { type: 'table.reindex.result'; result: ReindexTableResult }
  | { type: 'table.generation.get.result'; result: TableDataGeneration };

export type TableRequestContext = z.infer<typeof tableRequestContextSchema>;

export type RateLimitDoRequest = z.infer<typeof rateLimitDoRequestSchema>;

export type RateLimitDoResponse =
  | {
      type: 'rate-limit.check.result';
      result: {
        allowed: boolean;
        remaining: number;
        resetAtMs: number;
      };
    };
