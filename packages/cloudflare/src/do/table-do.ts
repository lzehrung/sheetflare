import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
  type RefreshTableCacheResult,
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
  type ResolvedTableConfigSnapshot,
  type TableExternalChange,
  type TableValidationSummary,
  type TableValidationIssue
} from '@sheetflare/contracts';
import {
  applyFieldRuleNormalization,
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
  pickKnownColumns,
  validateFieldRules
} from '@sheetflare/domain';
import {
  GoogleSheetsService,
  type GoogleSheetHeaderLayout,
  type GoogleSheetTableConfig
} from '@sheetflare/google-sheets';
import type { CloudflareEnv } from '../types';
import { getMaxFullScanRows } from '../config';
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

type CacheStaleReason = 'fresh' | 'never-synced' | 'ttl-expired' | 'config-changed' | 'external-change' | 'error';

type CacheState = TableCacheStatus & {
  staleReason: CacheStaleReason;
};

const emptyExternalChangeState: TableExternalChange = {
  pending: false,
  lastChangedAt: null,
  debounceUntil: null,
  lastAutoReindexAt: null
};

type ResolvedTableConfig = GoogleSheetTableConfig & {
  googleCredentialRef: string;
};

function canServeExternalChangeCache(externalChange: TableExternalChange) {
  if (!externalChange.pending) {
    return false;
  }

  if (!externalChange.debounceUntil) {
    return false;
  }

  const debounceUntilMs = Date.parse(externalChange.debounceUntil);
  return !Number.isNaN(debounceUntilMs) && debounceUntilMs > Date.now();
}

function assertWritableFields(
  values: Partial<RowRecord>,
  readOnlyFields: readonly string[]
) {
  const readOnlyFieldSet = new Set(readOnlyFields);
  const attemptedReadOnlyFields = Object.keys(values).filter((field) => readOnlyFieldSet.has(field));
  if (attemptedReadOnlyFields.length > 0) {
    throw new BadRequestError('Write payload contains read-only columns.', {
      attemptedReadOnlyFields,
      readOnlyFields
    });
  }
}

function assertManagedIdFieldIsNotWritten(
  values: Partial<RowRecord>,
  idColumn: string
) {
  if (!Object.prototype.hasOwnProperty.call(values, idColumn)) {
    return;
  }

  throw new BadRequestError(`Write payload cannot update managed row id column ${idColumn}.`, {
    idColumn
  });
}

function normalizePartialRowValues(input: Partial<RowRecord>): RowRecord {
  const normalized: RowRecord = {};

  for (const [rawKey, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }

    const key = rawKey.trim();
    if (!key) {
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

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

function buildValidationErrorDetails(violations: ReturnType<typeof validateFieldRules>) {
  return {
    fieldErrors: violations.map((violation) => ({
      field: violation.field,
      code: violation.code,
      message: violation.message
    }))
  };
}

function buildCacheConfigSignature(config: {
  spreadsheetId: string;
  googleCredentialRef: string;
  sheetTabName: string;
  sheetGid?: number | undefined;
  idColumn: string;
  indexedFields: readonly string[];
  fieldRules: ResolvedTableConfig['fieldRules'];
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
    fieldRules: config.fieldRules,
    headerRow: config.headerRow,
    dataStartRow: config.dataStartRow
  });
}

const emptyValidationSummary: TableValidationSummary = {
  status: 'ok',
  issueCount: 0,
  issues: []
};

function getProjectStub(env: CloudflareEnv, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

export class TableDO {
  private readonly sheetsByCredentialRef = new Map<string, GoogleSheetsService>();
  private activeSync: Promise<TableCacheStatus> | null = null;

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
    const requestContext = body.requestContext ?? null;
    switch (body.type) {
      case 'table.rows.list':
        return {
          type: 'table.rows.list.result',
          result: await this.listRows(body.projectSlug, body.tableSlug, body.query, body.resolvedConfig, requestContext)
        };
      case 'table.row.get':
        return {
          type: 'table.row.get.result',
          result: await this.getRow(body.projectSlug, body.tableSlug, body.rowId, body.resolvedConfig, requestContext)
        };
      case 'table.row.create':
        return {
          type: 'table.row.create.result',
          result: await this.createRow(body.projectSlug, body.tableSlug, body.input.values, requestContext)
        };
      case 'table.row.update':
        return {
          type: 'table.row.update.result',
          result: await this.updateRow(body.projectSlug, body.tableSlug, body.rowId, body.input.values, requestContext)
        };
      case 'table.row.delete':
        return {
          type: 'table.row.delete.result',
          result: await this.deleteRow(body.projectSlug, body.tableSlug, body.rowId, requestContext)
        };
      case 'table.schema.get':
        return {
          type: 'table.schema.get.result',
          result: await this.getSchema(body.projectSlug, body.tableSlug, body.resolvedConfig, requestContext)
        };
      case 'table.cache.get':
        return {
          type: 'table.cache.get.result',
          result: await this.getCacheStatus(body.projectSlug, body.tableSlug, body.resolvedConfig)
        };
      case 'table.cache.refresh':
        return {
          type: 'table.cache.refresh.result',
          result: await this.refreshCacheIfStale(body.projectSlug, body.tableSlug, body.resolvedConfig, requestContext)
        };
      case 'table.external-change.record':
        return {
          type: 'table.external-change.record.result',
          result: await this.recordExternalChange(body.projectSlug, body.tableSlug, body.changedAt, body.debounceUntil)
        };
      case 'table.reindex':
        return {
          type: 'table.reindex.result',
          result: await this.syncCache(
            body.projectSlug,
            body.tableSlug,
            body.resolvedConfig
              ? { force: true, resolvedConfig: body.resolvedConfig, requestContext }
              : { force: true, requestContext }
          )
        };
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
    resolvedConfig?: ResolvedTableConfigSnapshot,
    requestContext?: TableRequestContext | null
  ) {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureQueryCacheReady(config, requestContext);
    const headers = await this.getHeaders(config);
    this.assertRequestedFields(rawQuery.fields ?? null, headers);
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
    resolvedConfig?: ResolvedTableConfigSnapshot,
    requestContext?: TableRequestContext | null
  ) {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    const cacheState = await this.ensurePointReadReady(config, requestContext);
    let resolved = this.canServePointReadFromCache(cacheState.staleReason) ? this.getCachedRow(rowId) : null;
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

  private async createRow(projectSlug: string, tableSlug: string, input: RowRecord, requestContext?: TableRequestContext | null) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.createEnabled) {
      throw new ForbiddenError(`Creates are disabled for ${projectSlug}/${tableSlug}.`);
    }

    const cacheState = await this.ensureMutationValidationReady(config, requestContext);
    const normalizedInput = normalizeRowValues(input);
    assertWritableFields(normalizedInput, config.readOnlyFields);
    const sheets = this.getSheetsClient(config);
    const layout = await sheets.getHeaderLayout(config);
    const headers = layout.headers;
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
    if (parsedManagedRowId.ok || cacheState.staleReason !== 'fresh') {
      const existingRow = await this.resolveRowById(config, rowId, { layout });
      if (existingRow) {
        throw new BadRequestError(`Row ${rowId} already exists.`, {
          rowId,
          idColumn: config.idColumn
        });
      }
    }

    const normalizedValues = normalizeRowValues({
      ...normalizedInput,
      [config.idColumn]: rowId
    });
    const { values, ignoredKeys } = pickKnownColumns(normalizedValues, headers);
    assertKnownWriteColumns(ignoredKeys, headers);
    const normalizedCandidate = applyFieldRuleNormalization(values, config.fieldRules);
    normalizedCandidate[config.idColumn] = rowId;
    this.assertFieldRules(normalizedCandidate, config);
    this.assertUniqueFieldRules(normalizedCandidate, config);
    let rowNumber: number | null = null;
    let liveRow: RowEnvelope;
    try {
      rowNumber = await sheets.appendRowSkeleton(config, rowId, layout);
      const writableValues = Object.fromEntries(
        Object.entries(normalizedCandidate).filter(([fieldName]) => fieldName !== config.idColumn && !config.readOnlyFields.includes(fieldName))
      ) as Partial<RowRecord>;
      await sheets.writeRowPatch(config, rowNumber, writableValues, layout);
      liveRow = await sheets.readSingleRow(config, rowNumber, layout);
    } catch (error) {
      if (rowNumber !== null) {
        await this.rollbackAppendedCreateRow(config, rowId, rowNumber, layout, error);
      }

      throw error;
    }

    this.upsertRowIndex(rowId, rowNumber);
    this.upsertCachedRow(liveRow);
    this.upsertCachedCells(config, liveRow);
    this.invalidateSchemaMeta();
    this.markCacheFreshAfterMutation(config, headers);

    return {
      data: liveRow,
      ignoredKeys: []
    };
  }

  private async updateRow(projectSlug: string, tableSlug: string, rowId: string, patch: Partial<RowRecord>, requestContext?: TableRequestContext | null) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.updateEnabled) {
      throw new ForbiddenError(`Updates are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureMutationValidationReady(config, requestContext);
    const sheets = this.getSheetsClient(config);
    const layout = await sheets.getHeaderLayout(config);
    const headers = layout.headers;
    const normalizedPatch = normalizePartialRowValues(patch);
    assertManagedIdFieldIsNotWritten(normalizedPatch, config.idColumn);
    assertWritableFields(normalizedPatch, config.readOnlyFields);
    const existingRow = await this.resolveRowById(config, rowId, { layout });
    if (!existingRow) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    const { values, ignoredKeys } = pickKnownColumns(normalizedPatch, headers);
    assertKnownWriteColumns(ignoredKeys, headers);
    const normalizedCandidate = applyFieldRuleNormalization(normalizeRowValues({
      ...existingRow.values,
      ...values,
      [config.idColumn]: rowId
    }), config.fieldRules);
    normalizedCandidate[config.idColumn] = rowId;
    this.assertFieldRules(normalizedCandidate, config);
    this.assertUniqueFieldRules(normalizedCandidate, config, rowId);
    const writableValues = Object.fromEntries(
      Object.entries(values)
        .filter(([fieldName]) => fieldName !== config.idColumn && !config.readOnlyFields.includes(fieldName))
        .map(([fieldName]) => [fieldName, normalizedCandidate[fieldName]])
    ) as Partial<RowRecord>;
    await sheets.writeRowPatch(config, existingRow.rowNumber, writableValues, layout);
    const liveRow = await sheets.readSingleRow(config, existingRow.rowNumber, layout);
    this.upsertRowIndex(rowId, existingRow.rowNumber);
    this.upsertCachedRow(liveRow);
    this.upsertCachedCells(config, liveRow);
    this.invalidateSchemaMeta();
    this.markCacheFreshAfterMutation(config, headers);

    return {
      data: liveRow,
      ignoredKeys: []
    };
  }

  private async deleteRow(projectSlug: string, tableSlug: string, rowId: string, requestContext?: TableRequestContext | null) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.deleteEnabled) {
      throw new ForbiddenError(`Deletes are disabled for ${projectSlug}/${tableSlug}.`);
    }

    const cacheState = await this.ensurePointOperationReady(config, requestContext);
    const cachedHeaders = this.getMeta('headers');
    const sheets = this.getSheetsClient(config);
    const layout = await sheets.getHeaderLayout(config);
    const headers = layout.headers;
    const existingRow = await this.resolveRowById(config, rowId, { layout });
    if (!existingRow) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    await sheets.deleteRow(config, existingRow.rowNumber);
    this.deleteRowIndex(rowId);
    this.deleteCachedRow(rowId);
    if (cacheState.staleReason === 'fresh' && cachedHeaders === JSON.stringify(headers)) {
      this.shiftCachedRowNumbersAfterDelete(existingRow.rowNumber);
      this.invalidateSchemaMeta();
      this.markCacheFreshAfterMutation(config, headers);
    } else {
      await this.syncCache(projectSlug, tableSlug, { force: true, resolvedConfig: config, requestContext: requestContext ?? null });
    }

    return {
      ok: true as const,
      deletedId: rowId
    };
  }

  private async getSchema(
    projectSlug: string,
    tableSlug: string,
    resolvedConfig?: ResolvedTableConfigSnapshot,
    requestContext?: TableRequestContext | null
  ): Promise<GetSchemaResult> {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    await this.ensureQueryCacheReady(config, requestContext);
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

  private async refreshCacheIfStale(
    projectSlug: string,
    tableSlug: string,
    resolvedConfig?: ResolvedTableConfigSnapshot,
    requestContext?: TableRequestContext | null
  ): Promise<RefreshTableCacheResult> {
    const config = await this.getTableConfig(projectSlug, tableSlug, resolvedConfig);
    const cacheState = this.getCacheState(config);

    if (cacheState.staleReason !== 'fresh') {
      await this.syncCache(projectSlug, tableSlug, {
        force: cacheState.staleReason === 'never-synced' || cacheState.staleReason === 'error',
        resolvedConfig: config,
        requestContext: requestContext ?? null
      });
    }

    const refreshedCache = this.getCacheState(config);
    return {
      ok: true,
      rowCount: refreshedCache.rowCount,
      cache: refreshedCache
    };
  }

  private async recordExternalChange(projectSlug: string, tableSlug: string, changedAt: string, debounceUntil: string | null) {
    await this.getTableConfig(projectSlug, tableSlug);
    this.setExternalChangeState({
      ...this.getExternalChangeState(),
      pending: true,
      lastChangedAt: changedAt,
      debounceUntil
    });

    return { ok: true as const };
  }

  private async ensureQueryCacheReady(config: GoogleSheetTableConfig, requestContext?: TableRequestContext | null) {
    const cacheState = this.getCacheState(config);
    if (
      cacheState.staleReason === 'fresh' ||
      (cacheState.staleReason === 'external-change' && canServeExternalChangeCache(cacheState.externalChange))
    ) {
      return cacheState;
    }

    await this.syncCache(config.projectSlug, config.tableSlug, {
      force: cacheState.staleReason === 'never-synced' || cacheState.staleReason === 'error',
      requestContext: requestContext ?? null
    });
    return this.getCacheState(config);
  }

  private async ensurePointReadReady(config: GoogleSheetTableConfig, requestContext?: TableRequestContext | null) {
    const cacheState = this.getCacheState(config);
    if (
      cacheState.staleReason === 'fresh' ||
      cacheState.staleReason === 'ttl-expired' ||
      (cacheState.staleReason === 'external-change' && canServeExternalChangeCache(cacheState.externalChange))
    ) {
      return cacheState;
    }

    await this.syncCache(config.projectSlug, config.tableSlug, { force: true, requestContext: requestContext ?? null });
    return this.getCacheState(config);
  }

  private async ensurePointOperationReady(config: GoogleSheetTableConfig, requestContext?: TableRequestContext | null) {
    const cacheState = this.getCacheState(config);
    if (cacheState.staleReason === 'fresh' || cacheState.staleReason === 'ttl-expired') {
      return cacheState;
    }

    await this.syncCache(config.projectSlug, config.tableSlug, { force: true, requestContext: requestContext ?? null });
    return this.getCacheState(config);
  }

  private async ensureMutationValidationReady(config: ResolvedTableConfig, requestContext?: TableRequestContext | null) {
    if (this.getCacheState(config).staleReason === 'external-change') {
      await this.syncCache(config.projectSlug, config.tableSlug, { force: true, requestContext: requestContext ?? null });
      return this.getCacheState(config);
    }

    if (this.hasUniqueFieldRules(config)) {
      return this.ensureQueryCacheReady(config, requestContext);
    }

    return this.ensurePointOperationReady(config, requestContext);
  }

  private async syncCache(
    projectSlug: string,
    tableSlug: string,
    options: { force: boolean; resolvedConfig?: ResolvedTableConfigSnapshot; requestContext?: TableRequestContext | null | undefined }
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

    const syncPromise = this.performSync(config, options.requestContext ?? null);
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

  private async performSync(config: ResolvedTableConfig, requestContext: TableRequestContext | null): Promise<TableCacheStatus> {
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
      const validation = this.buildValidationSummary(rows, config);
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
      this.setMeta('validation.summary', JSON.stringify(validation));
      this.completeExternalChangeSync(completedAt, requestContext?.syncSource === 'external-change');
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
        validationStatus: validation.status,
        validationIssueCount: validation.issueCount,
        durationMs: Date.now() - syncStartedAtMs,
        requestId: requestContext?.requestId ?? null,
        route: requestContext?.route ?? null,
        principal: requestContext?.principal ?? null
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
        errorDetails: error instanceof AppError ? error.details ?? null : null,
        errorStack: error instanceof Error ? error.stack ?? null : null,
        requestId: requestContext?.requestId ?? null,
        route: requestContext?.route ?? null,
        principal: requestContext?.principal ?? null
      }));
      throw error;
    }
  }

  private async resolveRowById(
    config: ResolvedTableConfig,
    rowId: string,
    options?: { verifyUnique?: boolean; layout?: GoogleSheetHeaderLayout }
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

  private async rollbackAppendedCreateRow(
    config: ResolvedTableConfig,
    rowId: string,
    appendedRowNumber: number,
    layout: GoogleSheetHeaderLayout,
    createError: unknown
  ) {
    try {
      const rollbackTarget = await this.getSheetsClient(config).findRowById(
        config,
        rowId,
        appendedRowNumber,
        { layout, verifyUnique: true }
      );

      if (!rollbackTarget) {
        throw new Error(`Appended row ${rowId} could not be found for rollback.`);
      }

      if (rollbackTarget.duplicateCount !== 1) {
        throw new Error(`Appended row ${rowId} is no longer uniquely identifiable for rollback.`);
      }

      await this.getSheetsClient(config).deleteRow(config, rollbackTarget.row.rowNumber);
    } catch (rollbackError) {
      throw new ServiceUnavailableError('Create failed after Google Sheets row append and automatic rollback could not safely remove the partial row.', {
        rowId,
        appendedRowNumber,
        createError: createError instanceof Error ? createError.message : String(createError),
        rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      });
    }
  }

  private shiftCachedRowNumbersAfterDelete(deletedRowNumber: number) {
    this.ctx.storage.sql.exec(
      `
      UPDATE cached_rows
      SET row_number = row_number - 1
      WHERE row_number > ?
      `,
      deletedRowNumber
    );
    this.ctx.storage.sql.exec(
      `
      UPDATE row_index
      SET row_number = row_number - 1,
          updated_at = ?
      WHERE row_number > ?
      `,
      new Date().toISOString(),
      deletedRowNumber
    );
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

  private selectOptionalRow<Row>(query: string, ...params: unknown[]): Row | null {
    const rows = this.ctx.storage.sql.exec(query, ...params).toArray() as Row[];
    return rows[0] ?? null;
  }

  private getCachedRow(rowId: string): RowEnvelope | null {
    const row = this.selectOptionalRow<CachedRowRow>(
      `SELECT row_id, row_number, values_json FROM cached_rows WHERE row_id = ?`,
      rowId
    );

    if (!row) return null;
    return {
      id: row.row_id,
      rowNumber: row.row_number,
      values: JSON.parse(row.values_json) as RowRecord
    };
  }

  private lookupRowNumber(rowId: string): number | null {
    const row = this.selectOptionalRow<{ row_number: number }>(
      `SELECT row_number FROM row_index WHERE row_id = ?`,
      rowId
    );

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
    const externalChange = this.getExternalChangeState();
    const lastSyncMs = meta.lastSyncCompletedAt ? Date.parse(meta.lastSyncCompletedAt) : Number.NaN;
    const configSignature = 'googleCredentialRef' in config && config.googleCredentialRef
      ? buildCacheConfigSignature({
          spreadsheetId: config.spreadsheetId,
          googleCredentialRef: config.googleCredentialRef,
          sheetTabName: config.sheetTabName,
          sheetGid: config.sheetGid,
          idColumn: config.idColumn,
          indexedFields: config.indexedFields,
          fieldRules: config.fieldRules,
          headerRow: config.headerRow,
          dataStartRow: config.dataStartRow
        })
      : null;
    const signatureMatches = !configSignature || this.getMeta('config.signature') === configSignature;
    const staleReason = this.getStaleReason(config.cacheTtlSeconds, meta, lastSyncMs, signatureMatches, externalChange.pending);

    return {
      status: meta.status,
      cacheTtlSeconds: config.cacheTtlSeconds,
      stale: staleReason !== 'fresh',
      staleReason,
      rowCount: meta.rowCount,
      lastSyncStartedAt: meta.lastSyncStartedAt,
      lastSyncCompletedAt: meta.lastSyncCompletedAt,
      lastSyncError: meta.lastSyncError,
      validation: this.getValidationSummary(),
      externalChange
    };
  }

  private getStaleReason(
    cacheTtlSeconds: number,
    meta: SyncMeta,
    lastSyncMs: number,
    signatureMatches: boolean,
    hasPendingExternalChange: boolean
  ): CacheStaleReason {
    if (meta.status === 'error') {
      return 'error';
    }

    if (!meta.lastSyncCompletedAt || Number.isNaN(lastSyncMs)) {
      return 'never-synced';
    }

    if (!signatureMatches) {
      return 'config-changed';
    }

    if (hasPendingExternalChange) {
      return 'external-change';
    }

    if (Date.now() - lastSyncMs > cacheTtlSeconds * 1000) {
      return 'ttl-expired';
    }

    return 'fresh';
  }

  private getValidationSummary(): TableValidationSummary {
    const raw = this.getMeta('validation.summary');
    if (!raw) {
      return emptyValidationSummary;
    }

    try {
      return JSON.parse(raw) as TableValidationSummary;
    } catch {
      return emptyValidationSummary;
    }
  }

  private getExternalChangeState(): TableExternalChange {
    const raw = this.getMeta('externalChange.state');
    if (!raw) {
      return emptyExternalChangeState;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<TableExternalChange>;
      return {
        pending: parsed.pending === true,
        lastChangedAt: parsed.lastChangedAt ?? null,
        debounceUntil: parsed.debounceUntil ?? null,
        lastAutoReindexAt: parsed.lastAutoReindexAt ?? null
      };
    } catch {
      return emptyExternalChangeState;
    }
  }

  private setExternalChangeState(state: TableExternalChange) {
    this.setMeta('externalChange.state', JSON.stringify(state));
  }

  private completeExternalChangeSync(completedAt: string, automatic: boolean) {
    const state = this.getExternalChangeState();
    this.setExternalChangeState({
      pending: false,
      lastChangedAt: state.lastChangedAt,
      debounceUntil: null,
      lastAutoReindexAt: automatic ? completedAt : state.lastAutoReindexAt
    });
  }

  private getMeta(key: string): string | null {
    const row = this.selectOptionalRow<TableMetaRow>(`SELECT key, value FROM meta WHERE key = ?`, key);

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
      lastSyncError: cacheState.lastSyncError,
      validation: cacheState.validation,
      externalChange: cacheState.externalChange
    };
  }

  private markCacheFreshAfterMutation(config: ResolvedTableConfig, headers: string[]) {
    const syncMeta = this.getSyncMeta();
    const completedAt = new Date().toISOString();
    this.setMeta('headers', JSON.stringify(headers));
    this.setMeta('config.signature', buildCacheConfigSignature(config));
    if (Object.keys(config.fieldRules).length === 0) {
      this.setMeta('validation.summary', JSON.stringify(emptyValidationSummary));
    } else {
      this.setMeta('validation.summary', JSON.stringify(this.buildValidationSummary(this.listCachedRows(), config)));
    }
    this.setSyncMeta({
      status: 'ready',
      rowCount: this.countCachedRows(),
      lastSyncStartedAt: syncMeta.lastSyncStartedAt,
      lastSyncCompletedAt: completedAt,
      lastSyncError: null
    });
  }

  private buildValidationSummary(rows: readonly RowEnvelope[], config: ResolvedTableConfig): TableValidationSummary {
    if (Object.keys(config.fieldRules).length === 0) {
      return emptyValidationSummary;
    }

    const maxIssues = 10;
    const issues: TableValidationIssue[] = [];
    let issueCount = 0;

    const uniqueValueOwners = new Map<string, { rowId: string; rowNumber: number }>();

    for (const row of rows) {
      const normalizedValues = applyFieldRuleNormalization(row.values, config.fieldRules);
      const violations = validateFieldRules(normalizedValues, config.fieldRules);
      for (const violation of violations) {
        issueCount += 1;
        if (issues.length < maxIssues) {
          issues.push({
            rowId: row.id,
            rowNumber: row.rowNumber,
            field: violation.field,
            code: violation.code,
            message: violation.message
          });
        }
      }

      for (const [fieldName, rule] of Object.entries(config.fieldRules)) {
        if (!rule.unique) {
          continue;
        }

        const value = normalizedValues[fieldName];
        if (value === undefined || value === null || (typeof value === 'string' && value.length === 0) || Array.isArray(value)) {
          continue;
        }

        const uniqueKey = `${fieldName}:${typeof value}:${String(value)}`;
        const existingOwner = uniqueValueOwners.get(uniqueKey);
        if (!existingOwner) {
          uniqueValueOwners.set(uniqueKey, {
            rowId: row.id,
            rowNumber: row.rowNumber
          });
          continue;
        }

        issueCount += 1;
        if (issues.length < maxIssues) {
          issues.push({
            rowId: row.id,
            rowNumber: row.rowNumber,
            field: fieldName,
            code: 'UNIQUE',
            message: `${fieldName} duplicates row ${existingOwner.rowId}.`
          });
        }
      }
    }

    return issueCount === 0
      ? emptyValidationSummary
      : {
          status: 'warning',
          issueCount,
          issues
        };
  }

  private invalidateSchemaMeta() {
    this.deleteMeta('schema');
  }

  private canServePointReadFromCache(staleReason: CacheStaleReason) {
    return staleReason === 'fresh' || staleReason === 'external-change';
  }

  private countCachedRows(kind: 'live' | 'staging' = 'live') {
    const tables = getCacheTableNames(kind);
    const row = this.selectOptionalRow<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tables.cachedRows}`);

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
    const promote = () => {
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
    };

    try {
      const transactionSync = (
        this.ctx.storage as DurableObjectStorage & {
          transactionSync?: ((callback: () => void) => void) | undefined;
        }
      ).transactionSync;

      if (transactionSync) {
        transactionSync.call(this.ctx.storage, promote);
      } else {
        promote();
      }
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
    const maxFullScanRows = getMaxFullScanRows(this.env);

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
              value: normalizeScalarCursorValue(this.getSortFieldValue(lastRow, query.sort.field))
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

  private hasUniqueFieldRules(config: ResolvedTableConfig) {
    return Object.values(config.fieldRules).some((rule) => rule.unique);
  }

  private assertFieldRules(values: RowRecord, config: ResolvedTableConfig) {
    const violations = validateFieldRules(values, config.fieldRules);
    if (violations.length > 0) {
      throw new BadRequestError('Table row failed validation.', buildValidationErrorDetails(violations));
    }
  }

  private assertUniqueFieldRules(values: RowRecord, config: ResolvedTableConfig, currentRowId?: string) {
    for (const [fieldName, rule] of Object.entries(config.fieldRules)) {
      if (!rule.unique) {
        continue;
      }

      const value = values[fieldName];
      if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
        continue;
      }

      if (Array.isArray(value)) {
        throw new BadRequestError(`Unique field ${fieldName} must be a scalar value.`, {
          field: fieldName
        });
      }

      const conflictingRowIds = this.findCachedRowIdsByIndexedValue(fieldName, value)
        .filter((rowId) => rowId !== currentRowId);
      if (conflictingRowIds.length > 0) {
        throw new ConflictError(`${fieldName} must be unique.`, {
          field: fieldName,
          value,
          conflictingRowIds
        });
      }
    }
  }

  private findCachedRowIdsByIndexedValue(fieldName: string, value: string | number | boolean) {
    const normalized = this.normalizeIndexedCellValue(value);
    const rows = this.ctx.storage.sql.exec(
      `
      SELECT row_id
      FROM cached_cells
      WHERE field_name = ?
        AND value_kind = ?
        AND ((value_text IS NULL AND ? IS NULL) OR value_text = ?)
        AND ((value_number IS NULL AND ? IS NULL) OR value_number = ?)
        AND ((value_boolean IS NULL AND ? IS NULL) OR value_boolean = ?)
      `,
      fieldName,
      normalized.valueKind,
      normalized.valueText,
      normalized.valueText,
      normalized.valueNumber,
      normalized.valueNumber,
      normalized.valueBoolean,
      normalized.valueBoolean
    ).toArray() as Array<{ row_id: string }>;

    return rows.map((row) => row.row_id);
  }

  private assertRequestedFields(fields: string[] | null, headers: readonly string[]) {
    if (!fields || fields.length === 0) {
      return;
    }

    const allowedFields = new Set(headers);
    const invalidFields = fields.filter((field) => !allowedFields.has(field));
    if (invalidFields.length > 0) {
      throw new BadRequestError('fields contains unknown columns.', {
        invalidFields,
        headers
      });
    }
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
      this.matchesFieldFilter(this.getFilterFieldValue(row, field), definition)
    );
  }

  private getFilterFieldValue(row: RowEnvelope, field: string) {
    if (field === 'rowNumber') {
      return row.rowNumber;
    }

    if (field === 'id') {
      return row.id;
    }

    return row.values[field] ?? null;
  }

  private getSortFieldValue(row: RowEnvelope, sortField: string) {
    if (sortField === 'rowNumber') {
      return row.rowNumber;
    }

    if (sortField === 'id') {
      return row.id;
    }

    return this.normalizeCursorSourceValue(row.values[sortField]);
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
    const valueComparison = this.compareScanCursorValue(this.getSortFieldValue(row, sortField), cursor);

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
    const cursorValue = this.getDecodedCursorValue(cursor);

    return compareQueryValues(comparableValue, cursorValue);
  }

  private getDecodedCursorValue(cursor: NonNullable<ReturnType<typeof decodeQueryCursor>>) {
    if (cursor.value.kind === 'null') {
      return null;
    }

    if (
      cursor.value.kind === 'boolean' ||
      cursor.value.kind === 'number' ||
      cursor.value.kind === 'string'
    ) {
      return cursor.value.value;
    }

    return null;
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
