import {
  BadRequestError,
  ForbiddenError,
  type GetTableCacheStatusResult,
  type GetSchemaResult,
  type ListRowsQuery,
  NotFoundError,
  type RowEnvelope,
  type RowRecord,
  type TableCacheStatus,
  type TableConfig,
  type TableDoRequest,
  type TableDoResponse
} from '@sheetflare/contracts';
import {
  applyListRowsQuery,
  generateRowId,
  inferTableSchema,
  normalizeRowValues,
  pickKnownColumns
} from '@sheetflare/domain';
import { GoogleSheetsService, type GoogleSheetTableConfig } from '@sheetflare/google-sheets';
import type { CloudflareEnv } from '../types';
import { doRpc } from '../rpc';

type TableMetaRow = {
  key: string;
  value: string;
};

type CachedRowRow = {
  row_id: string;
  row_number: number;
  values_json: string;
};

type SyncMeta = {
  status: TableCacheStatus['status'];
  rowCount: number;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSyncError: string | null;
};

function getProjectStub(env: CloudflareEnv, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

export class TableDO {
  private readonly sheets: GoogleSheetsService;
  private activeSync: Promise<TableCacheStatus> | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {
    this.sheets = new GoogleSheetsService({
      clientEmail: env.GOOGLE_CLIENT_EMAIL,
      privateKey: env.GOOGLE_PRIVATE_KEY
    });
    this.initialize();
  }

  private initialize() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS row_index (
        row_id TEXT PRIMARY KEY,
        row_number INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_row_index_row_number
      ON row_index(row_number)
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cached_rows (
        row_id TEXT PRIMARY KEY,
        row_number INTEGER NOT NULL,
        values_json TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_rows_row_number
      ON cached_rows(row_number)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = (await request.json()) as TableDoRequest;
    const result = await this.handle(body);
    return Response.json(result);
  }

  private async handle(body: TableDoRequest): Promise<TableDoResponse> {
    switch (body.type) {
      case 'table.rows.list':
        return {
          type: 'table.rows.list.result',
          result: await this.listRows(body.projectSlug, body.tableSlug, body.query)
        };
      case 'table.row.get':
        return {
          type: 'table.row.get.result',
          result: await this.getRow(body.projectSlug, body.tableSlug, body.rowId)
        };
      case 'table.row.create':
        return {
          type: 'table.row.create.result',
          result: await this.createRow(body.projectSlug, body.tableSlug, body.input.values)
        };
      case 'table.row.update':
        return {
          type: 'table.row.update.result',
          result: await this.updateRow(body.projectSlug, body.tableSlug, body.rowId, body.input.values)
        };
      case 'table.row.delete':
        return {
          type: 'table.row.delete.result',
          result: await this.deleteRow(body.projectSlug, body.tableSlug, body.rowId)
        };
      case 'table.schema.get':
        return {
          type: 'table.schema.get.result',
          result: await this.getSchema(body.projectSlug, body.tableSlug)
        };
      case 'table.cache.get':
        return {
          type: 'table.cache.get.result',
          result: await this.getCacheStatus(body.projectSlug, body.tableSlug)
        };
      case 'table.reindex':
        return {
          type: 'table.reindex.result',
          result: await this.syncCache(body.projectSlug, body.tableSlug, { force: true })
        };
    }
  }

  private async getTableConfig(projectSlug: string, tableSlug: string): Promise<GoogleSheetTableConfig> {
    const result = await doRpc<
      { type: 'project.get.result'; result: { project: { spreadsheetId: string }; tables: TableConfig[] } }
    >(getProjectStub(this.env, projectSlug), {
      type: 'project.get',
      projectSlug
    });

    const table = result.result.tables.find((entry) => entry.tableSlug === tableSlug);
    if (!table) {
      throw new NotFoundError(`Table ${projectSlug}/${tableSlug} was not found.`);
    }

    return {
      ...table,
      spreadsheetId: result.result.project.spreadsheetId
    };
  }

  private async listRows(projectSlug: string, tableSlug: string, rawQuery: ListRowsQuery) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureCacheReady(config);
    const rows = this.listCachedRows();
    const result = applyListRowsQuery(rows, rawQuery);

    return {
      data: result.data,
      nextCursor: result.nextCursor
    };
  }

  private async getRow(projectSlug: string, tableSlug: string, rowId: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureCacheReady(config);
    let resolved = this.getCachedRow(rowId);
    if (!resolved) {
      await this.syncCache(config.projectSlug, config.tableSlug, { force: true });
      resolved = this.getCachedRow(rowId);
    }

    if (!resolved) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    return {
      data: resolved
    };
  }

  private async createRow(projectSlug: string, tableSlug: string, input: RowRecord) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.createEnabled) {
      throw new ForbiddenError(`Creates are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureCacheReady(config);
    const headers = await this.getHeaders(config);
    const providedId = input[config.idColumn];
    const rowId = typeof providedId === 'string' && providedId.length > 0 ? providedId : generateRowId();
    const normalizedValues = normalizeRowValues({
      ...input,
      [config.idColumn]: rowId
    });
    const { values, ignoredKeys } = pickKnownColumns(normalizedValues, headers);
    const rowNumber = await this.sheets.appendRow(config, headers, values);

    this.upsertRowIndex(rowId, rowNumber);
    this.upsertCachedRow({
      id: rowId,
      rowNumber,
      values
    });
    this.markCacheFreshAfterMutation();

    return {
      data: {
        id: rowId,
        rowNumber,
        values
      },
      ignoredKeys
    };
  }

  private async updateRow(projectSlug: string, tableSlug: string, rowId: string, patch: Partial<RowRecord>) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.updateEnabled) {
      throw new ForbiddenError(`Updates are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureCacheReady(config);
    const headers = await this.getHeaders(config);
    const existingRow = await this.resolveRowById(config, rowId);
    if (!existingRow) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    const patchValues = Object.fromEntries(
      Object.entries(patch).filter((entry): entry is [string, RowRecord[string]] => entry[1] !== undefined)
    );
    const mergedValues = normalizeRowValues({
      ...existingRow.values,
      ...patchValues,
      [config.idColumn]: rowId
    });
    const { values, ignoredKeys } = pickKnownColumns(mergedValues, headers);
    await this.sheets.writeRow(config, existingRow.rowNumber, headers, values);
    this.upsertRowIndex(rowId, existingRow.rowNumber);
    this.upsertCachedRow({
      id: rowId,
      rowNumber: existingRow.rowNumber,
      values
    });
    this.markCacheFreshAfterMutation();

    return {
      data: {
        id: rowId,
        rowNumber: existingRow.rowNumber,
        values
      },
      ignoredKeys
    };
  }

  private async deleteRow(projectSlug: string, tableSlug: string, rowId: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.deleteEnabled) {
      throw new ForbiddenError(`Deletes are disabled for ${projectSlug}/${tableSlug}.`);
    }

    const existingRow = await this.resolveRowById(config, rowId);
    if (!existingRow) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    await this.sheets.deleteRow(config, existingRow.rowNumber);
    this.deleteRowIndex(rowId);
    await this.syncCache(projectSlug, tableSlug, { force: true });

    return {
      ok: true as const,
      deletedId: rowId
    };
  }

  private async getSchema(projectSlug: string, tableSlug: string): Promise<GetSchemaResult> {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureCacheReady(config);
    const rows = this.listCachedRows();
    return {
      data: inferTableSchema(rows.slice(0, 100))
    };
  }

  private async getCacheStatus(projectSlug: string, tableSlug: string): Promise<GetTableCacheStatusResult> {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    return {
      data: this.computeCacheStatus(config)
    };
  }

  private async ensureCacheReady(config: GoogleSheetTableConfig) {
    const cacheStatus = this.computeCacheStatus(config);
    if (cacheStatus.status === 'ready' && !cacheStatus.stale) {
      return cacheStatus;
    }

    return this.syncCache(config.projectSlug, config.tableSlug, {
      force: cacheStatus.rowCount === 0 || cacheStatus.status === 'error'
    });
  }

  private async syncCache(
    projectSlug: string,
    tableSlug: string,
    options: { force: boolean }
  ) {
    if (this.activeSync) {
      const cache = await this.activeSync;
      if (!options.force || !cache.stale) {
        return {
          ok: true as const,
          rowCount: cache.rowCount,
          cache
        };
      }
    }

    const config = await this.getTableConfig(projectSlug, tableSlug);
    const currentStatus = this.computeCacheStatus(config);
    if (!options.force && currentStatus.status === 'ready' && !currentStatus.stale) {
      return {
        ok: true as const,
        rowCount: currentStatus.rowCount,
        cache: currentStatus
      };
    }

    const syncPromise = this.performSync(config);
    this.activeSync = syncPromise;

    try {
      const cache = await syncPromise;
      return {
        ok: true as const,
        rowCount: cache.rowCount,
        cache
      };
    } finally {
      if (this.activeSync === syncPromise) {
        this.activeSync = null;
      }
    }
  }

  private async performSync(config: GoogleSheetTableConfig): Promise<TableCacheStatus> {
    const startedAt = new Date().toISOString();
    this.setSyncMeta({
      ...this.getSyncMeta(),
      status: 'syncing',
      lastSyncStartedAt: startedAt,
      lastSyncError: null
    });

    try {
      const headers = await this.sheets.readHeaders(config);
      this.setMeta('headers', JSON.stringify(headers));
      const rows = await this.sheets.readAllRows(config);

      this.ctx.storage.sql.exec(`DELETE FROM row_index`);
      this.ctx.storage.sql.exec(`DELETE FROM cached_rows`);

      for (const row of rows) {
        this.upsertRowIndex(row.id, row.rowNumber);
        this.upsertCachedRow(row);
      }

      const completedAt = new Date().toISOString();
      this.setSyncMeta({
        status: 'ready',
        rowCount: rows.length,
        lastSyncStartedAt: startedAt,
        lastSyncCompletedAt: completedAt,
        lastSyncError: null
      });

      return this.computeCacheStatus(config);
    } catch (error) {
      this.setSyncMeta({
        ...this.getSyncMeta(),
        status: 'error',
        lastSyncStartedAt: startedAt,
        lastSyncError: error instanceof Error ? error.message : 'Unknown sync error'
      });
      throw error;
    }
  }

  private async resolveRowById(config: GoogleSheetTableConfig, rowId: string): Promise<RowEnvelope | null> {
    await this.ensureCacheReady(config);

    const cached = this.getCachedRow(rowId);
    const rowNumberHint = cached?.rowNumber ?? this.lookupRowNumber(rowId);
    const result = await this.sheets.findRowById(config, rowId, rowNumberHint);
    if (!result) {
      this.deleteRowIndex(rowId);
      this.deleteCachedRow(rowId);
      return null;
    }

    if (result.duplicateCount > 1) {
      throw new BadRequestError(
        `Duplicate managed row id detected for ${rowId}.`,
        { rowId, duplicateCount: result.duplicateCount, idColumn: config.idColumn }
      );
    }

    this.upsertRowIndex(rowId, result.row.rowNumber);
    this.upsertCachedRow(result.row);
    return result.row;
  }

  private listCachedRows(): RowEnvelope[] {
    const rows = this.ctx.storage.sql
      .exec(`SELECT row_id, row_number, values_json FROM cached_rows ORDER BY row_number ASC`)
      .toArray() as CachedRowRow[];

    return rows.map((row) => ({
      id: row.row_id,
      rowNumber: row.row_number,
      values: JSON.parse(row.values_json) as RowRecord
    }));
  }

  private getCachedRow(rowId: string): RowEnvelope | null {
    const row = this.ctx.storage.sql
      .exec(`SELECT row_id, row_number, values_json FROM cached_rows WHERE row_id = ?`, rowId)
      .one() as CachedRowRow | null;

    if (!row) return null;
    return {
      id: row.row_id,
      rowNumber: row.row_number,
      values: JSON.parse(row.values_json) as RowRecord
    };
  }

  private lookupRowNumber(rowId: string): number | null {
    const row = this.ctx.storage.sql
      .exec(`SELECT row_number FROM row_index WHERE row_id = ?`, rowId)
      .one() as { row_number: number } | null;

    return row?.row_number ?? null;
  }

  private upsertRowIndex(rowId: string, rowNumber: number) {
    this.ctx.storage.sql.exec(
      `
      INSERT INTO row_index (row_id, row_number, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(row_id) DO UPDATE SET
        row_number = excluded.row_number,
        updated_at = excluded.updated_at
      `,
      rowId,
      rowNumber,
      new Date().toISOString()
    );
  }

  private deleteRowIndex(rowId: string) {
    this.ctx.storage.sql.exec(`DELETE FROM row_index WHERE row_id = ?`, rowId);
  }

  private upsertCachedRow(row: RowEnvelope) {
    this.ctx.storage.sql.exec(
      `
      INSERT INTO cached_rows (row_id, row_number, values_json)
      VALUES (?, ?, ?)
      ON CONFLICT(row_id) DO UPDATE SET
        row_number = excluded.row_number,
        values_json = excluded.values_json
      `,
      row.id,
      row.rowNumber,
      JSON.stringify(row.values)
    );
  }

  private deleteCachedRow(rowId: string) {
    this.ctx.storage.sql.exec(`DELETE FROM cached_rows WHERE row_id = ?`, rowId);
  }

  private async getHeaders(config: GoogleSheetTableConfig): Promise<string[]> {
    const cachedHeaders = this.getMeta('headers');
    if (cachedHeaders) {
      return JSON.parse(cachedHeaders) as string[];
    }

    const headers = await this.sheets.readHeaders(config);
    this.setMeta('headers', JSON.stringify(headers));
    return headers;
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec(`SELECT key, value FROM meta WHERE key = ?`, key)
      .one() as TableMetaRow | null;

    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      `
      INSERT INTO meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      key,
      value
    );
  }

  private getSyncMeta(): SyncMeta {
    return {
      status: (this.getMeta('sync.status') as SyncMeta['status'] | null) ?? 'idle',
      rowCount: Number(this.getMeta('sync.rowCount') ?? '0'),
      lastSyncStartedAt: this.getMeta('sync.lastSyncStartedAt'),
      lastSyncCompletedAt: this.getMeta('sync.lastSyncCompletedAt'),
      lastSyncError: this.getMeta('sync.lastSyncError')
    };
  }

  private setSyncMeta(meta: SyncMeta) {
    this.setMeta('sync.status', meta.status);
    this.setMeta('sync.rowCount', String(meta.rowCount));
    if (meta.lastSyncStartedAt) this.setMeta('sync.lastSyncStartedAt', meta.lastSyncStartedAt);
    else this.deleteMeta('sync.lastSyncStartedAt');
    if (meta.lastSyncCompletedAt) this.setMeta('sync.lastSyncCompletedAt', meta.lastSyncCompletedAt);
    else this.deleteMeta('sync.lastSyncCompletedAt');
    if (meta.lastSyncError) this.setMeta('sync.lastSyncError', meta.lastSyncError);
    else this.deleteMeta('sync.lastSyncError');
  }

  private deleteMeta(key: string) {
    this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
  }

  private computeCacheStatus(config: GoogleSheetTableConfig): TableCacheStatus {
    const meta = this.getSyncMeta();
    const lastSyncMs = meta.lastSyncCompletedAt ? Date.parse(meta.lastSyncCompletedAt) : Number.NaN;
    const stale = !meta.lastSyncCompletedAt || Number.isNaN(lastSyncMs)
      ? true
      : Date.now() - lastSyncMs > config.cacheTtlSeconds * 1000;

    return {
      status: meta.status,
      cacheTtlSeconds: config.cacheTtlSeconds,
      stale,
      rowCount: meta.rowCount,
      lastSyncStartedAt: meta.lastSyncStartedAt,
      lastSyncCompletedAt: meta.lastSyncCompletedAt,
      lastSyncError: meta.lastSyncError
    };
  }

  private markCacheFreshAfterMutation() {
    const now = new Date().toISOString();
    this.setSyncMeta({
      status: 'ready',
      rowCount: this.countCachedRows(),
      lastSyncStartedAt: now,
      lastSyncCompletedAt: now,
      lastSyncError: null
    });
  }

  private countCachedRows() {
    const row = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS count FROM cached_rows`)
      .one() as { count: number } | null;

    return row?.count ?? 0;
  }
}
