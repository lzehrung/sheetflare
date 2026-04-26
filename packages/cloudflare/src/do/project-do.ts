import {
  type AdminGetProjectResult,
  type ControlPlaneDoResponse,
  type CreateProjectInput,
  type CreateTableInput,
  NotFoundError,
  type ProjectConfig,
  type ProjectDoRequest,
  type ProjectDoResponse,
  type ProjectSummary,
  type TableConfig
} from '@sheetflare/contracts';
import type { CloudflareEnv } from '../types';
import { doRpc } from '../rpc';
import { defaultGoogleCredentialRef } from '../google-credentials';

type ProjectRow = {
  slug: string;
  name: string;
  spreadsheet_id: string;
  google_credential_ref: string;
  default_auth_mode: 'private' | 'public-read';
  created_at: string;
  updated_at: string;
};

type TableRow = {
  project_slug: string;
  table_slug: string;
  sheet_tab_name: string;
  sheet_gid: number | null;
  id_column: string;
  indexed_fields: string;
  header_row: number;
  data_start_row: number;
  read_enabled: number;
  create_enabled: number;
  update_enabled: number;
  delete_enabled: number;
  cache_ttl_seconds: number;
  created_at: string;
  updated_at: string;
};

function getControlPlaneStub(env: CloudflareEnv) {
  return env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
}

export class ProjectDO {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {
    this.initialize();
  }

  private initialize() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spreadsheet_id TEXT NOT NULL,
        google_credential_ref TEXT NOT NULL,
        default_auth_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tables (
        project_slug TEXT NOT NULL,
        table_slug TEXT NOT NULL,
        sheet_tab_name TEXT NOT NULL,
        sheet_gid INTEGER,
        id_column TEXT NOT NULL,
        indexed_fields TEXT NOT NULL,
        header_row INTEGER NOT NULL,
        data_start_row INTEGER NOT NULL,
        read_enabled INTEGER NOT NULL,
        create_enabled INTEGER NOT NULL,
        update_enabled INTEGER NOT NULL,
        delete_enabled INTEGER NOT NULL,
        cache_ttl_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_slug, table_slug)
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = (await request.json()) as ProjectDoRequest;
    const result = await this.handle(body);
    return Response.json(result);
  }

  private async handle(body: ProjectDoRequest): Promise<ProjectDoResponse> {
    switch (body.type) {
      case 'project.create':
        return {
          type: 'project.create.result',
          result: await this.createProject(body.input)
        };
      case 'project.get':
        return {
          type: 'project.get.result',
          result: await this.getProject(body.projectSlug)
        };
      case 'project.table.create':
        return {
          type: 'project.table.create.result',
          result: {
            data: await this.createTable(body.projectSlug, body.input)
          }
        };
      case 'project.table.list':
        return {
          type: 'project.table.list.result',
          result: {
            data: await this.listTables(body.projectSlug)
          }
        };
      case 'project.table.get':
        return {
          type: 'project.table.get.result',
          result: {
            data: await this.getTable(body.projectSlug, body.tableSlug)
          }
        };
    }
  }

  private async createProject(input: CreateProjectInput): Promise<AdminGetProjectResult> {
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `
      INSERT INTO project (
        slug, name, spreadsheet_id, google_credential_ref, default_auth_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        spreadsheet_id = excluded.spreadsheet_id,
        google_credential_ref = excluded.google_credential_ref,
        default_auth_mode = excluded.default_auth_mode,
        updated_at = excluded.updated_at
      `,
      input.slug,
      input.name,
      input.spreadsheetId,
      input.googleCredentialRef ?? defaultGoogleCredentialRef,
      input.defaultAuthMode ?? 'private',
      now,
      now
    );

    await this.syncRegistry(input.slug);
    return this.getProject(input.slug);
  }

  private async getProject(projectSlug: string): Promise<AdminGetProjectResult> {
    const project = this.ctx.storage.sql
      .exec(`SELECT * FROM project WHERE slug = ?`, projectSlug)
      .one() as ProjectRow | null;

    if (!project) {
      throw new NotFoundError(`Project ${projectSlug} was not found.`);
    }

    return {
      project: this.mapProject(project),
      tables: await this.listTables(projectSlug)
    };
  }

  private async createTable(projectSlug: string, input: CreateTableInput): Promise<TableConfig> {
    const project = await this.getProject(projectSlug);
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `
      INSERT INTO tables (
        project_slug, table_slug, sheet_tab_name, sheet_gid, id_column, indexed_fields, header_row, data_start_row,
        read_enabled, create_enabled, update_enabled, delete_enabled, cache_ttl_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_slug, table_slug) DO UPDATE SET
        sheet_tab_name = excluded.sheet_tab_name,
        sheet_gid = excluded.sheet_gid,
        id_column = excluded.id_column,
        indexed_fields = excluded.indexed_fields,
        header_row = excluded.header_row,
        data_start_row = excluded.data_start_row,
        read_enabled = excluded.read_enabled,
        create_enabled = excluded.create_enabled,
        update_enabled = excluded.update_enabled,
        delete_enabled = excluded.delete_enabled,
        cache_ttl_seconds = excluded.cache_ttl_seconds,
        updated_at = excluded.updated_at
      `,
      projectSlug,
      input.tableSlug,
      input.sheetTabName,
      input.sheetGid ?? null,
      input.idColumn ?? '_id',
      JSON.stringify(this.buildIndexedFields(input.idColumn ?? '_id', input.indexedFields ?? [])),
      input.headerRow ?? 1,
      input.dataStartRow ?? 2,
      (input.readEnabled ?? true) ? 1 : 0,
      (input.createEnabled ?? true) ? 1 : 0,
      (input.updateEnabled ?? true) ? 1 : 0,
      (input.deleteEnabled ?? true) ? 1 : 0,
      input.cacheTtlSeconds ?? 15,
      now,
      now
    );

    this.ctx.storage.sql.exec(`UPDATE project SET updated_at = ? WHERE slug = ?`, now, projectSlug);

    await this.syncRegistry(project.project.slug);
    return this.getTable(projectSlug, input.tableSlug);
  }

  private async getTable(projectSlug: string, tableSlug: string): Promise<TableConfig> {
    const table = this.ctx.storage.sql
      .exec(`SELECT * FROM tables WHERE project_slug = ? AND table_slug = ?`, projectSlug, tableSlug)
      .one() as TableRow | null;

    if (!table) {
      throw new NotFoundError(`Table ${projectSlug}/${tableSlug} was not found.`);
    }

    return this.mapTable(table);
  }

  private async listTables(projectSlug: string): Promise<TableConfig[]> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM tables WHERE project_slug = ? ORDER BY table_slug ASC`, projectSlug)
      .toArray() as TableRow[];

    return rows.map((row) => this.mapTable(row));
  }

  private async syncRegistry(projectSlug: string) {
    const summary = this.getProjectSummary(projectSlug);
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(this.env), {
      type: 'control.project.upsert',
      summary
    });
  }

  private getProjectSummary(projectSlug: string): ProjectSummary {
    const project = this.ctx.storage.sql
      .exec(`SELECT * FROM project WHERE slug = ?`, projectSlug)
      .one() as ProjectRow | null;

    if (!project) {
      throw new NotFoundError(`Project ${projectSlug} was not found.`);
    }

    const countRow = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS count FROM tables WHERE project_slug = ?`, projectSlug)
      .one() as { count: number } | null;

    return {
      slug: project.slug,
      name: project.name,
      spreadsheetId: project.spreadsheet_id,
      tableCount: countRow?.count ?? 0,
      updatedAt: project.updated_at
    };
  }

  private mapProject(row: ProjectRow): ProjectConfig {
    return {
      slug: row.slug,
      name: row.name,
      spreadsheetId: row.spreadsheet_id,
      googleCredentialRef: row.google_credential_ref,
      defaultAuthMode: row.default_auth_mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapTable(row: TableRow): TableConfig {
    return {
      projectSlug: row.project_slug,
      tableSlug: row.table_slug,
      sheetTabName: row.sheet_tab_name,
      sheetGid: row.sheet_gid ?? undefined,
      idColumn: row.id_column,
      indexedFields: JSON.parse(row.indexed_fields) as string[],
      headerRow: row.header_row,
      dataStartRow: row.data_start_row,
      readEnabled: Boolean(row.read_enabled),
      createEnabled: Boolean(row.create_enabled),
      updateEnabled: Boolean(row.update_enabled),
      deleteEnabled: Boolean(row.delete_enabled),
      cacheTtlSeconds: row.cache_ttl_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private buildIndexedFields(idColumn: string, indexedFields: string[]) {
    const unique = new Set<string>([idColumn, ...indexedFields]);
    return [...unique].sort((left, right) => left.localeCompare(right));
  }
}
