import {
  tableDoRequestSchema,
  type RowRecord,
  type TableCacheStatus,
  type TableDoRequest,
  type TableDoResponse
} from '@sheetflare/contracts';
import type { FakeDurableObjectHook } from './harness';

export type FakeTableRow = {
  id: string;
  values: RowRecord;
};

export type FakeTableOptions = {
  /** What the spreadsheet holds when the test starts. */
  rows?: readonly FakeTableRow[];
  /** Start with a completed sync, so the first read is served from a fresh cache instead of syncing. */
  warm?: boolean;
};

type ExternalChange = {
  pending: boolean;
  lastChangedAt: string | null;
  debounceUntil: string | null;
};

function cloneRows(rows: readonly FakeTableRow[]): FakeTableRow[] {
  return rows.map((row) => ({ id: row.id, values: { ...row.values } }));
}

function notFound(message: string) {
  return Response.json({ error: { code: 'NOT_FOUND', message, details: null } }, { status: 404 });
}

/**
 * A stateful stand-in for one `TableDO`, speaking its RPC protocol for the cache freshness contract the gateway relies
 * on. It keeps the spreadsheet and the SQLite cache apart like the real table does, so a test can edit the sheet
 * behind the cache's back. Mirrored from packages/cloudflare/src/do/table-do.ts:
 *
 * - `dataGeneration` only ever grows. It advances on sync promotion, committed create/update/delete, cache clear,
 *   a change of cached-read configuration, and recording an external change.
 * - A committed write is applied to the cache and counts as a completed sync.
 * - Reads sync first when the cache is missing or past its TTL (point reads tolerate an expired TTL). A pending external
 *   change is served until its debounce window ends.
 *
 * The real TableDO's behavior is covered in packages/cloudflare; this double only has to agree with it.
 */
export class FakeTable {
  readonly #sheet: FakeTableRow[];
  #cached: FakeTableRow[] = [];
  #generation = 0;
  #lastSyncStartedAt: number | null = null;
  #lastSyncCompletedAt: number | null = null;
  #cacheTtlSeconds: number | null = null;
  #externalChange: ExternalChange = { pending: false, lastChangedAt: null, debounceUntil: null };
  readonly #requestTypes: string[] = [];

  constructor(options: FakeTableOptions = {}) {
    this.#sheet = cloneRows(options.rows ?? []);
    if (options.warm === true) {
      this.#sync();
    }
  }

  get dataGeneration() {
    return this.#generation;
  }

  /** Every RPC type this table received, in order. */
  get requestTypes(): readonly string[] {
    return this.#requestTypes;
  }

  /** What a read of the cache returns right now, without syncing. */
  cachedValues(rowId: string) {
    return this.#cached.find((row) => row.id === rowId)?.values ?? null;
  }

  /** Changes a row in the spreadsheet only, like a person editing it in Google Sheets. */
  editSheet(rowId: string, values: RowRecord) {
    const row = this.#sheet.find((candidate) => candidate.id === rowId);
    if (row === undefined) {
      throw new Error(`The fake sheet has no row ${rowId}.`);
    }
    row.values = { ...row.values, ...values };
  }

  /** What the control plane does for a Drive notification: the cache can no longer be trusted until it is reindexed. */
  recordExternalChange(options: { debounceSeconds: number }) {
    const nowMs = Date.now();
    this.#externalChange = {
      pending: true,
      lastChangedAt: new Date(nowMs).toISOString(),
      debounceUntil: new Date(nowMs + options.debounceSeconds * 1000).toISOString()
    };
    this.#generation += 1;
  }

  readonly hook: FakeDurableObjectHook = async ({ body }) => {
    const request = tableDoRequestSchema.parse(body);
    this.#requestTypes.push(request.type);
    return this.#handle(request);
  };

  #handle(request: TableDoRequest): Response | undefined {
    if ('resolvedConfig' in request && request.resolvedConfig !== undefined) {
      this.#observeCacheTtl(request.resolvedConfig.cacheTtlSeconds);
    }

    switch (request.type) {
      case 'table.generation.get':
        return this.#respond({
          type: 'table.generation.get.result',
          result: {
            dataGeneration: this.#generation,
            lastSyncCompletedAt: this.#iso(this.#lastSyncCompletedAt),
            cacheTtlSeconds: this.#ttlSeconds()
          }
        });
      case 'table.cache.get':
        return this.#respond({ type: 'table.cache.get.result', result: { data: this.#status() } });
      case 'table.rows.list':
        this.#ensureQueryReady();
        return this.#respond({
          type: 'table.rows.list.result',
          result: { data: this.#cached.map((row, index) => ({ id: row.id, rowNumber: index + 2, values: row.values })), nextCursor: null }
        });
      case 'table.row.get': {
        this.#ensurePointReadReady();
        const index = this.#cached.findIndex((row) => row.id === request.rowId);
        const row = this.#cached[index];
        if (row === undefined) {
          return notFound(`Row ${request.rowId} was not found.`);
        }
        return this.#respond({
          type: 'table.row.get.result',
          result: { data: { id: row.id, rowNumber: index + 2, values: row.values } }
        });
      }
      case 'table.schema.get':
        this.#ensureQueryReady();
        return this.#respond({
          type: 'table.schema.get.result',
          result: {
            data: {
              fields: [{ name: '_id', inferredType: 'string', nullable: false }],
              inferredAt: new Date(Date.now()).toISOString()
            }
          }
        });
      case 'table.row.create': {
        this.#ensureMutationReady();
        const row = { id: `row-${this.#sheet.length + 1}`, values: { ...request.input.values } };
        this.#sheet.push(row);
        this.#cached.push({ id: row.id, values: { ...row.values } });
        this.#commitWrite();
        return this.#respond({
          type: 'table.row.create.result',
          result: { data: { id: row.id, rowNumber: this.#cached.length + 1, values: row.values }, ignoredKeys: [] }
        });
      }
      case 'table.row.update': {
        this.#ensureMutationReady();
        const sheetRow = this.#sheet.find((row) => row.id === request.rowId);
        const cachedIndex = this.#cached.findIndex((row) => row.id === request.rowId);
        const cachedRow = this.#cached[cachedIndex];
        if (sheetRow === undefined || cachedRow === undefined) {
          return notFound(`Row ${request.rowId} was not found.`);
        }
        sheetRow.values = { ...sheetRow.values, ...request.input.values };
        cachedRow.values = { ...cachedRow.values, ...request.input.values };
        this.#commitWrite();
        return this.#respond({
          type: 'table.row.update.result',
          result: { data: { id: cachedRow.id, rowNumber: cachedIndex + 2, values: cachedRow.values }, ignoredKeys: [] }
        });
      }
      case 'table.row.delete': {
        this.#ensureMutationReady();
        const sheetIndex = this.#sheet.findIndex((row) => row.id === request.rowId);
        const cachedIndex = this.#cached.findIndex((row) => row.id === request.rowId);
        if (sheetIndex === -1 || cachedIndex === -1) {
          return notFound(`Row ${request.rowId} was not found.`);
        }
        this.#sheet.splice(sheetIndex, 1);
        this.#cached.splice(cachedIndex, 1);
        this.#commitWrite();
        return this.#respond({ type: 'table.row.delete.result', result: { ok: true, deletedId: request.rowId } });
      }
      case 'table.cache.clear':
        this.#cached = [];
        this.#lastSyncCompletedAt = null;
        this.#externalChange = { pending: false, lastChangedAt: null, debounceUntil: null };
        this.#generation += 1;
        return this.#respond({ type: 'table.cache.clear.result', result: { ok: true } });
      case 'table.external-change.record':
        this.#externalChange = { pending: true, lastChangedAt: request.changedAt, debounceUntil: request.debounceUntil };
        this.#generation += 1;
        return this.#respond({ type: 'table.external-change.record.result', result: { ok: true } });
      case 'table.reindex':
        this.#sync();
        return this.#respond({
          type: 'table.reindex.result',
          result: { ok: true, rowCount: this.#cached.length, cache: this.#status() }
        });
      case 'table.cache.refresh':
        if (this.#staleReason() !== 'fresh') {
          this.#sync();
        }
        return this.#respond({
          type: 'table.cache.refresh.result',
          result: { ok: true, rowCount: this.#cached.length, cache: this.#status() }
        });
    }
  }

  #respond(response: TableDoResponse) {
    return Response.json(response);
  }

  #iso(timestampMs: number | null) {
    return timestampMs === null ? null : new Date(timestampMs).toISOString();
  }

  #ttlSeconds() {
    return this.#cacheTtlSeconds ?? 60;
  }

  // Like TableDO.observeConfig: the first configuration is recorded, a later change of what reads return or how long
  // they stay fresh advances the generation.
  #observeCacheTtl(cacheTtlSeconds: number) {
    if (this.#cacheTtlSeconds !== null && this.#cacheTtlSeconds !== cacheTtlSeconds) {
      this.#generation += 1;
    }
    this.#cacheTtlSeconds = cacheTtlSeconds;
  }

  #sync() {
    const nowMs = Date.now();
    this.#lastSyncStartedAt = nowMs;
    this.#cached = cloneRows(this.#sheet);
    this.#lastSyncCompletedAt = nowMs;
    this.#externalChange = { ...this.#externalChange, pending: false, debounceUntil: null };
    this.#generation += 1;
  }

  // A write was confirmed by Google and applied to the cache, which TableDO counts as a completed sync.
  #commitWrite() {
    this.#lastSyncCompletedAt = Date.now();
    this.#generation += 1;
  }

  #staleReason(): TableCacheStatus['staleReason'] {
    if (this.#lastSyncCompletedAt === null) {
      return 'never-synced';
    }
    if (this.#externalChange.pending) {
      return 'external-change';
    }
    if (Date.now() - this.#lastSyncCompletedAt > this.#ttlSeconds() * 1000) {
      return 'ttl-expired';
    }
    return 'fresh';
  }

  #canServeExternalChange() {
    const debounceUntil = this.#externalChange.debounceUntil;
    return this.#externalChange.pending && debounceUntil !== null && Date.parse(debounceUntil) > Date.now();
  }

  #ensureQueryReady() {
    const reason = this.#staleReason();
    if (reason === 'fresh' || (reason === 'external-change' && this.#canServeExternalChange())) {
      return;
    }
    this.#sync();
  }

  #ensurePointReadReady() {
    const reason = this.#staleReason();
    if (reason === 'fresh' || reason === 'ttl-expired' || (reason === 'external-change' && this.#canServeExternalChange())) {
      return;
    }
    this.#sync();
  }

  #ensureMutationReady() {
    const reason = this.#staleReason();
    if (reason === 'external-change' || reason === 'never-synced') {
      this.#sync();
    }
  }

  #status(): TableCacheStatus {
    const staleReason = this.#staleReason();
    return {
      status: this.#lastSyncCompletedAt === null ? 'idle' : 'ready',
      cacheTtlSeconds: this.#ttlSeconds(),
      stale: staleReason !== 'fresh',
      staleReason,
      rowCount: this.#cached.length,
      lastSyncStartedAt: this.#iso(this.#lastSyncStartedAt),
      lastSyncCompletedAt: this.#iso(this.#lastSyncCompletedAt),
      lastSyncError: null,
      validation: { status: 'ok', issueCount: 0, issues: [], validatedAt: null },
      externalChange: { ...this.#externalChange, lastAutoReindexAt: null },
      dataGeneration: this.#generation
    };
  }
}
