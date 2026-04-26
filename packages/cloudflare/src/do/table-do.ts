import {
  BadRequestError,
  ForbiddenError,
  type GetSchemaResult,
  type ListRowsQuery,
  NotFoundError,
  type RowEnvelope,
  type RowRecord,
  type TableConfig,
  type TableDoRequest,
  type TableDoResponse
} from '@sheetflare/contracts';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  generateRowId,
  inferTableSchema,
  normalizeListQuery,
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

function compareValues(
  left: RowRecord[string] | undefined,
  right: RowRecord[string] | undefined
) {
  const leftComparable = Array.isArray(left) ? JSON.stringify(left) : left;
  const rightComparable = Array.isArray(right) ? JSON.stringify(right) : right;

  if (leftComparable === rightComparable) return 0;
  if (leftComparable === null) return -1;
  if (rightComparable === null) return 1;
  return String(leftComparable).localeCompare(String(rightComparable), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function sortRows(rows: RowEnvelope[], sort: string | null): RowEnvelope[] {
  if (!sort) return rows;

  const [field, rawDirection] = sort.split(':');
  const direction = rawDirection === 'desc' ? -1 : 1;
  if (!field) return rows;

  return [...rows].sort((left, right) => {
    if (field === 'rowNumber') {
      return (left.rowNumber - right.rowNumber) * direction;
    }

    return compareValues(left.values[field], right.values[field]) * direction;
  });
}

function filterFields(rows: RowEnvelope[], fields: string[] | null) {
  if (!fields || fields.length === 0) return rows;

  const allowed = new Set(fields);
  return rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      Object.entries(row.values).filter(([key]) => allowed.has(key))
    )
  }));
}

function getProjectStub(env: CloudflareEnv, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

export class TableDO {
  private readonly sheets: GoogleSheetsService;

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
      case 'table.reindex':
        return {
          type: 'table.reindex.result',
          result: await this.reindex(body.projectSlug, body.tableSlug)
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

    const query = normalizeListQuery(rawQuery);
    const offset = decodeOffsetCursor(query.cursor);
    const rows = filterFields(sortRows(await this.sheets.readAllRows(config), query.sort), query.fields);
    const page = rows.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;

    return {
      data: page,
      nextCursor: nextOffset < rows.length ? encodeOffsetCursor(nextOffset) : null
    };
  }

  private async getRow(projectSlug: string, tableSlug: string, rowId: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.readEnabled) {
      throw new ForbiddenError(`Reads are disabled for ${projectSlug}/${tableSlug}.`);
    }

    let rowNumber = this.lookupRowNumber(rowId);
    if (!rowNumber) {
      await this.reindex(projectSlug, tableSlug);
      rowNumber = this.lookupRowNumber(rowId);
    }

    if (!rowNumber) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    return {
      data: await this.sheets.readSingleRow(config, rowNumber)
    };
  }

  private async createRow(projectSlug: string, tableSlug: string, input: RowRecord) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    if (!config.createEnabled) {
      throw new ForbiddenError(`Creates are disabled for ${projectSlug}/${tableSlug}.`);
    }

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

    const headers = await this.getHeaders(config);
    let rowNumber = this.lookupRowNumber(rowId);
    if (!rowNumber) {
      await this.reindex(projectSlug, tableSlug);
      rowNumber = this.lookupRowNumber(rowId);
    }

    if (!rowNumber) {
      throw new BadRequestError(`Row ${rowId} was not found.`);
    }

    const existingRow = await this.sheets.readSingleRow(config, rowNumber);
    const patchValues = Object.fromEntries(
      Object.entries(patch).filter((entry): entry is [string, RowRecord[string]] => entry[1] !== undefined)
    );
    const mergedValues = normalizeRowValues({
      ...existingRow.values,
      ...patchValues,
      [config.idColumn]: rowId
    });
    const { values, ignoredKeys } = pickKnownColumns(mergedValues, headers);
    await this.sheets.writeRow(config, rowNumber, headers, values);

    return {
      data: {
        id: rowId,
        rowNumber,
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

    let rowNumber = this.lookupRowNumber(rowId);
    if (!rowNumber) {
      await this.reindex(projectSlug, tableSlug);
      rowNumber = this.lookupRowNumber(rowId);
    }

    if (!rowNumber) {
      throw new NotFoundError(`Row ${rowId} was not found.`);
    }

    await this.sheets.deleteRow(config, rowNumber);
    this.deleteRowIndex(rowId);
    await this.reindex(projectSlug, tableSlug);

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

    const rows = await this.sheets.readAllRows(config);
    return {
      data: inferTableSchema(rows.slice(0, 100))
    };
  }

  private async reindex(projectSlug: string, tableSlug: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    const rows = await this.sheets.readAllRows(config);

    this.ctx.storage.sql.exec(`DELETE FROM row_index`);
    for (const row of rows) {
      this.upsertRowIndex(row.id, row.rowNumber);
    }

    return {
      ok: true as const,
      rowCount: rows.length
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
}
