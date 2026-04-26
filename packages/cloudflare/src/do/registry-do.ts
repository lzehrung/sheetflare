import type { AdminListProjectsResult, ProjectSummary, RegistryDoRequest, RegistryDoResponse } from '@sheetflare/contracts';

type RegistryRow = {
  slug: string;
  name: string;
  spreadsheet_id: string;
  table_count: number;
  updated_at: string;
};

export class RegistryDO {
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
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = (await request.json()) as RegistryDoRequest;
    const result = await this.handle(body);
    return Response.json(result);
  }

  private async handle(body: RegistryDoRequest): Promise<RegistryDoResponse> {
    switch (body.type) {
      case 'registry.projects.list':
        return {
          type: 'registry.projects.list.result',
          result: this.listProjects()
        };
      case 'registry.project.upsert':
        this.upsertProjectSummary(body.summary);
        return {
          type: 'registry.project.upsert.result',
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

  private mapSummary(row: RegistryRow): ProjectSummary {
    return {
      slug: row.slug,
      name: row.name,
      spreadsheetId: row.spreadsheet_id,
      tableCount: row.table_count,
      updatedAt: row.updated_at
    };
  }
}
