import type {
  AdminCreateApiKeyResult,
  AdminListApiKeysResult,
  AdminListProjectsResult,
  ApiKeyPrincipal,
  ApiKeyRecord,
  ControlPlaneDoRequest,
  ControlPlaneDoResponse,
  ProjectSummary
} from '@sheetflare/contracts';

type RegistryRow = {
  slug: string;
  name: string;
  spreadsheet_id: string;
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

export class ControlPlaneDO {
  constructor(
    private readonly ctx: DurableObjectState,
    env: unknown
  ) {
    void env;
    this.initialize();
  }

  private initialize() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_registry (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spreadsheet_id TEXT NOT NULL,
        table_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

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

    const body = (await request.json()) as ControlPlaneDoRequest;
    const result = await this.handle(body);
    return Response.json(result);
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
        SELECT slug, name, spreadsheet_id, table_count, updated_at
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
      INSERT INTO project_registry (slug, name, spreadsheet_id, table_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        spreadsheet_id = excluded.spreadsheet_id,
        table_count = excluded.table_count,
        updated_at = excluded.updated_at
      `,
      summary.slug,
      summary.name,
      summary.spreadsheetId,
      summary.tableCount,
      summary.updatedAt
    );
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

  private verifyApiKey(apiKeyId: string, hash: string): ApiKeyPrincipal | null {
    const row = this.ctx.storage.sql
      .exec(`SELECT * FROM api_keys WHERE id = ?`, apiKeyId)
      .one() as ApiKeyRow | null;

    if (!row || row.revoked_at || row.hash !== hash) {
      return null;
    }

    return this.mapApiKeyPrincipal(row);
  }

  private touchApiKey(apiKeyId: string, usedAt: string) {
    this.ctx.storage.sql.exec(
      `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
      usedAt,
      apiKeyId
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
    const row = this.ctx.storage.sql
      .exec(`SELECT * FROM api_keys WHERE id = ?`, apiKeyId)
      .one() as ApiKeyRow | null;

    return row ? this.mapApiKeyPrincipal(row) : null;
  }

  private mapSummary(row: RegistryRow): ProjectSummary {
    return {
      slug: row.slug,
      name: row.name,
      spreadsheetId: row.spreadsheet_id,
      tableCount: row.table_count,
      updatedAt: row.updated_at
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

    const { hash: _, ...principal } = record;
    return principal;
  }
}
