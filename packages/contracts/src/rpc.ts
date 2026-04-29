import type {
  AdminCreateApiKeyInput,
  AdminCreateApiKeyResult,
  AdminGetProjectResult,
  AdminInspectSpreadsheetTabResult,
  AdminListApiKeysResult,
  AdminListProjectsResult,
  AdminListSpreadsheetTabsResult,
  CreateProjectInput,
  CreateRowInput,
  CreateTableInput,
  DeleteRowResult,
  GetTableCacheStatusResult,
  GetRowResult,
  GetSchemaResult,
  RefreshTableCacheResult,
  ReindexTableResult,
  UpdateRowInput,
  UpdateRowResult,
  UpsertTableResult
} from './api';
import type { ApiKeyPrincipal } from './auth';
import type { ProjectConfig, TableConfig } from './project';
import type { ListRowsQuery, ListRowsResult } from './table';

export type ControlPlaneDoRequest =
  | { type: 'control.projects.list' }
  | { type: 'control.project.upsert'; summary: { slug: string; name: string; spreadsheetId: string; tableCount: number; updatedAt: string } }
  | { type: 'control.api-key.create'; input: AdminCreateApiKeyInput }
  | { type: 'control.api-keys.list'; projectSlug?: string | null }
  | { type: 'control.api-key.get'; apiKeyId: string }
  | { type: 'control.api-key.verify'; apiKeyId: string; hash: string }
  | { type: 'control.api-key.touch'; apiKeyId: string; usedAt: string }
  | { type: 'control.api-key.revoke'; apiKeyId: string; revokedAt: string };

export type ControlPlaneDoResponse =
  | { type: 'control.projects.list.result'; result: AdminListProjectsResult }
  | { type: 'control.project.upsert.result'; result: { ok: true } }
  | { type: 'control.api-key.create.result'; result: AdminCreateApiKeyResult }
  | { type: 'control.api-keys.list.result'; result: AdminListApiKeysResult }
  | { type: 'control.api-key.get.result'; result: { record: ApiKeyPrincipal | null } }
  | { type: 'control.api-key.verify.result'; result: { record: ApiKeyPrincipal | null } }
  | { type: 'control.api-key.touch.result'; result: { ok: true } }
  | { type: 'control.api-key.revoke.result'; result: { ok: true } };

export type ProjectDoRequest =
  | { type: 'project.get'; projectSlug: string }
  | { type: 'project.access.get'; projectSlug: string }
  | { type: 'project.create'; input: CreateProjectInput; allowExisting?: boolean }
  | { type: 'project.table.create'; projectSlug: string; input: CreateTableInput; allowExisting?: boolean }
  | { type: 'project.table.list'; projectSlug: string }
  | { type: 'project.table.get'; projectSlug: string; tableSlug: string }
  | { type: 'project.table.resolve'; projectSlug: string; tableSlug: string }
  | { type: 'project.spreadsheet.tabs.list'; projectSlug: string }
  | { type: 'project.spreadsheet.tab.inspect'; projectSlug: string; tab: string; headerRow?: number };

export type ProjectDoResponse =
  | { type: 'project.get.result'; result: AdminGetProjectResult }
  | { type: 'project.access.get.result'; result: { data: ProjectAccessResult } }
  | { type: 'project.create.result'; result: { data: AdminGetProjectResult; created: boolean } }
  | { type: 'project.table.create.result'; result: { data: UpsertTableResult['data']; created: boolean } }
  | { type: 'project.table.list.result'; result: { data: UpsertTableResult['data'][] } }
  | { type: 'project.table.get.result'; result: UpsertTableResult }
  | { type: 'project.table.resolve.result'; result: { data: ResolvedProjectTableResult } }
  | { type: 'project.spreadsheet.tabs.list.result'; result: AdminListSpreadsheetTabsResult }
  | { type: 'project.spreadsheet.tab.inspect.result'; result: AdminInspectSpreadsheetTabResult };

export type ResolvedTableConfigSnapshot = TableConfig & {
  spreadsheetId: string;
  googleCredentialRef: string;
};

export type ResolvedProjectTableResult = {
  project: Pick<ProjectConfig, 'slug' | 'spreadsheetId' | 'googleCredentialRef' | 'defaultAuthMode'>;
  table: TableConfig;
  resolvedConfig: ResolvedTableConfigSnapshot;
};

export type ProjectAccessResult = Pick<ProjectConfig, 'slug' | 'defaultAuthMode'>;

export type TableDoRequest =
  | { type: 'table.rows.list'; projectSlug: string; tableSlug: string; query: ListRowsQuery; resolvedConfig?: ResolvedTableConfigSnapshot; requestContext?: TableRequestContext }
  | { type: 'table.row.get'; projectSlug: string; tableSlug: string; rowId: string; resolvedConfig?: ResolvedTableConfigSnapshot; requestContext?: TableRequestContext }
  | { type: 'table.row.create'; projectSlug: string; tableSlug: string; input: CreateRowInput; requestContext?: TableRequestContext }
  | { type: 'table.row.update'; projectSlug: string; tableSlug: string; rowId: string; input: UpdateRowInput; requestContext?: TableRequestContext }
  | { type: 'table.row.delete'; projectSlug: string; tableSlug: string; rowId: string; requestContext?: TableRequestContext }
  | { type: 'table.schema.get'; projectSlug: string; tableSlug: string; resolvedConfig?: ResolvedTableConfigSnapshot; requestContext?: TableRequestContext }
  | { type: 'table.cache.get'; projectSlug: string; tableSlug: string; resolvedConfig?: ResolvedTableConfigSnapshot; requestContext?: TableRequestContext }
  | { type: 'table.cache.refresh'; projectSlug: string; tableSlug: string; resolvedConfig?: ResolvedTableConfigSnapshot; requestContext?: TableRequestContext }
  | { type: 'table.reindex'; projectSlug: string; tableSlug: string; resolvedConfig?: ResolvedTableConfigSnapshot; requestContext?: TableRequestContext };

export type TableDoResponse =
  | { type: 'table.rows.list.result'; result: ListRowsResult }
  | { type: 'table.row.get.result'; result: GetRowResult }
  | { type: 'table.row.create.result'; result: import('./api').CreateRowResult }
  | { type: 'table.row.update.result'; result: UpdateRowResult }
  | { type: 'table.row.delete.result'; result: DeleteRowResult }
  | { type: 'table.schema.get.result'; result: GetSchemaResult }
  | { type: 'table.cache.get.result'; result: GetTableCacheStatusResult }
  | { type: 'table.cache.refresh.result'; result: RefreshTableCacheResult }
  | { type: 'table.reindex.result'; result: ReindexTableResult };

export type TableRequestContext = {
  requestId: string;
  route: string;
  principal: string;
};

export type RateLimitDoRequest =
  | {
      type: 'rate-limit.check';
      key: string;
      limit: number;
      windowSeconds: number;
      nowMs?: number;
    };

export type RateLimitDoResponse =
  | {
      type: 'rate-limit.check.result';
      result: {
        allowed: boolean;
        remaining: number;
        resetAtMs: number;
      };
    };
