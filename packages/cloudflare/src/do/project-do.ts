import {
  type AdminInspectSpreadsheetTabResult,
  type AdminListSpreadsheetTabsResult,
  type AdminGetProjectResult,
  BadRequestError,
  ConflictError,
  type ControlPlaneDoResponse,
  type CreateProjectInput,
  type CreateTableInput,
  maxIndexedFieldCount,
  NotFoundError,
  type ProjectAccessResult,
  type ProjectConfig,
  type ProjectDoRequest,
  type ProjectDoResponse,
  type ProjectSummary,
  type ResolvedProjectTableResult,
  type TableConfig
} from '@sheetflare/contracts';
import { normalizeFieldRules } from '@sheetflare/domain';
import { GoogleSheetsService } from '@sheetflare/google-sheets';
import type { CloudflareEnv } from '../types';
import { doRpc } from '../rpc';
import { defaultGoogleCredentialRef, resolveGoogleCredential } from '../google-credentials';

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
  read_only_fields: string;
  field_rules: string;
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

function normalizeOptionalFieldName(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeFieldNames(values: readonly string[]) {
  const normalized = new Set<string>();
  for (const value of values) {
    const next = value.trim();
    if (!next) {
      continue;
    }

    normalized.add(next);
  }

  return [...normalized];
}

export class ProjectDO {
  private readonly sheetsByCredentialRef = new Map<string, GoogleSheetsService>();

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
        read_only_fields TEXT NOT NULL DEFAULT '[]',
        field_rules TEXT NOT NULL DEFAULT '{}',
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

    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tables ADD COLUMN read_only_fields TEXT NOT NULL DEFAULT '[]'`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error;
      }
    }

    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tables ADD COLUMN field_rules TEXT NOT NULL DEFAULT '{}'`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error;
      }
    }
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
          result: await this.createProject(body.input, body.allowExisting ?? false)
        };
      case 'project.get':
        return {
          type: 'project.get.result',
          result: await this.getProject(body.projectSlug)
        };
      case 'project.access.get':
        return {
          type: 'project.access.get.result',
          result: {
            data: this.getProjectAccess(body.projectSlug)
          }
        };
      case 'project.table.create':
        return {
          type: 'project.table.create.result',
          result: await this.createTable(body.projectSlug, body.input, body.allowExisting ?? false)
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
      case 'project.table.resolve':
        return {
          type: 'project.table.resolve.result',
          result: {
            data: await this.resolveProjectTable(body.projectSlug, body.tableSlug)
          }
        };
      case 'project.spreadsheet.tabs.list':
        return {
          type: 'project.spreadsheet.tabs.list.result',
          result: await this.listSpreadsheetTabs(body.projectSlug)
        };
      case 'project.spreadsheet.tab.inspect':
        return {
          type: 'project.spreadsheet.tab.inspect.result',
          result: await this.inspectSpreadsheetTab(body.projectSlug, body.tab, body.headerRow)
        };
    }
  }

  private async createProject(
    input: CreateProjectInput,
    allowExisting: boolean
  ): Promise<{ data: AdminGetProjectResult; created: boolean }> {
    const now = new Date().toISOString();
    const googleCredentialRef = normalizeOptionalFieldName(input.googleCredentialRef) ?? defaultGoogleCredentialRef;

    resolveGoogleCredential(this.env, googleCredentialRef);
    const existing = this.selectOptionalRow<ProjectRow>(`SELECT * FROM project WHERE slug = ?`, input.slug);

    if (!allowExisting) {
      if (existing) {
        throw new ConflictError(`Project ${input.slug} already exists.`, {
          projectSlug: input.slug
        });
      }
    }

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
      googleCredentialRef,
      input.defaultAuthMode ?? 'private',
      now,
      now
    );

    await this.syncRegistry(input.slug);
    return {
      data: await this.getProject(input.slug),
      created: existing === null
    };
  }

  private async getProject(projectSlug: string): Promise<AdminGetProjectResult> {
    const project = this.requireProjectRow(projectSlug);

    return {
      project: this.mapProject(project),
      tables: await this.listTables(projectSlug)
    };
  }

  private getProjectAccess(projectSlug: string): ProjectAccessResult {
    const project = this.requireProjectRow(projectSlug);
    return {
      slug: project.slug,
      defaultAuthMode: project.default_auth_mode
    };
  }

  private async createTable(
    projectSlug: string,
    input: CreateTableInput,
    allowExisting: boolean
  ): Promise<{ data: TableConfig; created: boolean }> {
    const project = this.mapProject(this.requireProjectRow(projectSlug));
    const now = new Date().toISOString();
    const idColumn = normalizeOptionalFieldName(input.idColumn) ?? '_id';
    const indexedFields = this.buildIndexedFields(idColumn, normalizeFieldNames(input.indexedFields ?? []));
    const readOnlyFields = normalizeFieldNames(input.readOnlyFields ?? []);
    const fieldRules = normalizeFieldRules(input.fieldRules);
    const headerRow = input.headerRow ?? 1;
    const dataStartRow = input.dataStartRow ?? 2;
    const existing = this.selectOptionalRow<TableRow>(
      `SELECT * FROM tables WHERE project_slug = ? AND table_slug = ?`,
      projectSlug,
      input.tableSlug
    );

    this.validateTableConfig({
      idColumn,
      headerRow,
      dataStartRow,
      indexedFields,
      fieldRules
    });
    if (!allowExisting) {
      if (existing) {
        throw new ConflictError(`Table ${projectSlug}/${input.tableSlug} already exists.`, {
          projectSlug,
          tableSlug: input.tableSlug
        });
      }
    }
    await this.validateTableConfigAgainstSpreadsheet(project, {
      sheetTabName: input.sheetTabName,
      idColumn,
      indexedFields,
      readOnlyFields,
      fieldRules,
      headerRow,
      ...(input.sheetGid !== undefined ? { sheetGid: input.sheetGid } : {})
    });

    this.ctx.storage.sql.exec(
      `
      INSERT INTO tables (
        project_slug, table_slug, sheet_tab_name, sheet_gid, id_column, indexed_fields, read_only_fields, field_rules, header_row, data_start_row,
        read_enabled, create_enabled, update_enabled, delete_enabled, cache_ttl_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_slug, table_slug) DO UPDATE SET
        sheet_tab_name = excluded.sheet_tab_name,
        sheet_gid = excluded.sheet_gid,
        id_column = excluded.id_column,
        indexed_fields = excluded.indexed_fields,
        read_only_fields = excluded.read_only_fields,
        field_rules = excluded.field_rules,
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
      idColumn,
      JSON.stringify(indexedFields),
      JSON.stringify(readOnlyFields),
      JSON.stringify(fieldRules),
      headerRow,
      dataStartRow,
      (input.readEnabled ?? true) ? 1 : 0,
      (input.createEnabled ?? true) ? 1 : 0,
      (input.updateEnabled ?? true) ? 1 : 0,
      (input.deleteEnabled ?? true) ? 1 : 0,
      input.cacheTtlSeconds ?? 15,
      now,
      now
    );

    this.ctx.storage.sql.exec(`UPDATE project SET updated_at = ? WHERE slug = ?`, now, projectSlug);

    await this.syncRegistry(project.slug);
    return {
      data: await this.getTable(projectSlug, input.tableSlug),
      created: existing === null
    };
  }

  private async getTable(projectSlug: string, tableSlug: string): Promise<TableConfig> {
    const table = this.selectOptionalRow<TableRow>(
      `SELECT * FROM tables WHERE project_slug = ? AND table_slug = ?`,
      projectSlug,
      tableSlug
    );

    if (!table) {
      throw new NotFoundError(`Table ${projectSlug}/${tableSlug} was not found.`);
    }

    return this.mapTable(table);
  }

  private async resolveProjectTable(projectSlug: string, tableSlug: string): Promise<ResolvedProjectTableResult> {
    const project = this.mapProject(this.requireProjectRow(projectSlug));
    const table = await this.getTable(projectSlug, tableSlug);

    return {
      project: {
        slug: project.slug,
        spreadsheetId: project.spreadsheetId,
        googleCredentialRef: project.googleCredentialRef,
        defaultAuthMode: project.defaultAuthMode
      },
      table,
      resolvedConfig: {
        ...table,
        spreadsheetId: project.spreadsheetId,
        googleCredentialRef: project.googleCredentialRef
      }
    };
  }

  private async listTables(projectSlug: string): Promise<TableConfig[]> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM tables WHERE project_slug = ? ORDER BY table_slug ASC`, projectSlug)
      .toArray() as TableRow[];

    return rows.map((row) => this.mapTable(row));
  }

  private async listSpreadsheetTabs(projectSlug: string): Promise<AdminListSpreadsheetTabsResult> {
    const project = this.mapProject(this.requireProjectRow(projectSlug));
    const sheets = this.getSheetsClient(project.googleCredentialRef);
    return {
      data: await sheets.listSheetTabs(project.spreadsheetId)
    };
  }

  private async inspectSpreadsheetTab(
    projectSlug: string,
    tab: string,
    headerRow: number | undefined
  ): Promise<AdminInspectSpreadsheetTabResult> {
    const project = this.mapProject(this.requireProjectRow(projectSlug));
    const sheets = this.getSheetsClient(project.googleCredentialRef);
    const normalizedTab = tab.trim();
    const resolvedHeaderRow = headerRow ?? 1;

    if (!normalizedTab) {
      throw new BadRequestError('Spreadsheet tab name is required.');
    }

    if (!Number.isInteger(resolvedHeaderRow) || resolvedHeaderRow <= 0) {
      throw new BadRequestError('headerRow must be a positive integer.', {
        headerRow: resolvedHeaderRow
      });
    }

    const tabs = await sheets.listSheetTabs(project.spreadsheetId);
    const matchedTab = tabs.find((entry) => entry.title === normalizedTab);
    if (!matchedTab) {
      throw new NotFoundError(`Sheet tab ${normalizedTab} was not found in spreadsheet ${project.spreadsheetId}.`, {
        sheetTabName: normalizedTab,
        spreadsheetId: project.spreadsheetId
      });
    }

    const headers = await sheets.readHeaderNames(project.spreadsheetId, matchedTab.title, resolvedHeaderRow);

    return {
      data: {
        tab: matchedTab,
        headerRow: resolvedHeaderRow,
        headers
      }
    };
  }

  private selectOptionalRow<Row>(query: string, ...params: unknown[]): Row | null {
    const rows = this.ctx.storage.sql.exec(query, ...params).toArray() as Row[];
    return rows[0] ?? null;
  }

  private async syncRegistry(projectSlug: string) {
    const summary = this.getProjectSummary(projectSlug);
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(this.env), {
      type: 'control.project.upsert',
      summary
    });
  }

  private getProjectSummary(projectSlug: string): ProjectSummary {
    const project = this.requireProjectRow(projectSlug);

    const countRow = this.selectOptionalRow<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tables WHERE project_slug = ?`,
      projectSlug
    );

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
      readOnlyFields: JSON.parse(row.read_only_fields) as string[],
      fieldRules: JSON.parse(row.field_rules) as TableConfig['fieldRules'],
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

  private validateTableConfig(config: {
    idColumn: string;
    headerRow: number;
    dataStartRow: number;
    indexedFields: string[];
    fieldRules: TableConfig['fieldRules'];
  }) {
    if (config.dataStartRow <= config.headerRow) {
      throw new BadRequestError('dataStartRow must be greater than headerRow.', {
        headerRow: config.headerRow,
        dataStartRow: config.dataStartRow
      });
    }

    if (config.indexedFields.length > maxIndexedFieldCount) {
      throw new BadRequestError(
        `A table may index at most ${maxIndexedFieldCount} fields including the managed ID column.`,
        {
          indexedFieldCount: config.indexedFields.length,
          maxIndexedFieldCount
        }
      );
    }

    for (const [fieldName, rule] of Object.entries(config.fieldRules)) {
      if (rule.enum && rule.enum.length === 0) {
        throw new BadRequestError(`Field rule enum for ${fieldName} must include at least one value.`, {
          field: fieldName
        });
      }

      if (rule.unique && !config.indexedFields.includes(fieldName)) {
        throw new BadRequestError(`Unique field ${fieldName} must also be indexed.`, {
          field: fieldName,
          indexedFields: config.indexedFields
        });
      }
    }
  }

  private async validateTableConfigAgainstSpreadsheet(
    project: ProjectConfig,
    config: {
      sheetTabName: string;
      sheetGid?: number;
      idColumn: string;
      indexedFields: string[];
      readOnlyFields: string[];
      fieldRules: TableConfig['fieldRules'];
      headerRow: number;
    }
  ) {
    const sheets = this.getSheetsClient(project.googleCredentialRef);
    const tabs = await sheets.listSheetTabs(project.spreadsheetId);
    const matchedTab = tabs.find((entry) => entry.title === config.sheetTabName);
    if (!matchedTab) {
      throw new BadRequestError(`Sheet tab ${config.sheetTabName} was not found in spreadsheet ${project.spreadsheetId}.`, {
        sheetTabName: config.sheetTabName,
        spreadsheetId: project.spreadsheetId
      });
    }

    if (config.sheetGid !== undefined && config.sheetGid !== matchedTab.sheetGid) {
      throw new BadRequestError(
        `Sheet GID ${config.sheetGid} does not match tab ${config.sheetTabName} in spreadsheet ${project.spreadsheetId}.`,
        {
          sheetTabName: config.sheetTabName,
          providedSheetGid: config.sheetGid,
          actualSheetGid: matchedTab.sheetGid,
          spreadsheetId: project.spreadsheetId
        }
      );
    }

    const headers = await sheets.readHeaderNames(project.spreadsheetId, matchedTab.title, config.headerRow);
    const headerSet = new Set(headers);
    if (!headerSet.has(config.idColumn)) {
      throw new BadRequestError(`ID column ${config.idColumn} is not present in the detected sheet headers.`, {
        idColumn: config.idColumn,
        headers
      });
    }

    for (const fieldName of config.indexedFields) {
      if (!headerSet.has(fieldName)) {
        throw new BadRequestError(`Indexed field ${fieldName} is not present in the detected sheet headers.`, {
          field: fieldName,
          headers
        });
      }
    }

    for (const fieldName of config.readOnlyFields) {
      if (!headerSet.has(fieldName)) {
        throw new BadRequestError(`Read-only field ${fieldName} is not present in the detected sheet headers.`, {
          field: fieldName,
          headers
        });
      }
    }

    for (const fieldName of Object.keys(config.fieldRules)) {
      if (!headerSet.has(fieldName)) {
        throw new BadRequestError(`Field rule ${fieldName} is not present in the detected sheet headers.`, {
          field: fieldName,
          headers
        });
      }
    }
  }

  private requireProjectRow(projectSlug: string): ProjectRow {
    const project = this.selectOptionalRow<ProjectRow>(`SELECT * FROM project WHERE slug = ?`, projectSlug);

    if (!project) {
      throw new NotFoundError(`Project ${projectSlug} was not found.`);
    }

    return project;
  }

  private getSheetsClient(googleCredentialRef: string) {
    const existing = this.sheetsByCredentialRef.get(googleCredentialRef);
    if (existing) {
      return existing;
    }

    const credential = resolveGoogleCredential(this.env, googleCredentialRef);
    const service = new GoogleSheetsService(credential);
    this.sheetsByCredentialRef.set(googleCredentialRef, service);
    return service;
  }
}
