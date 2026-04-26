import type {
  AdminGetProjectResult,
  AdminListProjectsResult,
  CreateProjectInput,
  CreateRowInput,
  CreateTableInput,
  DeleteRowResult,
  GetRowResult,
  GetSchemaResult,
  ReindexTableResult,
  UpdateRowInput,
  UpdateRowResult,
  UpsertTableResult
} from './api';
import type { ListRowsQuery, ListRowsResult } from './table';

export type RegistryDoRequest =
  | { type: 'registry.projects.list' }
  | { type: 'registry.project.upsert'; summary: { slug: string; name: string; spreadsheetId: string; tableCount: number; updatedAt: string } };

export type RegistryDoResponse =
  | { type: 'registry.projects.list.result'; result: AdminListProjectsResult }
  | { type: 'registry.project.upsert.result'; result: { ok: true } };

export type ProjectDoRequest =
  | { type: 'project.get'; projectSlug: string }
  | { type: 'project.create'; input: CreateProjectInput }
  | { type: 'project.table.create'; projectSlug: string; input: CreateTableInput }
  | { type: 'project.table.list'; projectSlug: string }
  | { type: 'project.table.get'; projectSlug: string; tableSlug: string };

export type ProjectDoResponse =
  | { type: 'project.get.result'; result: AdminGetProjectResult }
  | { type: 'project.create.result'; result: AdminGetProjectResult }
  | { type: 'project.table.create.result'; result: UpsertTableResult }
  | { type: 'project.table.list.result'; result: { data: UpsertTableResult['data'][] } }
  | { type: 'project.table.get.result'; result: UpsertTableResult };

export type TableDoRequest =
  | { type: 'table.rows.list'; projectSlug: string; tableSlug: string; query: ListRowsQuery }
  | { type: 'table.row.get'; projectSlug: string; tableSlug: string; rowId: string }
  | { type: 'table.row.create'; projectSlug: string; tableSlug: string; input: CreateRowInput }
  | { type: 'table.row.update'; projectSlug: string; tableSlug: string; rowId: string; input: UpdateRowInput }
  | { type: 'table.row.delete'; projectSlug: string; tableSlug: string; rowId: string }
  | { type: 'table.schema.get'; projectSlug: string; tableSlug: string }
  | { type: 'table.reindex'; projectSlug: string; tableSlug: string };

export type TableDoResponse =
  | { type: 'table.rows.list.result'; result: ListRowsResult }
  | { type: 'table.row.get.result'; result: GetRowResult }
  | { type: 'table.row.create.result'; result: import('./api').CreateRowResult }
  | { type: 'table.row.update.result'; result: UpdateRowResult }
  | { type: 'table.row.delete.result'; result: DeleteRowResult }
  | { type: 'table.schema.get.result'; result: GetSchemaResult }
  | { type: 'table.reindex.result'; result: ReindexTableResult };
