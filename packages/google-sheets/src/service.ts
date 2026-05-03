import {
  BadGatewayError,
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  type RowEnvelope,
  type RowRecord,
  type TableConfig
} from '@sheetflare/contracts';
import { parseManagedRowId } from '@sheetflare/domain';

const googleSheetsScope = 'https://www.googleapis.com/auth/spreadsheets';
const googleDriveMetadataScope = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const googleApiScopes = `${googleSheetsScope} ${googleDriveMetadataScope}`;
const defaultOauthTokenUrl = 'https://oauth2.googleapis.com/token';
const defaultSheetsApiBaseUrl = 'https://sheets.googleapis.com/v4/spreadsheets';
const defaultDriveApiBaseUrl = 'https://www.googleapis.com/drive/v3';
const defaultRequestTimeoutMs = 15_000;
const defaultRetryCount = 2;

type FetchLike = typeof fetch;

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
};

type GoogleCellValue = string | number | boolean;

type GoogleValuesResponse = {
  values?: GoogleCellValue[][];
};

type GoogleAppendResponse = {
  updates?: {
    updatedRange?: string;
  };
};

type GoogleBatchValuesUpdateResponse = {
  totalUpdatedRows?: number;
};

type GoogleClearValuesResponse = {
  clearedRange?: string;
};

type GoogleSpreadsheetMetadataResponse = {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      sheetType?: string;
    };
  }>;
};

type GoogleDriveChannelResponse = {
  id?: string;
  resourceId?: string;
  resourceUri?: string;
  expiration?: string;
};

export type GoogleSheetTableConfig = TableConfig & {
  spreadsheetId: string;
};

export interface RowLookupResult {
  row: RowEnvelope;
  duplicateCount: number;
}

export interface TableSnapshot {
  headers: string[];
  rows: RowEnvelope[];
}

export interface SpreadsheetTabSummary {
  title: string;
  sheetGid: number;
}

export type RowReference = {
  rowId: string;
  rowNumber: number;
};

type HeaderLayoutEntry = {
  name: string;
  columnNumber: number;
};

export type GoogleSheetHeaderLayout = {
  headers: string[];
  entries: HeaderLayoutEntry[];
  idColumnNumber: number;
};

export interface GoogleServiceAccountConfig {
  clientEmail: string;
  privateKey: string;
  fetch?: FetchLike;
  oauthTokenUrl?: string;
  sheetsApiBaseUrl?: string;
  driveApiBaseUrl?: string;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

export interface GoogleDriveWatchRequest {
  webhookUrl: string;
  token: string;
  expirationMs?: number | null;
}

export interface GoogleDriveWatch {
  channelId: string;
  resourceId: string;
  resourceUri: string | null;
  expirationAt: string | null;
}

export function serializeSheetCell(value: RowRecord[string]): string | number | boolean {
  if (value === null) return '';
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

export function parseSheetCellValue(value: GoogleCellValue | undefined): RowRecord[string] {
  if (value === undefined || value === '') {
    return null;
  }

  return value;
}

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function escapeSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function columnNumberToA1(columnNumber: number): string {
  let current = columnNumber;
  let result = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }

  return result;
}

function buildBoundedTableRange(headerRow: number, lastColumnNumber: number) {
  const lastColumn = columnNumberToA1(lastColumnNumber);
  return `A${headerRow}:${lastColumn}`;
}

function buildBoundedRowRange(rowNumber: number, lastColumnNumber: number) {
  const lastColumn = columnNumberToA1(lastColumnNumber);
  return `A${rowNumber}:${lastColumn}${rowNumber}`;
}

function buildBoundedRowSpanRange(startRowNumber: number, endRowNumber: number, lastColumnNumber: number) {
  const lastColumn = columnNumberToA1(lastColumnNumber);
  return `A${startRowNumber}:${lastColumn}${endRowNumber}`;
}

type ColumnValueSegment = {
  startColumnNumber: number;
  values: Array<string | number | boolean>;
};

function buildColumnValueSegments(
  layout: GoogleSheetHeaderLayout,
  values: Partial<RowRecord>
): ColumnValueSegment[] {
  const segments: ColumnValueSegment[] = [];
  let currentSegment: ColumnValueSegment | null = null;

  for (const entry of layout.entries) {
    if (!Object.prototype.hasOwnProperty.call(values, entry.name)) {
      currentSegment = null;
      continue;
    }

    const nextValue = values[entry.name];
    if (nextValue === undefined) {
      currentSegment = null;
      continue;
    }

    const serializedValue = serializeSheetCell(nextValue);
    if (
      currentSegment &&
      currentSegment.startColumnNumber + currentSegment.values.length === entry.columnNumber
    ) {
      currentSegment.values.push(serializedValue);
      continue;
    }

    currentSegment = {
      startColumnNumber: entry.columnNumber,
      values: [serializedValue]
    };
    segments.push(currentSegment);
  }

  return segments;
}

function parseUpdatedRangeRowNumber(updatedRange: string | undefined): number {
  if (!updatedRange) {
    throw new Error('Google Sheets append response did not include an updated range.');
  }

  const match = updatedRange.match(/![A-Z]+(\d+):/);
  if (!match) {
    throw new Error(`Could not parse row number from range: ${updatedRange}`);
  }

  return Number(match[1]);
}

function extractHeaderEntries(headerRow: readonly GoogleCellValue[] | undefined): HeaderLayoutEntry[] {
  const entries: HeaderLayoutEntry[] = [];
  const seenHeaders = new Set<string>();

  for (const [index, rawHeader] of (headerRow ?? []).entries()) {
    if (typeof rawHeader !== 'string') {
      throw new BadRequestError('Sheet headers must be non-empty strings.', {
        columnNumber: index + 1,
        value: rawHeader
      });
    }

    const header = rawHeader.trim();
    if (!header) {
      continue;
    }

    if (seenHeaders.has(header)) {
      throw new BadRequestError(`Duplicate header "${header}" was found in the configured sheet header row.`, {
        header
      });
    }

    seenHeaders.add(header);

    entries.push({
      name: header,
      columnNumber: index + 1
    });
  }

  if (entries.length === 0) {
    throw new NotFoundError('No headers found for the requested sheet range.');
  }

  return entries;
}

function buildHeaderLayout(headerRow: readonly GoogleCellValue[] | undefined, idColumn: string): GoogleSheetHeaderLayout {
  const entries = extractHeaderEntries(headerRow);

  const idEntry = entries.find((entry) => entry.name === idColumn);
  if (!idEntry) {
    throw new NotFoundError(`Required id column ${idColumn} was not found in the header row.`, {
      idColumn
    });
  }

  return {
    headers: entries.map((entry) => entry.name),
    entries,
    idColumnNumber: idEntry.columnNumber
  };
}

function buildRowEnvelope(
  config: GoogleSheetTableConfig,
  layout: GoogleSheetHeaderLayout,
  rowNumber: number,
  cells: readonly GoogleCellValue[]
): RowEnvelope {
  const values: RowRecord = {};

  for (const entry of layout.entries) {
    values[entry.name] = parseSheetCellValue(cells[entry.columnNumber - 1]);
  }

  return {
    id: getManagedRowId(values[config.idColumn], config.idColumn, rowNumber),
    rowNumber,
    values
  };
}

function getManagedRowId(value: RowRecord[string] | undefined, idColumn: string, rowNumber: number) {
  const parsed = parseManagedRowId(value);
  if (parsed.ok) {
    return parsed.rowId;
  }

  if (parsed.reason === 'missing') {
    throw new BadRequestError(`Blank managed row id detected in column ${idColumn} at row ${rowNumber}.`, {
      idColumn,
      rowNumber
    });
  }

  throw new BadRequestError(
    `Managed row id in column ${idColumn} at row ${rowNumber} must be a non-blank string, number, or boolean.`,
    {
      idColumn,
      rowNumber
    }
  );
}

export class GoogleSheetsService {
  private readonly fetchImpl: FetchLike;
  private readonly oauthTokenUrl: string;
  private readonly sheetsApiBaseUrl: string;
  private readonly driveApiBaseUrl: string;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private tokenCache: { value: string; expiresAtMs: number } | null = null;

  constructor(private readonly config: GoogleServiceAccountConfig) {
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.oauthTokenUrl = config.oauthTokenUrl ?? defaultOauthTokenUrl;
    this.sheetsApiBaseUrl = config.sheetsApiBaseUrl ?? defaultSheetsApiBaseUrl;
    this.driveApiBaseUrl = config.driveApiBaseUrl ?? defaultDriveApiBaseUrl;
    this.now = config.now ?? Date.now;
    this.delay = config.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async readHeaderLayout(config: GoogleSheetTableConfig): Promise<GoogleSheetHeaderLayout> {
    const values = await this.readValues(
      config.spreadsheetId,
      `${escapeSheetName(config.sheetTabName)}!${config.headerRow}:${config.headerRow}`
    );

    return buildHeaderLayout(values[0], config.idColumn);
  }

  async readHeaders(config: GoogleSheetTableConfig): Promise<string[]> {
    const layout = await this.readHeaderLayout(config);
    return layout.headers;
  }

  async getHeaderLayout(config: GoogleSheetTableConfig): Promise<GoogleSheetHeaderLayout> {
    return this.readHeaderLayout(config);
  }

  async readHeaderNames(spreadsheetId: string, sheetTabName: string, headerRow: number): Promise<string[]> {
    const values = await this.readValues(
      spreadsheetId,
      `${escapeSheetName(sheetTabName)}!${headerRow}:${headerRow}`
    );

    return extractHeaderEntries(values[0]).map((entry) => entry.name);
  }

  async listSheetTabs(spreadsheetId: string): Promise<SpreadsheetTabSummary[]> {
    const metadata = await this.readSpreadsheetMetadata(spreadsheetId);
    return metadata.sheets
      ?.map((sheet) => {
        const rawTitle = sheet.properties?.title;
        const sheetGid = sheet.properties?.sheetId;
        const sheetType = sheet.properties?.sheetType;
        if (
          typeof rawTitle !== 'string'
          || rawTitle.trim().length === 0
          || sheetGid === undefined
          || (sheetType !== undefined && sheetType !== 'GRID')
        ) {
          return null;
        }

        return {
          title: rawTitle,
          sheetGid
        };
      })
      .filter((entry): entry is SpreadsheetTabSummary => entry !== null)
      ?? [];
  }

  async readTableSnapshot(config: GoogleSheetTableConfig): Promise<TableSnapshot> {
    const layout = await this.readHeaderLayout(config);
    const values = await this.readValues(
      config.spreadsheetId,
      `${escapeSheetName(config.sheetTabName)}!${buildBoundedTableRange(config.headerRow, layout.entries.at(-1)?.columnNumber ?? 1)}`
    );
    const dataIndex = Math.max(config.dataStartRow - config.headerRow, 1);

    return {
      headers: layout.headers,
      rows: values
        .slice(dataIndex)
        .map((cells, index) => buildRowEnvelope(config, layout, config.dataStartRow + index, cells))
        .filter((row) => Object.values(row.values).some((value) => value !== null))
    };
  }

  async readAllRows(config: GoogleSheetTableConfig): Promise<RowEnvelope[]> {
    return (await this.readTableSnapshot(config)).rows;
  }

  async findRowById(
    config: GoogleSheetTableConfig,
    rowId: string,
    rowNumberHint?: number | null,
    options?: { verifyUnique?: boolean; layout?: GoogleSheetHeaderLayout }
  ): Promise<RowLookupResult | null> {
    const verifyUnique = options?.verifyUnique ?? true;
    const layout = options?.layout ?? await this.readHeaderLayout(config);
    let hintedRow: RowEnvelope | null = null;
    if (rowNumberHint) {
      hintedRow = await this.readSingleRow(config, rowNumberHint, layout).catch(() => null);
    }

    if (hintedRow?.id === rowId && !verifyUnique) {
      return {
        row: hintedRow,
        duplicateCount: 1
      };
    }

    const matchRowNumbers = (await this.readRowReferences(config, layout))
      .filter((entry) => entry.rowId === rowId)
      .map((entry) => entry.rowNumber);

    const duplicateCount = matchRowNumbers.length;
    if (duplicateCount === 0) {
      return null;
    }

    if (hintedRow && matchRowNumbers.includes(hintedRow.rowNumber)) {
      return {
        row: hintedRow,
        duplicateCount
      };
    }

    const resolvedRow = await this.readSingleRow(config, matchRowNumbers[0]!, layout);

    return {
      row: resolvedRow,
      duplicateCount
    };
  }

  async readRowReferences(
    config: GoogleSheetTableConfig,
    layout?: GoogleSheetHeaderLayout
  ): Promise<RowReference[]> {
    const resolvedLayout = layout ?? await this.readHeaderLayout(config);
    const idColumnLetter = columnNumberToA1(resolvedLayout.idColumnNumber);
    const idColumnValues = await this.readValues(
      config.spreadsheetId,
      `${escapeSheetName(config.sheetTabName)}!${idColumnLetter}${config.dataStartRow}:${idColumnLetter}`
    );

    return idColumnValues
      .map((cells, index) => ({
        rowIdValue: parseSheetCellValue(cells[0]),
        rowNumber: config.dataStartRow + index
      }))
      .map((entry) => ({
        rowId: getManagedRowId(entry.rowIdValue, config.idColumn, entry.rowNumber),
        rowNumber: entry.rowNumber
      }));
  }

  async readSingleRow(
    config: GoogleSheetTableConfig,
    rowNumber: number,
    layout?: GoogleSheetHeaderLayout
  ): Promise<RowEnvelope> {
    const resolvedLayout = layout ?? await this.readHeaderLayout(config);
    const lastColumnNumber = resolvedLayout.entries.at(-1)?.columnNumber ?? 1;
    const values = await this.readValues(
      config.spreadsheetId,
      `${escapeSheetName(config.sheetTabName)}!${buildBoundedRowRange(rowNumber, lastColumnNumber)}`
    );

    const row = values[0];
    if (!row) {
      throw new NotFoundError(`Row ${rowNumber} was not found in ${config.projectSlug}/${config.tableSlug}.`);
    }

    return buildRowEnvelope(config, resolvedLayout, rowNumber, row);
  }

  async appendRow(config: GoogleSheetTableConfig, headers: readonly string[], values: RowRecord): Promise<number> {
    const accessToken = await this.getAccessToken();
    const range = `${escapeSheetName(config.sheetTabName)}!A${config.dataStartRow}`;
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: [headers.map((header) => serializeSheetCell(values[header] ?? null))]
        })
      },
      {
        operation: `append row for ${config.projectSlug}/${config.tableSlug}`,
        maxRetries: 0
      }
    );

    const body = await this.parseJson<GoogleAppendResponse>(response);
    return parseUpdatedRangeRowNumber(body.updates?.updatedRange);
  }

  async appendRowSkeleton(
    config: GoogleSheetTableConfig,
    rowId: string,
    layout?: GoogleSheetHeaderLayout
  ): Promise<number> {
    const resolvedLayout = layout ?? await this.readHeaderLayout(config);
    const accessToken = await this.getAccessToken();
    const idColumnLetter = columnNumberToA1(resolvedLayout.idColumnNumber);
    const range = `${escapeSheetName(config.sheetTabName)}!${idColumnLetter}${config.dataStartRow}:${idColumnLetter}`;
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: [[serializeSheetCell(rowId)]]
        })
      },
      {
        operation: `append row skeleton for ${config.projectSlug}/${config.tableSlug}`,
        maxRetries: 0
      }
    );

    const body = await this.parseJson<GoogleAppendResponse>(response);
    return parseUpdatedRangeRowNumber(body.updates?.updatedRange);
  }

  async writeRow(config: GoogleSheetTableConfig, rowNumber: number, headers: readonly string[], values: RowRecord): Promise<void> {
    const accessToken = await this.getAccessToken();
    const endColumn = columnNumberToA1(headers.length);
    const range = `${escapeSheetName(config.sheetTabName)}!A${rowNumber}:${endColumn}${rowNumber}`;
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: [headers.map((header) => serializeSheetCell(values[header] ?? null))]
        })
      },
      {
        operation: `write row for ${config.projectSlug}/${config.tableSlug}`,
        maxRetries: 0
      }
    );

    await this.parseJson(response);
  }

  async writeRowPatch(
    config: GoogleSheetTableConfig,
    rowNumber: number,
    values: Partial<RowRecord>,
    layout?: GoogleSheetHeaderLayout
  ): Promise<void> {
    const resolvedLayout = layout ?? await this.readHeaderLayout(config);
    const segments = buildColumnValueSegments(resolvedLayout, values);
    if (segments.length === 0) {
      return;
    }

    const accessToken = await this.getAccessToken();
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: segments.map((segment) => {
            const startColumn = columnNumberToA1(segment.startColumnNumber);
            const endColumn = columnNumberToA1(segment.startColumnNumber + segment.values.length - 1);
            return {
              range: `${escapeSheetName(config.sheetTabName)}!${startColumn}${rowNumber}:${endColumn}${rowNumber}`,
              values: [segment.values]
            };
          })
        })
      },
      {
        operation: `patch row for ${config.projectSlug}/${config.tableSlug}`,
        maxRetries: 0
      }
    );

    await this.parseJson<GoogleBatchValuesUpdateResponse>(response);
  }

  async writeRowsBatch(
    config: GoogleSheetTableConfig,
    headers: readonly string[],
    rows: readonly RowRecord[],
    startRowNumber: number
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    const accessToken = await this.getAccessToken();
    const endColumn = columnNumberToA1(headers.length);
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: rows.map((row, index) => ({
            range: `${escapeSheetName(config.sheetTabName)}!A${startRowNumber + index}:${endColumn}${startRowNumber + index}`,
            values: [headers.map((header) => serializeSheetCell(row[header] ?? null))]
          }))
        })
      },
      {
        operation: `batch write rows for ${config.projectSlug}/${config.tableSlug}`,
        maxRetries: 0
      }
    );

    const body = await this.parseJson<GoogleBatchValuesUpdateResponse>(response);
    return body.totalUpdatedRows ?? rows.length;
  }

  async clearRowsRange(
    config: GoogleSheetTableConfig,
    startRowNumber: number,
    endRowNumber: number,
    lastColumnNumber?: number
  ): Promise<void> {
    if (endRowNumber < startRowNumber) {
      return;
    }

    const accessToken = await this.getAccessToken();
    const range = `${escapeSheetName(config.sheetTabName)}!${buildBoundedRowSpanRange(startRowNumber, endRowNumber, lastColumnNumber ?? 1)}`;
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({})
      },
      {
        operation: `clear rows for ${config.projectSlug}/${config.tableSlug}`,
        maxRetries: 0
      }
    );

    await this.parseJson<GoogleClearValuesResponse>(response);
  }

  async deleteRow(config: GoogleSheetTableConfig, rowNumber: number): Promise<void> {
    const accessToken = await this.getAccessToken();
    const sheetId = config.sheetGid ?? (await this.lookupSheetId(config.spreadsheetId, config.sheetTabName));
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: rowNumber - 1,
                  endIndex: rowNumber
                }
              }
            }
          ]
        })
      },
      {
        operation: `delete row for ${config.projectSlug}/${config.tableSlug}`,
        maxRetries: 0
      }
    );

    await this.parseJson(response);
  }

  async watchSpreadsheetFile(spreadsheetId: string, request: GoogleDriveWatchRequest): Promise<GoogleDriveWatch> {
    const accessToken = await this.getAccessToken();
    const channelId = crypto.randomUUID();
    const response = await this.authorizedRequest(
      `${this.driveApiBaseUrl}/files/${encodeURIComponent(spreadsheetId)}/watch?supportsAllDrives=true`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          id: channelId,
          type: 'web_hook',
          address: request.webhookUrl,
          token: request.token,
          ...(request.expirationMs ? { expiration: String(request.expirationMs) } : {})
        })
      },
      {
        operation: `watch spreadsheet file ${spreadsheetId}`,
        maxRetries: 0
      }
    );

    const body = await this.parseJson<GoogleDriveChannelResponse>(response);
    if (!body.id || !body.resourceId) {
      throw new ServiceUnavailableError('Google Drive watch response did not include a channel id and resource id.', {
        spreadsheetId
      });
    }

    return {
      channelId: body.id,
      resourceId: body.resourceId,
      resourceUri: body.resourceUri ?? null,
      expirationAt: body.expiration ? new Date(Number(body.expiration)).toISOString() : null
    };
  }

  async stopDriveChannel(channelId: string, resourceId: string): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await this.authorizedRequest(
      `${this.driveApiBaseUrl}/channels/stop`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          id: channelId,
          resourceId
        })
      },
      {
        operation: `stop drive channel ${channelId}`,
        maxRetries: 0
      }
    );

    await this.parseJson(response);
  }

  private async readValues(spreadsheetId: string, range: string): Promise<GoogleCellValue[][]> {
    const accessToken = await this.getAccessToken();
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      },
      {
        operation: `read values for range ${range}`,
        maxRetries: defaultRetryCount
      }
    );

    const body = await this.parseJson<GoogleValuesResponse>(response);
    return body.values ?? [];
  }

  private async lookupSheetId(spreadsheetId: string, sheetTabName: string): Promise<number> {
    const metadata = await this.readSpreadsheetMetadata(spreadsheetId);
    const match = metadata.sheets?.find((sheet) => sheet.properties?.title === sheetTabName)?.properties?.sheetId;

    if (match === undefined) {
      throw new NotFoundError(`Sheet tab ${sheetTabName} was not found in spreadsheet ${spreadsheetId}.`);
    }

    return match;
  }

  private async readSpreadsheetMetadata(spreadsheetId: string): Promise<GoogleSpreadsheetMetadataResponse> {
    const accessToken = await this.getAccessToken();
    const response = await this.authorizedRequest(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title,sheetType)`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      },
      {
        operation: `read spreadsheet metadata for ${spreadsheetId}`,
        maxRetries: defaultRetryCount
      }
    );

    return this.parseJson<GoogleSpreadsheetMetadataResponse>(response);
  }

  private async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.tokenCache && this.tokenCache.expiresAtMs > now + 30_000) {
      return this.tokenCache.value;
    }

    const assertion = await this.createJwtAssertion(now);
    const response = await this.requestWithRetry(
      this.oauthTokenUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion
        })
      },
      {
        operation: 'fetch Google OAuth access token',
        maxRetries: defaultRetryCount
      }
    );

    const body = await this.parseJson<GoogleTokenResponse>(response);
    this.tokenCache = {
      value: body.access_token,
      expiresAtMs: now + body.expires_in * 1000
    };

    return body.access_token;
  }

  private async createJwtAssertion(nowMs: number): Promise<string> {
    const issuedAt = Math.floor(nowMs / 1000);
    const expiresAt = issuedAt + 3600;
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64UrlEncode(
      JSON.stringify({
        iss: this.config.clientEmail,
        scope: googleApiScopes,
        aud: this.oauthTokenUrl,
        exp: expiresAt,
        iat: issuedAt
      })
    );

    const signingInput = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(this.config.privateKey.replace(/\\n/g, '\n')),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256'
      },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput)
    );

    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  private async authorizedRequest(
    input: string,
    init: RequestInit,
    options: { operation: string; maxRetries: number }
  ): Promise<Response> {
    let hasRetriedForAuth = false;
    let currentInit = init;

    while (true) {
      const response = await this.requestWithRetry(input, currentInit, options);
      if (response.status !== 401 || hasRetriedForAuth) {
        return response;
      }

      this.tokenCache = null;
      hasRetriedForAuth = true;
      const nextToken = await this.getAccessToken();
      currentInit = {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${nextToken}`
        }
      };
    }
  }

  private async requestWithRetry(
    input: string,
    init: RequestInit,
    options: { operation: string; maxRetries: number }
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(input, init);
      } catch (error) {
        if (attempt >= options.maxRetries) {
          throw this.toTransportError(error, options.operation);
        }

        await this.delay(this.getRetryDelayMs(attempt));
        continue;
      }

      if (!this.isRetryableStatus(response.status) || attempt >= options.maxRetries) {
        return response;
      }

      await this.delay(this.getRetryDelayMs(attempt));
    }
  }

  private async fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), defaultRequestTimeoutMs);

    try {
      return await this.fetchImpl(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ServiceUnavailableError('Google Sheets request timed out.');
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isRetryableStatus(status: number) {
    return status === 429 || status >= 500;
  }

  private toTransportError(error: unknown, operation: string) {
    if (error instanceof ServiceUnavailableError) {
      return error;
    }

    const message = error instanceof Error ? error.message : 'Unknown transport error';
    return new ServiceUnavailableError(`Google Sheets network request failed during ${operation}.`, {
      operation,
      message
    });
  }

  private getRetryDelayMs(attempt: number) {
    return 250 * 2 ** attempt;
  }

  private getGoogleErrorMessage(bodyText: string) {
    try {
      const body = JSON.parse(bodyText) as {
        error?: {
          message?: string;
          status?: string;
        };
      };

      return body.error?.message ?? body.error?.status ?? bodyText;
    } catch {
      return bodyText;
    }
  }

  private async parseJson<T = unknown>(response: Response): Promise<T> {
    if (!response.ok) {
      const bodyText = await response.text();
      const message = this.getGoogleErrorMessage(bodyText);

      if (response.status === 401 || response.status === 403) {
        throw new BadGatewayError('Google Sheets authentication or permission check failed.', {
          status: response.status,
          message
        });
      }

      if (response.status === 404) {
        throw new NotFoundError('Google Sheets resource was not found.', {
          status: response.status,
          message
        });
      }

      if (response.status === 429) {
        throw new TooManyRequestsError('Google Sheets API quota was exceeded.', {
          status: response.status,
          message
        });
      }

      if (response.status >= 500) {
        throw new ServiceUnavailableError('Google Sheets API is temporarily unavailable.', {
          status: response.status,
          message
        });
      }

      throw new BadRequestError(`Google Sheets API request failed with ${response.status}.`, {
        status: response.status,
        message
      });
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}
