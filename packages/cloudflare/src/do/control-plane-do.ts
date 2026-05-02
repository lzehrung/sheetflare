import { AppError, ServiceUnavailableError } from '@sheetflare/contracts';
import type {
  AdminListSpreadsheetWatchRetryAdviceResult,
  AdminListSpreadsheetWatchesResult,
  AdminRegisterSpreadsheetWatchesResult,
  AdminCreateApiKeyResult,
  AdminListApiKeysResult,
  AdminListProjectsResult,
  ApiKeyPrincipal,
  ApiKeyRecord,
  ControlPlaneDoRequest,
  ControlPlaneDoResponse,
  ProjectDoResponse,
  ProjectSummary,
  TableConfig,
  TableDoResponse,
  TableRequestContext
} from '@sheetflare/contracts';
import { controlPlaneDoRequestSchema } from '@sheetflare/contracts';
import { GoogleSheetsService } from '@sheetflare/google-sheets';
import type { CloudflareEnv } from '../types';
import { doRpc, durableObjectErrorResponse, parseDurableObjectRpcRequest } from '../rpc';
import { resolveGoogleCredential } from '../google-credentials';

type RegistryRow = {
  slug: string;
  name: string;
  spreadsheet_id: string;
  google_credential_ref: string;
  table_count: number;
  updated_at: string;
};

type ApiKeyRow = {
  id: string;
  project_slug: string | null;
  name: string;
  hash: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};

type SpreadsheetWatchRow = {
  spreadsheet_id: string;
  google_credential_ref: string;
  channel_id: string;
  resource_id: string;
  resource_uri: string | null;
  webhook_url: string | null;
  expiration_at: string | null;
  expiration_duration_ms: number | null;
  last_message_number: string | null;
  last_watch_error: string | null;
  debounce_seconds: number;
  last_notification_at: string | null;
  pending_changed_at: string | null;
  debounce_until: string | null;
  last_reindex_started_at: string | null;
  last_reindex_completed_at: string | null;
  last_reindex_error: string | null;
  updated_at: string;
};

type SpreadsheetWatchRenewalRow = Pick<
  SpreadsheetWatchRow,
  'spreadsheet_id' | 'expiration_at' | 'expiration_duration_ms' | 'last_watch_error' | 'updated_at'
>;

type SpreadsheetWatchTombstoneRow = {
  spreadsheet_id: string;
  expiration_at: string | null;
  stopped_at: string;
  updated_at: string;
};

function getProjectStub(env: CloudflareEnv, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

function getTableStub(env: CloudflareEnv, projectSlug: string, tableSlug: string) {
  return env.TABLE_DO.get(env.TABLE_DO.idFromName(`table:${projectSlug}:${tableSlug}`));
}

const defaultWatchDurationMs = 7 * 24 * 60 * 60 * 1000;
const minWatchRenewLeadMs = 5 * 60 * 1000;
const maxWatchRenewLeadMs = 24 * 60 * 60 * 1000;
const watchRenewRetryMs = 5 * 60 * 1000;
const watchRenewConfigRetryMs = 60 * 60 * 1000;
const watchRetryAdviceGraceMs = 15 * 60 * 1000;

export class ControlPlaneDO {
  private readonly sheetsByCredentialRef = new Map<string, GoogleSheetsService>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {
    this.initialize();
  }

  private initialize() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_registry (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spreadsheet_id TEXT NOT NULL,
        google_credential_ref TEXT NOT NULL DEFAULT 'default',
        table_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    try {
      this.ctx.storage.sql.exec(`ALTER TABLE project_registry ADD COLUMN google_credential_ref TEXT NOT NULL DEFAULT 'default'`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error;
      }
    }

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        project_slug TEXT,
        name TEXT NOT NULL,
        hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS spreadsheet_watches (
        spreadsheet_id TEXT PRIMARY KEY,
        google_credential_ref TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_uri TEXT,
        webhook_url TEXT,
        expiration_at TEXT,
        expiration_duration_ms INTEGER,
        last_message_number TEXT,
        last_watch_error TEXT,
        debounce_seconds INTEGER NOT NULL,
        last_notification_at TEXT,
        pending_changed_at TEXT,
        debounce_until TEXT,
        last_reindex_started_at TEXT,
        last_reindex_completed_at TEXT,
        last_reindex_error TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS spreadsheet_watch_tombstones (
        spreadsheet_id TEXT PRIMARY KEY,
        expiration_at TEXT,
        stopped_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spreadsheet_watches_channel_id
      ON spreadsheet_watches(channel_id)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_spreadsheet_watches_debounce_until
      ON spreadsheet_watches(debounce_until)
    `);

    this.ensureSpreadsheetWatchColumn('webhook_url', 'TEXT');
    this.ensureSpreadsheetWatchColumn('expiration_duration_ms', 'INTEGER');
    this.ensureSpreadsheetWatchColumn('last_message_number', 'TEXT');
    this.ensureSpreadsheetWatchColumn('last_watch_error', 'TEXT');
  }

  private ensureSpreadsheetWatchColumn(columnName: string, definition: string) {
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE spreadsheet_watches ADD COLUMN ${columnName} ${definition}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error;
      }
    }
  }

  private async hashApiKeySecret(secret: string): Promise<string> {
    const bytes = new TextEncoder().encode(secret);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const body = await parseDurableObjectRpcRequest(request, controlPlaneDoRequestSchema);
      const result = await this.handle(body);
      return Response.json(result);
    } catch (error) {
      return durableObjectErrorResponse(error);
    }
  }

  private async handle(body: ControlPlaneDoRequest): Promise<ControlPlaneDoResponse> {
    switch (body.type) {
      case 'control.projects.list':
        return {
          type: 'control.projects.list.result',
          result: this.listProjects()
        };
      case 'control.project.upsert':
        this.upsertProjectSummary(body.summary);
        return {
          type: 'control.project.upsert.result',
          result: { ok: true }
        };
      case 'control.spreadsheet-watches.list':
        return {
          type: 'control.spreadsheet-watches.list.result',
          result: this.listSpreadsheetWatchesForAdmin()
        };
      case 'control.spreadsheet-watches.retry-advice.list':
        return {
          type: 'control.spreadsheet-watches.retry-advice.list.result',
          result: this.listSpreadsheetWatchRetryAdviceForAdmin()
        };
      case 'control.spreadsheet-watches.register':
        return {
          type: 'control.spreadsheet-watches.register.result',
          result: await this.registerSpreadsheetWatches(body.webhookUrl, body.webhookToken, body.debounceSeconds, body.expirationMs ?? null)
        };
      case 'control.spreadsheet-watches.stop':
        return {
          type: 'control.spreadsheet-watches.stop.result',
          result: await this.stopSpreadsheetWatches(body.input.spreadsheetId ?? null)
        };
      case 'control.spreadsheet-watch.notify':
        return {
          type: 'control.spreadsheet-watch.notify.result',
          result: await this.recordSpreadsheetNotification(body.channelId, body.resourceId, body.resourceState, body.messageNumber, body.changedAt, body.channelExpiration)
        };
      case 'control.api-key.create':
        return {
          type: 'control.api-key.create.result',
          result: await this.createApiKey(body.input)
        };
      case 'control.api-keys.list':
        return {
          type: 'control.api-keys.list.result',
          result: this.listApiKeys(body.projectSlug ?? null)
        };
      case 'control.api-key.get':
        return {
          type: 'control.api-key.get.result',
          result: {
            record: this.getApiKeyPrincipal(body.apiKeyId)
          }
        };
      case 'control.api-key.verify':
        return {
          type: 'control.api-key.verify.result',
          result: {
            record: this.verifyApiKey(body.apiKeyId, body.hash)
          }
        };
      case 'control.api-key.touch':
        this.touchApiKey(body.apiKeyId, body.usedAt);
        return {
          type: 'control.api-key.touch.result',
          result: { ok: true }
        };
      case 'control.api-key.revoke':
        this.revokeApiKey(body.apiKeyId, body.revokedAt);
        return {
          type: 'control.api-key.revoke.result',
          result: { ok: true }
        };
    }
  }

  private listProjects(): AdminListProjectsResult {
    const rows = this.ctx.storage.sql
      .exec(`
        SELECT slug, name, spreadsheet_id, google_credential_ref, table_count, updated_at
        FROM project_registry
        ORDER BY updated_at DESC, slug ASC
      `)
      .toArray() as RegistryRow[];

    return {
      data: rows.map((row) => this.mapSummary(row))
    };
  }

  private upsertProjectSummary(summary: ProjectSummary) {
    this.ctx.storage.sql.exec(
      `
      INSERT INTO project_registry (slug, name, spreadsheet_id, google_credential_ref, table_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        spreadsheet_id = excluded.spreadsheet_id,
        google_credential_ref = excluded.google_credential_ref,
        table_count = excluded.table_count,
        updated_at = excluded.updated_at
      `,
      summary.slug,
      summary.name,
      summary.spreadsheetId,
      summary.googleCredentialRef,
      summary.tableCount,
      summary.updatedAt
    );
  }

  async alarm() {
    const nowMs = Date.now();
    const dueWatches = this.ctx.storage.sql.exec(
      `
      SELECT *
      FROM spreadsheet_watches
      WHERE pending_changed_at IS NOT NULL
        AND debounce_until IS NOT NULL
        AND debounce_until <= ?
      ORDER BY debounce_until ASC, spreadsheet_id ASC
      `,
      new Date(nowMs).toISOString()
    ).toArray() as SpreadsheetWatchRow[];
    const dueRenewals = this.listSpreadsheetWatches().filter((watch) => {
      const renewAtMs = this.getWatchRenewAtMs(watch);
      return renewAtMs !== null && renewAtMs <= nowMs;
    });

    for (const watch of dueRenewals) {
      await this.renewSpreadsheetWatch(watch);
    }

    for (const watch of dueWatches) {
      await this.reindexSpreadsheetWatch(watch);
    }

    await this.scheduleNextAlarm();
  }

  private async createApiKey(input: {
    name: string;
    projectSlug?: string | null | undefined;
    scopes: string[];
  }): Promise<AdminCreateApiKeyResult> {
    const now = new Date().toISOString();
    const apiKeyId = crypto.randomUUID();
    const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const hash = await this.hashApiKeySecret(secret);

    this.ctx.storage.sql.exec(
      `
      INSERT INTO api_keys (id, project_slug, name, hash, scopes, created_at, revoked_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
      `,
      apiKeyId,
      input.projectSlug ?? null,
      input.name,
      hash,
      JSON.stringify(input.scopes),
      now
    );

    const record = this.getApiKeyPrincipal(apiKeyId);
    if (!record) {
      throw new Error(`Failed to create API key ${apiKeyId}.`);
    }

    return {
      apiKey: `sfk_${apiKeyId}.${secret}`,
      record
    };
  }

  private listApiKeys(projectSlug: string | null): AdminListApiKeysResult {
    const rows = (projectSlug
      ? this.ctx.storage.sql.exec(
          `
          SELECT * FROM api_keys
          WHERE project_slug = ?
          ORDER BY created_at DESC, id ASC
          `,
          projectSlug
        )
      : this.ctx.storage.sql.exec(
          `
          SELECT * FROM api_keys
          ORDER BY created_at DESC, id ASC
          `
        )).toArray() as ApiKeyRow[];

    return {
      data: rows.map((row) => this.mapApiKeyPrincipal(row))
    };
  }

  private selectOptionalRow<Row>(query: string, ...params: unknown[]): Row | null {
    const rows = this.ctx.storage.sql.exec(query, ...params).toArray() as Row[];
    return rows[0] ?? null;
  }

  private selectRows<Row>(query: string, ...params: unknown[]): Row[] {
    return this.ctx.storage.sql.exec(query, ...params).toArray() as Row[];
  }

  private verifyApiKey(apiKeyId: string, hash: string): ApiKeyPrincipal | null {
    const row = this.selectOptionalRow<ApiKeyRow>(`SELECT * FROM api_keys WHERE id = ?`, apiKeyId);

    if (!row || row.revoked_at || row.hash !== hash) {
      return null;
    }

    return this.mapApiKeyPrincipal(row);
  }

  private touchApiKey(apiKeyId: string, usedAt: string) {
    const minUpdatedAt = new Date(Date.parse(usedAt) - 5 * 60 * 1000).toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE api_keys
       SET last_used_at = ?
       WHERE id = ?
         AND (last_used_at IS NULL OR last_used_at < ?)`,
      usedAt,
      apiKeyId,
      minUpdatedAt
    );
  }

  private revokeApiKey(apiKeyId: string, revokedAt: string) {
    this.ctx.storage.sql.exec(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ?`,
      revokedAt,
      apiKeyId
    );
  }

  private getApiKeyPrincipal(apiKeyId: string): ApiKeyPrincipal | null {
    const row = this.selectOptionalRow<ApiKeyRow>(`SELECT * FROM api_keys WHERE id = ?`, apiKeyId);

    return row ? this.mapApiKeyPrincipal(row) : null;
  }

  private mapSummary(row: RegistryRow): ProjectSummary {
    return {
      slug: row.slug,
      name: row.name,
      spreadsheetId: row.spreadsheet_id,
      googleCredentialRef: row.google_credential_ref,
      tableCount: row.table_count,
      updatedAt: row.updated_at
    };
  }

  private async registerSpreadsheetWatches(
    webhookUrl: string,
    webhookToken: string,
    debounceSeconds: number,
    expirationMs: number | null
  ): Promise<AdminRegisterSpreadsheetWatchesResult> {
    const now = new Date().toISOString();
    const expirationDurationMs = expirationMs === null
      ? defaultWatchDurationMs
      : Math.max(expirationMs - Date.now(), minWatchRenewLeadMs);
    const registrations = this.getSpreadsheetRegistrations();
    const activeSpreadsheetIds = new Set(registrations.map((registration) => registration.spreadsheetId));
    const existingWatches = new Map(
      this.listSpreadsheetWatches().map((watch) => [watch.spreadsheet_id, watch] as const)
    );
    const results = [];

    await this.removeObsoleteSpreadsheetWatches(activeSpreadsheetIds);

    for (const registration of registrations) {
      const existing = existingWatches.get(registration.spreadsheetId) ?? null;
      const createdWatch = await this.createSpreadsheetWatch(registration.spreadsheetId, registration.googleCredentialRef, {
        webhookUrl,
        token: webhookToken,
        expirationMs
      }, existing);
      const watch = createdWatch.watch;

      this.ctx.storage.sql.exec(
        `
        INSERT INTO spreadsheet_watches (
          spreadsheet_id, google_credential_ref, channel_id, resource_id, resource_uri, expiration_at, debounce_seconds,
          webhook_url, expiration_duration_ms, last_message_number, last_watch_error,
          last_notification_at, pending_changed_at, debounce_until, last_reindex_started_at, last_reindex_completed_at, last_reindex_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(spreadsheet_id) DO UPDATE SET
          google_credential_ref = excluded.google_credential_ref,
          channel_id = excluded.channel_id,
          resource_id = excluded.resource_id,
          resource_uri = excluded.resource_uri,
          webhook_url = excluded.webhook_url,
          expiration_at = excluded.expiration_at,
          expiration_duration_ms = excluded.expiration_duration_ms,
          last_message_number = excluded.last_message_number,
          last_watch_error = excluded.last_watch_error,
          debounce_seconds = excluded.debounce_seconds,
          updated_at = excluded.updated_at
        `,
        registration.spreadsheetId,
        registration.googleCredentialRef,
        watch.channelId,
        watch.resourceId,
        watch.resourceUri,
        watch.expirationAt,
        debounceSeconds,
        webhookUrl,
        expirationDurationMs,
        null,
        null,
        existing?.last_notification_at ?? null,
        existing?.pending_changed_at ?? null,
        existing?.debounce_until ?? null,
        existing?.last_reindex_started_at ?? null,
        existing?.last_reindex_completed_at ?? null,
        existing?.last_reindex_error ?? null,
        now
      );

      if (existing && !createdWatch.stoppedExistingWatch) {
        await this.stopExistingSpreadsheetWatch(existing);
      }

      results.push(this.mapSpreadsheetWatch(this.requireSpreadsheetWatch(registration.spreadsheetId), registration.projectSlugs));
    }

    await this.scheduleNextAlarm();

    return {
      data: results
    };
  }

  private async stopSpreadsheetWatches(spreadsheetId: string | null): Promise<AdminRegisterSpreadsheetWatchesResult> {
    const watches = spreadsheetId
      ? this.listSpreadsheetWatches().filter((watch) => watch.spreadsheet_id === spreadsheetId)
      : this.listSpreadsheetWatches();
    const projectSlugsBySpreadsheetId = this.getProjectSlugsBySpreadsheetId();
    const stopped: AdminRegisterSpreadsheetWatchesResult['data'] = [];

    for (const watch of watches) {
      await this.stopExistingSpreadsheetWatch(watch);
      this.recordSpreadsheetWatchTombstone(watch);
      stopped.push(
        this.mapSpreadsheetWatch(watch, projectSlugsBySpreadsheetId.get(watch.spreadsheet_id) ?? [])
      );
      this.ctx.storage.sql.exec(
        `
        DELETE FROM spreadsheet_watches
        WHERE spreadsheet_id = ?
        `,
        watch.spreadsheet_id
      );
    }

    await this.scheduleNextAlarm();
    return {
      data: stopped
    };
  }

  private async recordSpreadsheetNotification(
    channelId: string,
    resourceId: string,
    resourceState: string,
    messageNumber: string | null,
    changedAt: string,
    channelExpiration: string | null
  ) {
    const watch = this.selectOptionalRow<SpreadsheetWatchRow>(
      `SELECT * FROM spreadsheet_watches WHERE channel_id = ?`,
      channelId
    );
    const nextMessageNumber = normalizeMessageNumber(messageNumber);

    if (!watch || watch.resource_id !== resourceId) {
      return {
        accepted: false,
        spreadsheetId: null,
        debounceUntil: null
      };
    }

    if (this.shouldIgnoreNotification(watch, messageNumber)) {
      return {
        accepted: true,
        spreadsheetId: watch.spreadsheet_id,
        debounceUntil: watch.debounce_until
      };
    }

    const parsedExpiration = this.parseDriveNotificationExpiration(channelExpiration);
    if (resourceState === 'sync') {
      this.ctx.storage.sql.exec(
        `
        UPDATE spreadsheet_watches
        SET last_notification_at = ?,
            expiration_at = COALESCE(?, expiration_at),
            last_message_number = COALESCE(?, last_message_number),
            last_watch_error = NULL,
            updated_at = ?
        WHERE spreadsheet_id = ?
        `,
        changedAt,
        parsedExpiration,
        nextMessageNumber,
        changedAt,
        watch.spreadsheet_id
      );
      await this.scheduleNextAlarm();
      return {
        accepted: true,
        spreadsheetId: watch.spreadsheet_id,
        debounceUntil: null
      };
    }

    const debounceUntil = new Date(Date.parse(changedAt) + watch.debounce_seconds * 1000).toISOString();
    this.ctx.storage.sql.exec(
      `
      UPDATE spreadsheet_watches
      SET last_notification_at = ?,
          pending_changed_at = ?,
          debounce_until = ?,
          expiration_at = COALESCE(?, expiration_at),
          last_message_number = COALESCE(?, last_message_number),
          last_watch_error = NULL,
          updated_at = ?
      WHERE spreadsheet_id = ?
      `,
      changedAt,
      changedAt,
      debounceUntil,
      parsedExpiration,
      nextMessageNumber,
      changedAt,
      watch.spreadsheet_id
    );

    await this.markSpreadsheetTablesExternallyDirty(watch.spreadsheet_id, changedAt, debounceUntil);
    await this.scheduleNextAlarm();

    return {
      accepted: true,
      spreadsheetId: watch.spreadsheet_id,
      debounceUntil
    };
  }

  private getSpreadsheetRegistrations() {
    const rows = this.selectRows<RegistryRow>(
      `
      SELECT slug, name, spreadsheet_id, google_credential_ref, table_count, updated_at
      FROM project_registry
      ORDER BY spreadsheet_id ASC, slug ASC
      `
    );

    const grouped = new Map<string, { googleCredentialRef: string; projectSlugs: string[] }>();
    for (const row of rows) {
      const existing = grouped.get(row.spreadsheet_id);
      if (!existing) {
        grouped.set(row.spreadsheet_id, {
          googleCredentialRef: row.google_credential_ref,
          projectSlugs: [row.slug]
        });
        continue;
      }

      if (existing.googleCredentialRef !== row.google_credential_ref) {
        throw new ServiceUnavailableError(`Spreadsheet ${row.spreadsheet_id} is registered with conflicting Google credential refs.`, {
          spreadsheetId: row.spreadsheet_id,
          firstGoogleCredentialRef: existing.googleCredentialRef,
          conflictingGoogleCredentialRef: row.google_credential_ref
        });
      }

      existing.projectSlugs.push(row.slug);
    }

    return [...grouped.entries()].map(([spreadsheetId, value]) => ({
      spreadsheetId,
      googleCredentialRef: value.googleCredentialRef,
      projectSlugs: value.projectSlugs
    }));
  }

  private getSpreadsheetWatch(spreadsheetId: string) {
    return this.selectOptionalRow<SpreadsheetWatchRow>(
      `SELECT * FROM spreadsheet_watches WHERE spreadsheet_id = ?`,
      spreadsheetId
    );
  }

  private listSpreadsheetWatches() {
    return this.selectRows<SpreadsheetWatchRow>(
      `
      SELECT *
      FROM spreadsheet_watches
      ORDER BY spreadsheet_id ASC
      `
    );
  }

  private listSpreadsheetWatchesForAdmin(): AdminListSpreadsheetWatchesResult {
    const projectSlugsBySpreadsheetId = this.getProjectSlugsBySpreadsheetId();
    return {
      data: this.listSpreadsheetWatches().map((row) =>
        this.mapSpreadsheetWatch(row, projectSlugsBySpreadsheetId.get(row.spreadsheet_id) ?? [])
      )
    };
  }

  private listSpreadsheetWatchRetryAdviceForAdmin(): AdminListSpreadsheetWatchRetryAdviceResult {
    const projectSlugsBySpreadsheetId = this.getProjectSlugsBySpreadsheetId();
    const activeWatchesBySpreadsheetId = new Map(
      this.listSpreadsheetWatches().map((watch) => [watch.spreadsheet_id, watch] as const)
    );
    const tombstonesBySpreadsheetId = new Map(
      this.listSpreadsheetWatchTombstones().map((row) => [row.spreadsheet_id, row] as const)
    );
    const spreadsheetIds = new Set<string>([
      ...projectSlugsBySpreadsheetId.keys(),
      ...activeWatchesBySpreadsheetId.keys(),
      ...tombstonesBySpreadsheetId.keys()
    ]);

    return {
      data: [...spreadsheetIds]
        .sort((left, right) => left.localeCompare(right))
        .map((spreadsheetId) =>
          this.mapSpreadsheetWatchRetryAdvice(
            spreadsheetId,
            activeWatchesBySpreadsheetId.get(spreadsheetId) ?? null,
            tombstonesBySpreadsheetId.get(spreadsheetId) ?? null,
            projectSlugsBySpreadsheetId.get(spreadsheetId) ?? []
          )
        )
    };
  }

  private requireSpreadsheetWatch(spreadsheetId: string) {
    const watch = this.getSpreadsheetWatch(spreadsheetId);
    if (!watch) {
      throw new Error(`Spreadsheet watch ${spreadsheetId} was not found.`);
    }

    return watch;
  }

  private listSpreadsheetWatchTombstones() {
    return this.selectRows<SpreadsheetWatchTombstoneRow>(
      `
      SELECT *
      FROM spreadsheet_watch_tombstones
      ORDER BY spreadsheet_id ASC
      `
    );
  }

  private async stopExistingSpreadsheetWatch(watch: SpreadsheetWatchRow) {
    try {
      await this.getSheetsClient(watch.google_credential_ref).stopDriveChannel(watch.channel_id, watch.resource_id);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return;
      }

      throw error;
    }
  }

  private async removeObsoleteSpreadsheetWatches(activeSpreadsheetIds: ReadonlySet<string>) {
    for (const watch of this.listSpreadsheetWatches()) {
      if (activeSpreadsheetIds.has(watch.spreadsheet_id)) {
        continue;
      }

      await this.stopExistingSpreadsheetWatch(watch);
      this.recordSpreadsheetWatchTombstone(watch);
      this.ctx.storage.sql.exec(
        `
        DELETE FROM spreadsheet_watches
        WHERE spreadsheet_id = ?
        `,
        watch.spreadsheet_id
      );
    }
  }

  private async createSpreadsheetWatch(
    spreadsheetId: string,
    googleCredentialRef: string,
    request: {
      webhookUrl: string;
      token: string;
      expirationMs: number | null;
    },
    existingWatch: SpreadsheetWatchRow | null
  ) {
    try {
      return {
        watch: await this.getSheetsClient(googleCredentialRef).watchSpreadsheetFile(spreadsheetId, request),
        stoppedExistingWatch: false
      };
    } catch (error) {
      if (!existingWatch || !isDriveWatchSubscriptionQuotaError(error)) {
        throw error;
      }

      await this.stopExistingSpreadsheetWatch(existingWatch);
      try {
        return {
          watch: await this.getSheetsClient(googleCredentialRef).watchSpreadsheetFile(spreadsheetId, request),
          stoppedExistingWatch: true
        };
      } catch (retryError) {
        this.recordSpreadsheetWatchTombstone(existingWatch);
        this.deleteSpreadsheetWatch(existingWatch.spreadsheet_id);
        await this.scheduleNextAlarm();
        throw retryError;
      }
    }
  }

  private deleteSpreadsheetWatch(spreadsheetId: string) {
    this.ctx.storage.sql.exec(
      `
      DELETE FROM spreadsheet_watches
      WHERE spreadsheet_id = ?
      `,
      spreadsheetId
    );
  }

  private async renewSpreadsheetWatch(watch: SpreadsheetWatchRow) {
    const webhookToken = this.env.GOOGLE_DRIVE_WEBHOOK_SECRET?.trim();
    if (!watch.webhook_url?.trim()) {
      this.recordWatchError(watch.spreadsheet_id, 'Spreadsheet watch is missing its stored webhook URL.');
      return;
    }

    if (!webhookToken) {
      this.recordWatchError(watch.spreadsheet_id, 'GOOGLE_DRIVE_WEBHOOK_SECRET is not configured.');
      return;
    }

    const now = new Date().toISOString();
    const durationMs = this.getWatchDurationMs(watch);

    try {
      const renewedWatch = await this.getSheetsClient(watch.google_credential_ref).watchSpreadsheetFile(
        watch.spreadsheet_id,
        {
          webhookUrl: watch.webhook_url,
          token: webhookToken,
          expirationMs: Date.now() + durationMs
        }
      );

      this.ctx.storage.sql.exec(
        `
        UPDATE spreadsheet_watches
        SET channel_id = ?,
            resource_id = ?,
            resource_uri = ?,
            expiration_at = ?,
            expiration_duration_ms = ?,
            last_message_number = NULL,
            last_watch_error = NULL,
            updated_at = ?
        WHERE spreadsheet_id = ?
        `,
        renewedWatch.channelId,
        renewedWatch.resourceId,
        renewedWatch.resourceUri,
        renewedWatch.expirationAt,
        durationMs,
        now,
        watch.spreadsheet_id
      );

      await this.stopExistingSpreadsheetWatch(watch);
    } catch (error) {
      this.recordWatchError(watch.spreadsheet_id, describeWatchError(error));
    }
  }

  private async markSpreadsheetTablesExternallyDirty(spreadsheetId: string, changedAt: string, debounceUntil: string) {
    for (const projectSlug of this.getProjectSlugsForSpreadsheet(spreadsheetId)) {
      const tables = await this.listProjectTables(projectSlug);
      for (const table of tables) {
        await doRpc<TableDoResponse>(getTableStub(this.env, projectSlug, table.tableSlug), {
          type: 'table.external-change.record',
          projectSlug,
          tableSlug: table.tableSlug,
          changedAt,
          debounceUntil,
          requestContext: this.buildSystemRequestContext('control.spreadsheet-watch.notify')
        });
      }
    }
  }

  private async reindexSpreadsheetWatch(watch: SpreadsheetWatchRow) {
    const startedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
      UPDATE spreadsheet_watches
      SET last_reindex_started_at = ?, last_reindex_error = NULL, updated_at = ?
      WHERE spreadsheet_id = ?
      `,
      startedAt,
      startedAt,
      watch.spreadsheet_id
    );

    try {
      for (const projectSlug of this.getProjectSlugsForSpreadsheet(watch.spreadsheet_id)) {
        const tables = await this.listProjectTables(projectSlug);
        for (const table of tables) {
          await doRpc<TableDoResponse>(getTableStub(this.env, projectSlug, table.tableSlug), {
            type: 'table.reindex',
            projectSlug,
            tableSlug: table.tableSlug,
            requestContext: this.buildSystemRequestContext('control.spreadsheet-watch.alarm', 'external-change')
          });
        }
      }

      const completedAt = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `
        UPDATE spreadsheet_watches
        SET pending_changed_at = NULL,
            debounce_until = NULL,
            last_reindex_completed_at = ?,
            last_reindex_error = NULL,
            updated_at = ?
        WHERE spreadsheet_id = ?
        `,
        completedAt,
        completedAt,
        watch.spreadsheet_id
      );
    } catch (error) {
      const retryAt = new Date(Date.now() + Math.max(watch.debounce_seconds, 30) * 1000).toISOString();
      this.ctx.storage.sql.exec(
        `
        UPDATE spreadsheet_watches
        SET debounce_until = ?,
            last_reindex_error = ?,
            updated_at = ?
        WHERE spreadsheet_id = ?
        `,
        retryAt,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        watch.spreadsheet_id
      );
    }
  }

  private getProjectSlugsForSpreadsheet(spreadsheetId: string) {
    return this.selectRows<{ slug: string }>(
      `
      SELECT slug
      FROM project_registry
      WHERE spreadsheet_id = ?
      ORDER BY slug ASC
      `,
      spreadsheetId
    ).map((row) => row.slug);
  }

  private getProjectSlugsBySpreadsheetId() {
    const rows = this.selectRows<{ spreadsheet_id: string; slug: string }>(
      `
      SELECT spreadsheet_id, slug
      FROM project_registry
      ORDER BY spreadsheet_id ASC, slug ASC
      `
    );

    const projectSlugsBySpreadsheetId = new Map<string, string[]>();
    for (const row of rows) {
      const existing = projectSlugsBySpreadsheetId.get(row.spreadsheet_id);
      if (existing) {
        existing.push(row.slug);
        continue;
      }

      projectSlugsBySpreadsheetId.set(row.spreadsheet_id, [row.slug]);
    }

    return projectSlugsBySpreadsheetId;
  }

  private async listProjectTables(projectSlug: string): Promise<TableConfig[]> {
    const response = await doRpc<ProjectDoResponse>(getProjectStub(this.env, projectSlug), {
      type: 'project.table.list',
      projectSlug
    });

    return (response as {
      type: 'project.table.list.result';
      result: { data: TableConfig[] };
    }).result.data;
  }

  private async scheduleNextAlarm() {
    const nextDebounceAtMs = this.getNextDebounceAlarmAtMs();
    const nextRenewalAtMs = this.getNextRenewalAlarmAtMs();
    const nextAlarmAtMs = this.getEarlierAlarmAtMs(nextDebounceAtMs, nextRenewalAtMs);

    if (nextAlarmAtMs === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarmAtMs);
  }

  private parseDriveNotificationExpiration(value: string | null) {
    if (!value) {
      return null;
    }

    const parsedMs = Date.parse(value);
    return Number.isNaN(parsedMs) ? null : new Date(parsedMs).toISOString();
  }

  private shouldIgnoreNotification(watch: SpreadsheetWatchRow, messageNumber: string | null) {
    const comparison = compareMessageNumbers(messageNumber, watch.last_message_number);
    return comparison !== null && comparison <= 0;
  }

  private getWatchDurationMs(watch: Pick<SpreadsheetWatchRow, 'expiration_duration_ms'>) {
    return watch.expiration_duration_ms && watch.expiration_duration_ms > 0
      ? watch.expiration_duration_ms
      : defaultWatchDurationMs;
  }

  private getWatchRenewAtMs(watch: SpreadsheetWatchRenewalRow) {
    if (!watch.expiration_at) {
      return null;
    }

    const expirationAtMs = Date.parse(watch.expiration_at);
    if (Number.isNaN(expirationAtMs)) {
      return null;
    }

    const renewalLeadMs = this.getWatchRenewLeadMs(this.getWatchDurationMs(watch));
    const renewalDueAtMs = expirationAtMs - renewalLeadMs;
    if (!watch.last_watch_error) {
      return renewalDueAtMs;
    }

    const updatedAtMs = Date.parse(watch.updated_at);
    if (Number.isNaN(updatedAtMs)) {
      return renewalDueAtMs;
    }

    return Math.max(renewalDueAtMs, updatedAtMs + getWatchRenewRetryDelayMs(watch.last_watch_error));
  }

  private getWatchRenewLeadMs(durationMs: number) {
    return Math.min(
      maxWatchRenewLeadMs,
      Math.max(minWatchRenewLeadMs, Math.floor(durationMs / 4))
    );
  }

  private getNextDebounceAlarmAtMs() {
    const next = this.selectOptionalRow<{ debounce_until: string }>(
      `
      SELECT debounce_until
      FROM spreadsheet_watches
      WHERE pending_changed_at IS NOT NULL
        AND debounce_until IS NOT NULL
      ORDER BY debounce_until ASC
      LIMIT 1
      `
    );

    if (!next?.debounce_until) {
      return null;
    }

    const debounceAtMs = Date.parse(next.debounce_until);
    return Number.isNaN(debounceAtMs) ? null : debounceAtMs;
  }

  private getNextRenewalAlarmAtMs() {
    let nextRenewalAtMs: number | null = null;

    for (const watch of this.selectRows<SpreadsheetWatchRenewalRow>(
      `
      SELECT spreadsheet_id, expiration_at, expiration_duration_ms, last_watch_error, updated_at
      FROM spreadsheet_watches
      WHERE expiration_at IS NOT NULL
      ORDER BY expiration_at ASC, spreadsheet_id ASC
      `
    )) {
      const renewAtMs = this.getWatchRenewAtMs(watch);
      if (renewAtMs === null) {
        continue;
      }

      nextRenewalAtMs = nextRenewalAtMs === null ? renewAtMs : Math.min(nextRenewalAtMs, renewAtMs);
    }

    return nextRenewalAtMs;
  }

  private getEarlierAlarmAtMs(left: number | null, right: number | null) {
    if (left === null) {
      return right;
    }

    if (right === null) {
      return left;
    }

    return Math.min(left, right);
  }

  private recordWatchError(spreadsheetId: string, message: string) {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
      UPDATE spreadsheet_watches
      SET last_watch_error = ?, updated_at = ?
      WHERE spreadsheet_id = ?
      `,
      message,
      now,
      spreadsheetId
    );
  }

  private recordSpreadsheetWatchTombstone(watch: Pick<SpreadsheetWatchRow, 'spreadsheet_id' | 'expiration_at'>) {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `
      INSERT INTO spreadsheet_watch_tombstones (spreadsheet_id, expiration_at, stopped_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        expiration_at = excluded.expiration_at,
        stopped_at = excluded.stopped_at,
        updated_at = excluded.updated_at
      `,
      watch.spreadsheet_id,
      watch.expiration_at,
      now,
      now
    );
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

  private buildSystemRequestContext(route: string, syncSource: TableRequestContext['syncSource'] = 'request'): TableRequestContext {
    return {
      requestId: `control:${crypto.randomUUID()}`,
      route,
      principal: 'system:drive-watch',
      syncSource
    };
  }

  private mapSpreadsheetWatch(row: SpreadsheetWatchRow, projectSlugs: string[]): AdminRegisterSpreadsheetWatchesResult['data'][number] {
    return {
      spreadsheetId: row.spreadsheet_id,
      googleCredentialRef: row.google_credential_ref,
      channelId: row.channel_id,
      resourceId: row.resource_id,
      resourceUri: row.resource_uri,
      expirationAt: row.expiration_at,
      lastWatchError: row.last_watch_error,
      lastNotificationAt: row.last_notification_at,
      pendingChangedAt: row.pending_changed_at,
      debounceUntil: row.debounce_until,
      lastReindexStartedAt: row.last_reindex_started_at,
      lastReindexCompletedAt: row.last_reindex_completed_at,
      lastReindexError: row.last_reindex_error,
      projectSlugs
    };
  }

  private mapSpreadsheetWatchRetryAdvice(
    spreadsheetId: string,
    activeWatch: SpreadsheetWatchRow | null,
    tombstone: SpreadsheetWatchTombstoneRow | null,
    projectSlugs: string[]
  ): AdminListSpreadsheetWatchRetryAdviceResult['data'][number] {
    if (activeWatch) {
      return {
        spreadsheetId,
        status: 'active-watch-present',
        currentWatchExpirationAt: activeWatch.expiration_at,
        lastKnownStoppedAt: tombstone?.stopped_at ?? null,
        lastKnownExpirationAt: tombstone?.expiration_at ?? null,
        safeRetryAt: null,
        note: 'A known Drive watch is still active for this spreadsheet.',
        projectSlugs
      };
    }

    if (tombstone) {
      const safeRetryAt = getSpreadsheetWatchSafeRetryAt(tombstone);
      const safeRetryAtMs = safeRetryAt ? Date.parse(safeRetryAt) : Number.NaN;
      const status =
        safeRetryAt && !Number.isNaN(safeRetryAtMs) && safeRetryAtMs > Date.now()
          ? 'cooldown-recommended'
          : 'ready-to-retry';

      return {
        spreadsheetId,
        status,
        currentWatchExpirationAt: null,
        lastKnownStoppedAt: tombstone.stopped_at,
        lastKnownExpirationAt: tombstone.expiration_at,
        safeRetryAt,
        note:
          status === 'cooldown-recommended'
            ? 'Wait until after the last known watch expiration plus a short grace window before re-registering.'
            : 'No active watch is recorded and the cooldown window has elapsed.',
        projectSlugs
      };
    }

    return {
      spreadsheetId,
      status: 'ready-to-retry',
      currentWatchExpirationAt: null,
      lastKnownStoppedAt: null,
      lastKnownExpirationAt: null,
      safeRetryAt: null,
      note: 'No active or previously stopped watch is recorded for this spreadsheet.',
      projectSlugs
    };
  }

  private mapApiKeyPrincipal(row: ApiKeyRow): ApiKeyPrincipal {
    const record: ApiKeyRecord = {
      id: row.id,
      projectSlug: row.project_slug,
      name: row.name,
      hash: row.hash,
      scopes: JSON.parse(row.scopes) as ApiKeyRecord['scopes'],
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at
    };

    const { hash: unusedHash, ...principal } = record;
    void unusedHash;
    return principal;
  }
}

function compareMessageNumbers(left: string | null, right: string | null) {
  if (!left || !right || !/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    return null;
  }

  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) {
    return 0;
  }

  return leftValue < rightValue ? -1 : 1;
}

function normalizeMessageNumber(value: string | null) {
  return value && /^\d+$/.test(value) ? value : null;
}

function getWatchRenewRetryDelayMs(lastWatchError: string | null) {
  return isNonRetriableWatchConfigurationError(lastWatchError)
    ? watchRenewConfigRetryMs
    : watchRenewRetryMs;
}

function isNonRetriableWatchConfigurationError(lastWatchError: string | null) {
  return lastWatchError === 'Spreadsheet watch is missing its stored webhook URL.'
    || lastWatchError === 'GOOGLE_DRIVE_WEBHOOK_SECRET is not configured.';
}

function isDriveWatchSubscriptionQuotaError(error: unknown) {
  if (!(error instanceof AppError) || error.code !== 'BAD_GATEWAY') {
    return false;
  }

  const detailsMessage =
    typeof error.details === 'object'
    && error.details !== null
    && 'message' in error.details
    && typeof error.details.message === 'string'
      ? error.details.message
      : '';

  return detailsMessage.includes('Rate limit exceeded for creating file subscriptions.');
}

function describeWatchError(error: unknown) {
  if (!(error instanceof AppError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const detailsMessage =
    typeof error.details === 'object'
    && error.details !== null
    && 'message' in error.details
    && typeof error.details.message === 'string'
      ? error.details.message
      : null;

  return detailsMessage ? `${error.message} ${detailsMessage}` : error.message;
}

function getSpreadsheetWatchSafeRetryAt(tombstone: SpreadsheetWatchTombstoneRow) {
  const referenceTimes = [tombstone.expiration_at, tombstone.stopped_at]
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value));

  if (referenceTimes.length === 0) {
    return null;
  }

  return new Date(Math.max(...referenceTimes) + watchRetryAdviceGraceMs).toISOString();
}
