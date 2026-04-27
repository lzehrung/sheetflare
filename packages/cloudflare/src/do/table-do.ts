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
  type TableDoRequest,
  type TableRequestContext,
  type TableDoResponse,
  type ResolvedTableConfigSnapshot
} from '@sheetflare/contracts';
import {
  assertQueryableField,
  buildFilterSql,
  compareStableStrings,
  compareQueryValues,
  compareRangeQueryValues,
  decodeQueryCursor,
  encodeQueryCursor,
  generateRowId,
  getListQueryFingerprint,
  normalizeListQuery,
  normalizeScalarCursorValue,
  sortRows,
  validateFilterCapabilities,
  inferTableSchema,
  normalizeRowValues,
  parseManagedRowId,
  pickKnownColumns
} from '@sheetflare/domain';
import { GoogleSheetsService, type GoogleSheetTableConfig } from '@sheetflare/google-sheets';
import type { CloudflareEnv } from '../types';
import { doRpc } from '../rpc';
import { resolveGoogleCredential } from '../google-credentials';

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

type CacheStaleReason = 'fresh' | 'never-synced' | 'ttl-expired' | 'config-changed' | 'error';

type CacheState = TableCacheStatus & {
  staleReason: CacheStaleReason;
};

type ResolvedTableConfig = GoogleSheetTableConfig & {
  googleCredentialRef: string;
};

const maxFullScanRows = 10_000;

function getCacheTableNames(kind: 'live' | 'staging') {
  return kind === 'live'
    ? {
        rowIndex: 'row_index',
        cachedRows: 'cached_rows',
        cachedCells: 'cached_cells'
      }
    : {
        rowIndex: 'row_index_staging',
        cachedRows: 'cached_rows_staging',
        cachedCells: 'cached_cells_staging'
      };
}

function assertUniqueManagedRowIds(rows: readonly RowEnvelope[], idColumn: string) {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const duplicateRowNumber = seen.get(row.id);
    if (duplicateRowNumber !== undefined) {
      throw new BadRequestError(`Duplicate managed row id detected for ${row.id}.`, {
        rowId: row.id,
        duplicateRowCount: 2,
        firstRowNumber: duplicateRowNumber,
        secondRowNumber: row.rowNumber,
        idColumn
      });
    }

    seen.set(row.id, row.rowNumber);
  }
}

function assertKnownWriteColumns(
  ignoredKeys: readonly string[],
  headers: readonly string[]
) {
  if (ignoredKeys.length === 0) {
    return;
  }

  throw new BadRequestError('Write payload contains unknown columns.', {
    ignoredKeys,
    headers
  });
}

function buildCacheConfigSignature(config: {
  spreadsheetId: string;
  googleCredentialRef: string;
  sheetTabName: string;
  sheetGid?: number | undefined;
  idColumn: string;
  indexedFields: readonly string[];
  headerRow: number;
  dataStartRow: number;
}) {
  return JSON.stringify({
    spreadsheetId: config.spreadsheetId,
    googleCredentialRef: config.googleCredentialRef,
    sheetTabName: config.sheetTabName,
    sheetGid: config.sheetGid ?? null,
    idColumn: config.idColumn,
    indexedFields: [...config.indexedFields].sort((left, right) => left.localeCompare(right)),
    headerRow: config.headerRow,
    dataStartRow: config.dataStartRow
  });
}

function getProjectStub(env: CloudflareEnv, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

export class TableDO {
  private readonly sheetsByCredentialRef = new Map<string, GoogleSheetsService>();
  private activeSync: Promise<TableCacheStatus> | null = null;
  private currentRequestContext: TableRequestContext | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {
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
      CREATE TABLE IF NOT EXISTS row_index_staging (
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
      CREATE INDEX IF NOT EXISTS idx_row_index_staging_row_number
      ON row_index_staging(row_number)
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cached_rows (
        row_id TEXT PRIMARY KEY,
        row_number INTEGER NOT NULL,
        values_json TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cached_rows_staging (
        row_id TEXT PRIMARY KEY,
        row_number INTEGER NOT NULL,
        values_json TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_rows_row_number
      ON cached_rows(row_number)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_rows_staging_row_number
      ON cached_rows_staging(row_number)
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cached_cells (
        row_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        value_kind TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_boolean INTEGER,
        PRIMARY KEY (row_id, field_name)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cached_cells_staging (
        row_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        value_kind TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_boolean INTEGER,
        PRIMARY KEY (row_id, field_name)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_cells_field_text
      ON cached_cells(field_name, value_text, row_id)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_cells_field_number
      ON cached_cells(field_name, value_number, row_id)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_cells_field_boolean
      ON cached_cells(field_name, value_boolean, row_id)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_cells_staging_field_text
      ON cached_cells_staging(field_name, value_text, row_id)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_cells_staging_field_number
      ON cached_cells_staging(field_name, value_number, row_id)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_cached_cells_staging_field_boolean
      ON cached_cells_staging(field_name, value_boolean, row_id)
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
    this.currentRequestContext = body.requestContext ?? null;
    try {
      switch (body.type) {
        case 'table.rows.list':
          return {
            type: 'table.rows.list.result',
            result: await this.listRows(body.projectSlug, body.tableSlug, body.query, body.resolvedConfig)
          };
        case 'table.row.get':
          return {
            type: 'table.row.get.result',
            result: await this.getRow(body.projectSlug, body.tableSlug, body.rowId, body.resolvedConfig)
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
            result: await this.getSchema(body.projectSlug, body.tableSlug, body.resolvedConfig)
          };
        case 'table.cache.get':
          return {
            type: 'table.cache.get.result',
            result: await this.getCacheStatus(body.projectSlug, body.tableSlug, body.resolvedConfig)
          };
        case 'table.reindex':
          return {
            type: 'table.reindex.result',
            result: await this.syncCache(
              body.projectSlug,
              body.tableSlug,
              body.resolvedConfig
                ? { force: true, resolvedConfig: body.resolvedConfig }
                : { force: true }
            )
          };
      }
    } finally {
      this.currentRequestContext = null;
    }
  }

  private async getTableConfig(
    projectSlug: string,
    tableSlug: string,
    resolvedConfig?: ResolvedTableConfigSnapshot
  ): Promise<ResolvedTableConfig> {
    if (resolvedConfig) {
      if (resolvedConfig.projectSlug !== projectSlug || resolvedConfig.tableSlug !== tableSlug) {
        throw new BadRequestError(`Resolved config does not match ${projectSlug}/${tableSlug}.`);
      }

      return resolvedConfig;
    }

    const result = await doRpc<
      {
        type: 'project.table.resolve.result';
        result: {
          data: {
            resolvedConfig: ResolvedTableConfigSnapshot;
          };
        };
      }
    >(getProjectStub(this.env, projectSlug), {
      type: 'project.table.resolve',
      projectSlug,
      tableSlug
    });
    return result.result.data.resolvedConfig;
  }

  private getSheetsClient(config: { googleCredentialRef: string }) {
    const existing = this.sheetsByCredentialRef.get(config.googleCredentialRef);
    if (existing) {
      return existing;
    }

    const credential = resolveGoogleCredential(this.env, config.googleCredentialRef);
    const service = new GoogleSheetsService(credential);
    this.sheetsByCredentialRef.set(config.googleCredentialRef, service);
    return service;
  }

  private async listRows(
    projectSlug: string,
    tableSlug: string,
    rawQuery: ListRowsQuery,
    resolvedConfig?: ResolvedTableConfigSnapshot
  ) {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureQueryCacheReady(config);
    const result = this.queryCachedRows(config, rawQuery);

    return {
      data: result.data,
      nextCursor: result.nextCursor
    };
  }

  private async getRow(
    projectSlug: string,
    tableSlug: string,
    rowId: string,
    resolvedConfig?: ResolvedTableConfigSnapshot
  ) {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    const cacheState = await this.ensurePointOperationReady(config);
    let resolved = cacheState.staleReason === 'fresh' ? this.getCachedRow(rowId) : null;
    if (!resolved) {
      resolved = await this.resolveRowById(config, rowId);
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

    await this.ensurePointOperationReady(config);
    const normalizedInput = normalizeRowValues(input);
    const headers = await this.getHeaders(config, {
      bypassCache: true
    });
    const hasProvidedId = Object.prototype.hasOwnProperty.call(normalizedInput, config.idColumn);
    const parsedManagedRowId = parseManagedRowId(normalizedInput[config.idColumn]);
    if (hasProvidedId && !parsedManagedRowId.ok) {
      throw new BadRequestError(
        `Managed row id for column ${config.idColumn} must be a non-blank string, number, or boolean.`,
        {
          idColumn: config.idColumn
        }
      );
    }

    const rowId = parsedManagedRowId.ok ? parsedManagedRowId.rowId : generateRowId();
    const existingRow = await this.resolveRowById(config, rowId);
    if (existingRow) {
      throw new BadRequestError(`Row ${rowId} already exists.`, {
        rowId,
        idColumn: config.idColumn
      });
    }

    const normalizedValues = normalizeRowValues({
      ...normalizedInput,
      [config.idColumn]: rowId
    });
    const { values, ignoredKeys } = pickKnownColumns(normalizedValues, headers);
    assertKnownWriteColumns(ignoredKeys, headers);
    const rowNumber = await this.getSheetsClient(config).appendRow(config, headers, values);

    this.upsertRowIndex(rowId, rowNumber);
    this.upsertCachedRow({
      id: rowId,
      rowNumber,
      values
    });
    this.upsertCachedCells(config, {
      id: rowId,
      rowNumber,
      values
    });
    this.refreshSchemaMeta(headers);
    this.markCacheFreshAfterMutation(config, headers);

    return {
      data: {
        id: rowId,
        rowNumber,
        values
      },
      ignoredKeys: []
    };
  }

  private async updateRow(projectSlug: string, tableSlug: string, rowId: string, patch: Partial<RowRecord>) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.updateEnabled) {
      throw new ForbiddenError(`Updates are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensurePointOperationReady(config);
    const headers = await this.getHeaders(config, {
      bypassCache: true
    });
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
    assertKnownWriteColumns(ignoredKeys, headers);
    await this.getSheetsClient(config).writeRow(config, existingRow.rowNumber, headers, values);
    this.upsertRowIndex(rowId, existingRow.rowNumber);
    this.upsertCachedRow({
      id: rowId,
      rowNumber: existingRow.rowNumber,
      values
    });
    this.upsertCachedCells(config, {
      id: rowId,
      rowNumber: existingRow.rowNumber,
      values
    });
    this.refreshSchemaMeta(headers);
    this.markCacheFreshAfterMutation(config, headers);

    return {
      data: {
        id: rowId,
        rowNumber: existingRow.rowNumber,
        values
      },
      ignoredKeys: []
    };
  }

  private async deleteRow(projectSlug: string, tableSlug: string, rowId: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.deleteEnabled) {
      throw new ForbiddenError(`Deletes are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensurePointOperationReady(config);
    const cachedHeaders = this.getMeta('headers');
    const headers = await this.getHeaders(config, {
      bypassCache: true
    });
    const existingRow = await this.resolveRowById(config, rowId);
    if (!existingRow) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    await this.getSheetsClient(config).deleteRow(config, existingRow.rowNumber);
    this.deleteRowIndex(rowId);
    this.deleteCachedRow(rowId);
    await this.refreshCachedRowNumbersAfterDelete(config, headers, cachedHeaders);
    this.refreshSchemaMeta(headers);
    this.markCacheFreshAfterMutation(config, headers);

    return {
      ok: true as const,
      deletedId: rowId
    };
  }

  private async getSchema(
    projectSlug: string,
    tableSlug: string,
    resolvedConfig?: ResolvedTableConfigSnapshot
  ): Promise<GetSchemaResult> {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureQueryCacheReady(config);
    return {
      data: this.getSchemaMeta(await this.getHeaders(config))
    };
  }

  private async getCacheStatus(
    projectSlug: string,
    tableSlug: string,
    resolvedConfig?: ResolvedTableConfigSnapshot
  ): Promise<GetTableCacheStatusResult> {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    return {
      data: this.computeCacheStatus(config)
    };
  }

  private async ensureQueryCacheReady(config: GoogleSheetTableConfig) {
    const cacheState = this.getCacheState(config);
    if (cacheState.staleReason === 'fresh') {
      return cacheState;
    }

    await this.syncCache(config.projectSlug, config.tableSlug, {
      force: cacheState.staleReason === 'never-synced' || cacheState.staleReason === 'error'
    });
    return this.getCacheState(config);
  }

  private async ensurePointOperationReady(config: GoogleSheetTableConfig) {
    const cacheState = this.getCacheState(config);
    if (cacheState.staleReason === 'fresh' || cacheState.staleReason === 'ttl-expired') {
      return cacheState;
    }

    await this.syncCache(config.projectSlug, config.tableSlug, { force: true });
    return this.getCacheState(config);
  }

  private async syncCache(
    projectSlug: string,
    tableSlug: string,
    options: { force: boolean; resolvedConfig?: ResolvedTableConfigSnapshot }
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

    const config = await this.getTableConfig(projectSlug, tableSlug, options.resolvedConfig);
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

  private async performSync(config: ResolvedTableConfig): Promise<TableCacheStatus> {
    const startedAt = new Date().toISOString();
    const syncStartedAtMs = Date.now();
    this.setSyncMeta({
      ...this.getSyncMeta(),
      status: 'syncing',
      lastSyncStartedAt: startedAt,
      lastSyncError: null
    });

    try {
      const sheets = this.getSheetsClient(config);
      const snapshot = await sheets.readTableSnapshot(config);
      const headers = snapshot.headers;
      const rows = snapshot.rows;
      assertUniqueManagedRowIds(rows, config.idColumn);
      const schema = inferTableSchema(headers, rows);
      this.clearCacheTables('staging');

      for (const row of rows) {
        this.upsertRowIndex(row.id, row.rowNumber, 'staging');
        this.upsertCachedRow(row, 'staging');
        this.upsertCachedCells(config, row, 'staging');
      }

      this.promoteStagingCache();

      const completedAt = new Date().toISOString();
      this.setMeta('headers', JSON.stringify(headers));
      this.setMeta('schema', JSON.stringify(schema));
      this.setMeta('config.signature', buildCacheConfigSignature(config));
      this.setSyncMeta({
        status: 'ready',
        rowCount: rows.length,
        lastSyncStartedAt: startedAt,
        lastSyncCompletedAt: completedAt,
        lastSyncError: null
      });
      console.info(JSON.stringify({
        event: 'table.sync.complete',
        projectSlug: config.projectSlug,
        tableSlug: config.tableSlug,
        rowCount: rows.length,
        durationMs: Date.now() - syncStartedAtMs,
        requestId: this.currentRequestContext?.requestId ?? null,
        route: this.currentRequestContext?.route ?? null,
        principal: this.currentRequestContext?.principal ?? null
      }));

      return this.computeCacheStatus(config);
    } catch (error) {
      this.clearCacheTables('staging');
      this.setSyncMeta({
        ...this.getSyncMeta(),
        status: 'error',
        lastSyncStartedAt: startedAt,
        lastSyncError: error instanceof Error ? error.message : 'Unknown sync error'
      });
      console.error(JSON.stringify({
        event: 'table.sync.failed',
        projectSlug: config.projectSlug,
        tableSlug: config.tableSlug,
        durationMs: Date.now() - syncStartedAtMs,
        errorMessage: error instanceof Error ? error.message : 'Unknown sync error',
        requestId: this.currentRequestContext?.requestId ?? null,
        route: this.currentRequestContext?.route ?? null,
        principal: this.currentRequestContext?.principal ?? null
      }));
      throw error;
    }
  }

  private async resolveRowById(
    config: ResolvedTableConfig,
    rowId: string,
    options?: { verifyUnique?: boolean }
  ): Promise<RowEnvelope | null> {
    const cached = this.getCachedRow(rowId);
    const rowNumberHint = cached?.rowNumber ?? this.lookupRowNumber(rowId);
    const result = await this.getSheetsClient(config).findRowById(config, rowId, rowNumberHint, options);
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
    this.upsertCachedCells(config, result.row);
    return result.row;
  }

  private async refreshCachedRowNumbersAfterDelete(
    config: ResolvedTableConfig,
    headers: string[],
    cachedHeaders: string | null
  ) {
    if (cachedHeaders !== JSON.stringify(headers)) {
      await this.syncCache(config.projectSlug, config.tableSlug, { force: true });
      return;
    }

    const references = await this.getSheetsClient(config).readRowReferences(config);
    if (!this.canRepairDeleteFromRowReferences(references)) {
      await this.syncCache(config.projectSlug, config.tableSlug, { force: true });
      return;
    }

    for (const reference of references) {
      this.updateCachedRowNumber(reference.rowId, reference.rowNumber);
    }
  }

  private canRepairDeleteFromRowReferences(
    references: Array<{ rowId: string; rowNumber: number }>
  ) {
    const cachedRows = this.listCachedRows();
    if (cachedRows.length !== references.length) {
      return false;
    }

    const cachedRowIds = new Set(cachedRows.map((row) => row.id));
    if (cachedRowIds.size !== cachedRows.length) {
      return false;
    }

    const seenRowIds = new Set<string>();
    for (const reference of references) {
      if (seenRowIds.has(reference.rowId)) {
        return false;
      }

      seenRowIds.add(reference.rowId);
      if (!cachedRowIds.has(reference.rowId)) {
        return false;
      }
    }

    return true;
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

  private upsertRowIndex(rowId: string, rowNumber: number, kind: 'live' | 'staging' = 'live') {
    const tables = getCacheTableNames(kind);
    this.ctx.storage.sql.exec(
      `
      INSERT INTO ${tables.rowIndex} (row_id, row_number, updated_at)
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

  private upsertCachedRow(row: RowEnvelope, kind: 'live' | 'staging' = 'live') {
    const tables = getCacheTableNames(kind);
    this.ctx.storage.sql.exec(
      `
      INSERT INTO ${tables.cachedRows} (row_id, row_number, values_json)
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
    this.ctx.storage.sql.exec(`DELETE FROM cached_cells WHERE row_id = ?`, rowId);
  }

  private updateCachedRowNumber(rowId: string, rowNumber: number) {
    this.ctx.storage.sql.exec(
      `
      UPDATE cached_rows
      SET row_number = ?
      WHERE row_id = ?
      `,
      rowNumber,
      rowId
    );
    this.upsertRowIndex(rowId, rowNumber);
  }

  private async getHeaders(config: ResolvedTableConfig, options?: { bypassCache?: boolean }): Promise<string[]> {
    const cachedHeaders = this.getMeta('headers');
    if (cachedHeaders && !options?.bypassCache) {
      return JSON.parse(cachedHeaders) as string[];
    }

    const headers = await this.getSheetsClient(config).readHeaders(config);
    this.setMeta('headers', JSON.stringify(headers));
    return headers;
  }

  private getSchemaMeta(headers: string[]) {
    const cachedSchema = this.getMeta('schema');
    if (cachedSchema) {
      return JSON.parse(cachedSchema) as GetSchemaResult['data'];
    }

    const schema = inferTableSchema(headers, this.listCachedRows());
    this.setMeta('schema', JSON.stringify(schema));
    return schema;
  }

  private getCacheState(config: GoogleSheetTableConfig & { googleCredentialRef?: string }): CacheState {
    const meta = this.getSyncMeta();
    const lastSyncMs = meta.lastSyncCompletedAt ? Date.parse(meta.lastSyncCompletedAt) : Number.NaN;
    const configSignature = 'googleCredentialRef' in config && config.googleCredentialRef
      ? buildCacheConfigSignature({
          spreadsheetId: config.spreadsheetId,
          googleCredentialRef: config.googleCredentialRef,
          sheetTabName: config.sheetTabName,
          sheetGid: config.sheetGid,
          idColumn: config.idColumn,
          indexedFields: config.indexedFields,
          headerRow: config.headerRow,
          dataStartRow: config.dataStartRow
        })
      : null;
    const signatureMatches = !configSignature || this.getMeta('config.signature') === configSignature;

    const staleReason: CacheStaleReason =
      meta.status === 'error'
        ? 'error'
        : !meta.lastSyncCompletedAt || Number.isNaN(lastSyncMs)
          ? 'never-synced'
          : !signatureMatches
            ? 'config-changed'
            : Date.now() - lastSyncMs > config.cacheTtlSeconds * 1000
              ? 'ttl-expired'
              : 'fresh';

    return {
      status: meta.status,
      cacheTtlSeconds: config.cacheTtlSeconds,
      stale: staleReason !== 'fresh',
      staleReason,
      rowCount: meta.rowCount,
      lastSyncStartedAt: meta.lastSyncStartedAt,
      lastSyncCompletedAt: meta.lastSyncCompletedAt,
      lastSyncError: meta.lastSyncError
    };
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

  private computeCacheStatus(config: GoogleSheetTableConfig & { googleCredentialRef?: string }): TableCacheStatus {
    const cacheState = this.getCacheState(config);
    return {
      status: cacheState.status,
      cacheTtlSeconds: cacheState.cacheTtlSeconds,
      stale: cacheState.stale,
      staleReason: cacheState.staleReason,
      rowCount: cacheState.rowCount,
      lastSyncStartedAt: cacheState.lastSyncStartedAt,
      lastSyncCompletedAt: cacheState.lastSyncCompletedAt,
      lastSyncError: cacheState.lastSyncError
    };
  }

  private markCacheFreshAfterMutation(config: ResolvedTableConfig, headers: string[]) {
    const now = new Date().toISOString();
    this.setMeta('headers', JSON.stringify(headers));
    this.setMeta('config.signature', buildCacheConfigSignature(config));
    this.setSyncMeta({
      status: 'ready',
      rowCount: this.countCachedRows(),
      lastSyncStartedAt: now,
      lastSyncCompletedAt: now,
      lastSyncError: null
    });
  }

  private refreshSchemaMeta(headers: string[]) {
    this.setMeta('schema', JSON.stringify(inferTableSchema(headers, this.listCachedRows())));
  }

  private countCachedRows(kind: 'live' | 'staging' = 'live') {
    const tables = getCacheTableNames(kind);
    const row = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS count FROM ${tables.cachedRows}`)
      .one() as { count: number } | null;

    return row?.count ?? 0;
  }

  private upsertCachedCells(config: GoogleSheetTableConfig, row: RowEnvelope, kind: 'live' | 'staging' = 'live') {
    const tables = getCacheTableNames(kind);
    this.ctx.storage.sql.exec(`DELETE FROM ${tables.cachedCells} WHERE row_id = ?`, row.id);

    for (const fieldName of config.indexedFields) {
      const value = row.values[fieldName] ?? null;
      const normalized = this.normalizeIndexedCellValue(value);
      this.ctx.storage.sql.exec(
        `
        INSERT INTO ${tables.cachedCells} (row_id, field_name, value_kind, value_text, value_number, value_boolean)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        row.id,
        fieldName,
        normalized.valueKind,
        normalized.valueText,
        normalized.valueNumber,
        normalized.valueBoolean
      );
    }
  }

  private clearCacheTables(kind: 'live' | 'staging') {
    const tables = getCacheTableNames(kind);
    this.ctx.storage.sql.exec(`DELETE FROM ${tables.rowIndex}`);
    this.ctx.storage.sql.exec(`DELETE FROM ${tables.cachedRows}`);
    this.ctx.storage.sql.exec(`DELETE FROM ${tables.cachedCells}`);
  }

  private promoteStagingCache() {
    const live = getCacheTableNames('live');
    const staging = getCacheTableNames('staging');
    this.ctx.storage.sql.exec('BEGIN');
    try {
      this.ctx.storage.sql.exec(`DELETE FROM ${live.rowIndex}`);
      this.ctx.storage.sql.exec(`DELETE FROM ${live.cachedRows}`);
      this.ctx.storage.sql.exec(`DELETE FROM ${live.cachedCells}`);
      this.ctx.storage.sql.exec(
        `INSERT INTO ${live.rowIndex} (row_id, row_number, updated_at) SELECT row_id, row_number, updated_at FROM ${staging.rowIndex}`
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO ${live.cachedRows} (row_id, row_number, values_json) SELECT row_id, row_number, values_json FROM ${staging.cachedRows}`
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO ${live.cachedCells} (row_id, field_name, value_kind, value_text, value_number, value_boolean)
         SELECT row_id, field_name, value_kind, value_text, value_number, value_boolean FROM ${staging.cachedCells}`
      );
      this.ctx.storage.sql.exec('COMMIT');
    } catch (error) {
      this.ctx.storage.sql.exec('ROLLBACK');
      throw error;
    } finally {
      this.clearCacheTables('staging');
    }
  }

  private normalizeIndexedCellValue(value: RowRecord[string]) {
    if (value === null) {
      return {
        valueKind: 'null',
        valueText: null,
        valueNumber: null,
        valueBoolean: null
      };
    }

    if (typeof value === 'boolean') {
      return {
        valueKind: 'boolean',
        valueText: null,
        valueNumber: null,
        valueBoolean: value ? 1 : 0
      };
    }

    if (typeof value === 'number') {
      return {
        valueKind: 'number',
        valueText: null,
        valueNumber: value,
        valueBoolean: null
      };
    }

    if (typeof value === 'string') {
      return {
        valueKind: 'string',
        valueText: value,
        valueNumber: null,
        valueBoolean: null
      };
    }

    return {
      valueKind: 'json',
      valueText: JSON.stringify(value),
      valueNumber: null,
      valueBoolean: null
    };
  }

  private queryCachedRows(config: GoogleSheetTableConfig, rawQuery: ListRowsQuery) {
    const query = normalizeListQuery(rawQuery);
    const fingerprint = getListQueryFingerprint(query);
    const cursor = decodeQueryCursor(query.cursor, fingerprint, query.sort);
    const filterPlan = buildFilterSql(query.filter, config.indexedFields);
    const capability = validateFilterCapabilities(query.filter, config.indexedFields);
    const requiresScan = capability.requiresFullScan || filterPlan.requiresFullScan;

    if (requiresScan) {
      if (this.countCachedRows() > maxFullScanRows) {
        throw new BadRequestError(
          `This query requires a full scan and exceeds the configured scan threshold of ${maxFullScanRows} cached rows.`,
          {
            maxFullScanRows,
            sort: query.sort,
            filter: query.filter
          }
        );
      }
      return this.queryCachedRowsByScan(config, query, fingerprint, cursor);
    }

    const sortPlan = this.buildSortPlan(config, query.sort.field, query.sort.direction);
    const cursorPlan = this.buildCursorPlan(sortPlan, cursor);
    const sql = [
      `SELECT cr.row_id, cr.row_number, cr.values_json${sortPlan.selectColumns}`,
      `FROM cached_rows cr`,
      ...filterPlan.joins,
      sortPlan.join,
      filterPlan.conditions.length > 0 || cursorPlan.conditions.length > 0
        ? `WHERE ${[...filterPlan.conditions, ...cursorPlan.conditions].join(' AND ')}`
        : '',
      `ORDER BY ${sortPlan.orderBy}`,
      `LIMIT ?`
    ]
      .filter(Boolean)
      .join('\n');

    const rows = this.ctx.storage.sql.exec(
      sql,
      ...filterPlan.parameters,
      ...sortPlan.parameters,
      ...cursorPlan.parameters,
      query.limit + 1
    ).toArray() as Array<
      CachedRowRow & {
        sort_kind?: string | null;
        sort_text?: string | null;
        sort_number?: number | null;
        sort_boolean?: number | null;
      }
    >;

    const page = rows.slice(0, query.limit).map((row) => this.mapCachedRow(row));
    const lastRow = rows.length > query.limit ? rows[query.limit - 1] : null;

    return {
      data: this.projectFields(page, query.fields),
      nextCursor:
        rows.length > query.limit && lastRow
          ? encodeQueryCursor({
              fingerprint,
              sortField: query.sort.field,
              sortDirection: query.sort.direction,
              rowId: lastRow.row_id,
              rowNumber: lastRow.row_number,
              value: this.getCursorValue(query.sort.field, lastRow)
            })
          : null
    };
  }

  private queryCachedRowsByScan(
    config: GoogleSheetTableConfig,
    query: ReturnType<typeof normalizeListQuery>,
    fingerprint: string,
    cursor: ReturnType<typeof decodeQueryCursor>
  ) {
    const sortField = query.sort.field;
    if (sortField !== 'rowNumber' && sortField !== 'id') {
      assertQueryableField(sortField, config.indexedFields, { allowId: true, allowRowNumber: true });
    }

    let rows = this.listCachedRows();
    if (query.filter) {
      rows = rows.filter((row: RowEnvelope) => this.matchesFilter(row, query.filter!));
    }

    const sorted = sortRows(rows, query.sort);

    const startIndex = cursor
      ? sorted.findIndex((row) => this.isRowAfterScanCursor(row, query.sort.field, query.sort.direction, cursor))
      : 0;
    const normalizedStartIndex = startIndex === -1 ? sorted.length : startIndex;
    const page = sorted.slice(normalizedStartIndex, normalizedStartIndex + query.limit);
    const hasMore = normalizedStartIndex + query.limit < sorted.length;
    const lastRow = page.at(-1);

    return {
      data: this.projectFields(page, query.fields),
      nextCursor:
        hasMore && lastRow
          ? encodeQueryCursor({
              fingerprint,
              sortField: query.sort.field,
              sortDirection: query.sort.direction,
              rowId: lastRow.id,
              rowNumber: lastRow.rowNumber,
              value: normalizeScalarCursorValue(
                query.sort.field === 'rowNumber'
                  ? lastRow.rowNumber
                  : query.sort.field === 'id'
                    ? lastRow.id
                    : this.normalizeCursorSourceValue(lastRow.values[query.sort.field])
              )
            })
          : null
    };
  }

  private buildSortPlan(
    config: GoogleSheetTableConfig,
    sortField: string,
    direction: 'asc' | 'desc'
  ) {
    if (sortField === 'rowNumber') {
      return {
        join: '',
        parameters: [] as Array<string | number | null>,
        selectColumns: '',
        orderBy: `cr.row_number ${direction.toUpperCase()}, cr.row_id ${direction.toUpperCase()}`,
        direction
      };
    }

    if (sortField === 'id') {
      return {
        join: '',
        parameters: [] as Array<string | number | null>,
        selectColumns: '',
        orderBy: `cr.row_id ${direction.toUpperCase()}`,
        direction
      };
    }

    assertQueryableField(sortField, config.indexedFields, { allowId: true, allowRowNumber: true });
    return {
      join: 'INNER JOIN cached_cells sort_cell ON sort_cell.row_id = cr.row_id AND sort_cell.field_name = ?',
      parameters: [sortField] as Array<string | number | null>,
      selectColumns:
        ', sort_cell.value_kind AS sort_kind, sort_cell.value_text AS sort_text, sort_cell.value_number AS sort_number, sort_cell.value_boolean AS sort_boolean',
      orderBy:
        queryDirectionAwareOrderBy('sort_cell', 'value_kind', 'value_text', 'value_number', 'value_boolean', direction),
      direction
    };
  }

  private buildCursorPlan(
    sortPlan: ReturnType<TableDO['buildSortPlan']>,
    cursor: ReturnType<typeof decodeQueryCursor>
  ) {
    if (!cursor) {
      return {
        conditions: [] as string[],
        parameters: [] as Array<string | number | null>
      };
    }

    if (!sortPlan.join) {
      if (cursor.sortField === 'rowNumber') {
        const comparator = sortPlan.direction === 'desc' ? '<' : '>';
        return {
          conditions: [`(cr.row_number ${comparator} ? OR (cr.row_number = ? AND cr.row_id ${comparator} ?))`],
          parameters: [cursor.rowNumber, cursor.rowNumber, cursor.rowId] as Array<string | number | null>
        };
      }

      const comparator = sortPlan.direction === 'desc' ? '<' : '>';
      return {
        conditions: [`cr.row_id ${comparator} ?`],
        parameters: [cursor.rowId] as Array<string | number | null>
      };
    }

    const valueRank = this.getValueKindRank(cursor.value.kind);
    const rankComparator = sortPlan.direction === 'desc' ? '<' : '>';
    const valueComparator = sortPlan.direction === 'desc' ? '<' : '>';
    const params: Array<string | number | null> = [valueRank];
    let sameValueClause = `cr.row_id ${valueComparator} ?`;

    switch (cursor.value.kind) {
      case 'null':
        params.push(cursor.rowId);
        break;
      case 'boolean':
        params.push(cursor.value.value ? 1 : 0, cursor.value.value ? 1 : 0, cursor.rowId);
        sameValueClause = `(sort_cell.value_boolean ${valueComparator} ? OR (sort_cell.value_boolean = ? AND cr.row_id ${valueComparator} ?))`;
        break;
      case 'number':
        params.push(cursor.value.value, cursor.value.value, cursor.rowId);
        sameValueClause = `(sort_cell.value_number ${valueComparator} ? OR (sort_cell.value_number = ? AND cr.row_id ${valueComparator} ?))`;
        break;
      case 'string':
        params.push(cursor.value.value, cursor.value.value, cursor.rowId);
        sameValueClause = `(sort_cell.value_text ${valueComparator} ? OR (sort_cell.value_text = ? AND cr.row_id ${valueComparator} ?))`;
        break;
    }

    return {
      conditions: [
        `(${this.getValueRankSql('sort_cell.value_kind')} ${rankComparator} ? OR (${this.getValueRankSql('sort_cell.value_kind')} = ? AND ${sameValueClause}))`
      ],
      parameters: [valueRank, ...params]
    };
  }

  private getValueRankSql(kindSql: string) {
    return `CASE ${kindSql} WHEN 'null' THEN 0 WHEN 'boolean' THEN 1 WHEN 'number' THEN 2 WHEN 'string' THEN 3 ELSE 4 END`;
  }

  private getValueKindRank(kind: string) {
    return {
      null: 0,
      boolean: 1,
      number: 2,
      string: 3
    }[kind] ?? 4;
  }

  private mapCachedRow(row: CachedRowRow): RowEnvelope {
    return {
      id: row.row_id,
      rowNumber: row.row_number,
      values: JSON.parse(row.values_json) as RowRecord
    };
  }

  private projectFields(rows: RowEnvelope[], fields: string[] | null) {
    if (!fields || fields.length === 0) return rows;
    const allowed = new Set(fields);
    return rows.map((row) => ({
      ...row,
      values: Object.fromEntries(
        Object.entries(row.values).filter(([key]) => allowed.has(key))
      )
    }));
  }

  private getCursorValue(sortField: string, row: CachedRowRow & { sort_kind?: string | null; sort_text?: string | null; sort_number?: number | null; sort_boolean?: number | null }) {
    if (sortField === 'rowNumber') {
      return normalizeScalarCursorValue(row.row_number);
    }

    if (sortField === 'id') {
      return normalizeScalarCursorValue(row.row_id);
    }

    switch (row.sort_kind) {
      case 'null':
        return normalizeScalarCursorValue(null);
      case 'boolean':
        return normalizeScalarCursorValue(Boolean(row.sort_boolean));
      case 'number':
        return normalizeScalarCursorValue(row.sort_number ?? 0);
      case 'string':
        return normalizeScalarCursorValue(row.sort_text ?? '');
      default:
        return normalizeScalarCursorValue(row.sort_text ?? null);
    }
  }

  private normalizeCursorSourceValue(value: RowRecord[string] | undefined) {
    if (value === undefined) return null;
    if (Array.isArray(value)) return JSON.stringify(value);
    return value;
  }

  private matchesFilter(row: RowEnvelope, filter: NonNullable<ListRowsQuery['filter']>) {
    return Object.entries(filter).every(([field, definition]) =>
      this.matchesFieldFilter(field === 'rowNumber' ? row.rowNumber : field === 'id' ? row.id : (row.values[field] ?? null), definition)
    );
  }

  private matchesFieldFilter(value: RowRecord[string] | string | number, definition: NonNullable<NonNullable<ListRowsQuery['filter']>[string]>) {
    if (definition.eq !== undefined && value !== definition.eq) return false;
    if (definition.neq !== undefined && value === definition.neq) return false;
    if (definition.isNull !== undefined && definition.isNull !== (value === null)) return false;
    if (definition.in !== undefined && !definition.in.some((entry) => entry === value)) return false;
    if (definition.gt !== undefined && !this.compareFilterValues(value, definition.gt, '>')) return false;
    if (definition.gte !== undefined && !this.compareFilterValues(value, definition.gte, '>=')) return false;
    if (definition.lt !== undefined && !this.compareFilterValues(value, definition.lt, '<')) return false;
    if (definition.lte !== undefined && !this.compareFilterValues(value, definition.lte, '<=')) return false;
    if (definition.startsWith !== undefined && (typeof value !== 'string' || !value.startsWith(definition.startsWith))) return false;
    if (definition.contains !== undefined && (typeof value !== 'string' || !value.includes(definition.contains))) return false;
    return true;
  }

  private compareFilterValues(
    value: RowRecord[string] | string | number,
    expected: string | number,
    operator: '>' | '>=' | '<' | '<='
  ) {
    const comparison = compareRangeQueryValues(value, expected);
    if (comparison === null) {
      return false;
    }

    return evaluateComparison(comparison, 0, operator);
  }

  private isRowAfterScanCursor(
    row: RowEnvelope,
    sortField: string,
    direction: 'asc' | 'desc',
    cursor: NonNullable<ReturnType<typeof decodeQueryCursor>>
  ) {
    const valueComparison = this.compareScanCursorValue(
      sortField === 'rowNumber'
        ? row.rowNumber
        : sortField === 'id'
          ? row.id
          : this.normalizeCursorSourceValue(row.values[sortField]),
      cursor
    );

    if (valueComparison !== 0) {
      return direction === 'desc' ? valueComparison < 0 : valueComparison > 0;
    }

    if (sortField === 'rowNumber') {
      const rowNumberComparison = row.rowNumber - cursor.rowNumber;
      if (rowNumberComparison !== 0) {
        return direction === 'desc' ? rowNumberComparison < 0 : rowNumberComparison > 0;
      }
    }

    const rowIdComparison = compareStableStrings(row.id, cursor.rowId);
    return direction === 'desc' ? rowIdComparison < 0 : rowIdComparison > 0;
  }

  private compareScanCursorValue(
    value: RowRecord[string] | string | number | null,
    cursor: NonNullable<ReturnType<typeof decodeQueryCursor>>
  ) {
    if (cursor.sortField === 'rowNumber') {
      return Number(value) - cursor.rowNumber;
    }

    if (cursor.sortField === 'id') {
      return compareStableStrings(String(value ?? ''), cursor.rowId);
    }

    const comparableValue = Array.isArray(value) ? JSON.stringify(value) : value;
    const cursorValue = cursor.value.kind === 'null'
      ? null
      : cursor.value.kind === 'boolean' || cursor.value.kind === 'number' || cursor.value.kind === 'string'
        ? cursor.value.value
        : null;

    return compareQueryValues(comparableValue, cursorValue);
  }
}

function queryDirectionAwareOrderBy(
  alias: string,
  kindColumn: string,
  textColumn: string,
  numberColumn: string,
  booleanColumn: string,
  direction: 'asc' | 'desc'
) {
  const sqlDirection = direction.toUpperCase();
  return [
    `CASE ${alias}.${kindColumn} WHEN 'null' THEN 0 WHEN 'boolean' THEN 1 WHEN 'number' THEN 2 WHEN 'string' THEN 3 ELSE 4 END ${sqlDirection}`,
    `${alias}.${numberColumn} ${sqlDirection}`,
    `${alias}.${textColumn} COLLATE BINARY ${sqlDirection}`,
    `${alias}.${booleanColumn} ${sqlDirection}`,
    `cr.row_id ${sqlDirection}`
  ].join(', ');
}

function evaluateComparison<T extends string | number>(
  left: T,
  right: T,
  operator: '>' | '>=' | '<' | '<='
) {
  switch (operator) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
  }
}
