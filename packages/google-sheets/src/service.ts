import { BadRequestError, NotFoundError, type RowEnvelope, type RowRecord, type TableConfig } from '@sheetflare/contracts';

const googleSheetsScope = 'https://www.googleapis.com/auth/spreadsheets';
const defaultOauthTokenUrl = 'https://oauth2.googleapis.com/token';
const defaultSheetsApiBaseUrl = 'https://sheets.googleapis.com/v4/spreadsheets';

type FetchLike = typeof fetch;

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
};

type GoogleValuesResponse = {
  values?: string[][];
};

type GoogleAppendResponse = {
  updates?: {
    updatedRange?: string;
  };
};

type GoogleSpreadsheetMetadataResponse = {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
    };
  }>;
};

export type GoogleSheetTableConfig = TableConfig & {
  spreadsheetId: string;
};

export interface RowLookupResult {
  row: RowEnvelope;
  duplicateCount: number;
}

export interface GoogleServiceAccountConfig {
  clientEmail: string;
  privateKey: string;
  fetch?: FetchLike;
  oauthTokenUrl?: string;
  sheetsApiBaseUrl?: string;
  now?: () => number;
}

export function serializeSheetCell(value: RowRecord[string]): string | number | boolean {
  if (value === null) return '';
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

export function parseSheetCellValue(value: string | undefined): RowRecord[string] {
  if (value === undefined || value === '') return null;
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);

  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))
    ) {
      return parsed as string[] | number[] | boolean[];
    }
  } catch {
    return value;
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

function buildRowEnvelope(config: GoogleSheetTableConfig, headers: readonly string[], rowNumber: number, cells: readonly string[]): RowEnvelope {
  const values: RowRecord = {};

  for (const [index, header] of headers.entries()) {
    values[header] = parseSheetCellValue(cells[index]);
  }

  const rawId = values[config.idColumn];
  return {
    id: rawId === null || rawId === undefined ? String(rowNumber) : String(rawId),
    rowNumber,
    values
  };
}

export class GoogleSheetsService {
  private readonly fetchImpl: FetchLike;
  private readonly oauthTokenUrl: string;
  private readonly sheetsApiBaseUrl: string;
  private readonly now: () => number;
  private tokenCache: { value: string; expiresAtMs: number } | null = null;

  constructor(private readonly config: GoogleServiceAccountConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.oauthTokenUrl = config.oauthTokenUrl ?? defaultOauthTokenUrl;
    this.sheetsApiBaseUrl = config.sheetsApiBaseUrl ?? defaultSheetsApiBaseUrl;
    this.now = config.now ?? Date.now;
  }

  async readHeaders(config: GoogleSheetTableConfig): Promise<string[]> {
    const values = await this.readValues(config.spreadsheetId, `${escapeSheetName(config.sheetTabName)}!${config.headerRow}:${config.headerRow}`);
    const headers = (values[0] ?? [])
      .map((header) => header.trim())
      .filter((header) => header.length > 0);

    if (headers.length === 0) {
      throw new NotFoundError(`No headers found for table ${config.projectSlug}/${config.tableSlug}.`);
    }

    return headers;
  }

  async readAllRows(config: GoogleSheetTableConfig): Promise<RowEnvelope[]> {
    const range = `${escapeSheetName(config.sheetTabName)}`;
    const values = await this.readValues(config.spreadsheetId, range);
    const headers = (values[0] ?? []).map((header) => header.trim()).filter(Boolean);
    if (headers.length === 0) return [];

    const rowOffset = Math.max(config.dataStartRow - config.headerRow - 1, 0);
    const rows = values.slice(1 + rowOffset);

    return rows
      .map((cells, index) => buildRowEnvelope(config, headers, config.dataStartRow + index, cells))
      .filter((row) => Object.values(row.values).some((value) => value !== null));
  }

  async findRowById(
    config: GoogleSheetTableConfig,
    rowId: string,
    rowNumberHint?: number | null
  ): Promise<RowLookupResult | null> {
    if (rowNumberHint) {
      const hintedRow = await this.readSingleRow(config, rowNumberHint).catch(() => null);
      if (hintedRow && String(hintedRow.values[config.idColumn] ?? '') === rowId) {
        return {
          row: hintedRow,
          duplicateCount: 1
        };
      }
    }

    const rows = await this.readAllRows(config);
    const matches = rows.filter((row) => String(row.values[config.idColumn] ?? '') === rowId);
    if (matches.length === 0) {
      return null;
    }

    return {
      row: matches[0]!,
      duplicateCount: matches.length
    };
  }

  async readSingleRow(config: GoogleSheetTableConfig, rowNumber: number): Promise<RowEnvelope> {
    const [headers, values] = await Promise.all([
      this.readHeaders(config),
      this.readValues(config.spreadsheetId, `${escapeSheetName(config.sheetTabName)}!${rowNumber}:${rowNumber}`)
    ]);

    const row = values[0];
    if (!row) {
      throw new NotFoundError(`Row ${rowNumber} was not found in ${config.projectSlug}/${config.tableSlug}.`);
    }

    return buildRowEnvelope(config, headers, rowNumber, row);
  }

  async appendRow(config: GoogleSheetTableConfig, headers: readonly string[], values: RowRecord): Promise<number> {
    const accessToken = await this.getAccessToken();
    const range = `${escapeSheetName(config.sheetTabName)}!A${config.dataStartRow}`;
    const response = await this.fetchImpl(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: [headers.map((header) => serializeSheetCell(values[header] ?? null))]
        })
      }
    );

    const body = await this.parseJson<GoogleAppendResponse>(response);
    return parseUpdatedRangeRowNumber(body.updates?.updatedRange);
  }

  async writeRow(config: GoogleSheetTableConfig, rowNumber: number, headers: readonly string[], values: RowRecord): Promise<void> {
    const accessToken = await this.getAccessToken();
    const endColumn = columnNumberToA1(headers.length);
    const range = `${escapeSheetName(config.sheetTabName)}!A${rowNumber}:${endColumn}${rowNumber}`;
    const response = await this.fetchImpl(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: [headers.map((header) => serializeSheetCell(values[header] ?? null))]
        })
      }
    );

    await this.parseJson(response);
  }

  async deleteRow(config: GoogleSheetTableConfig, rowNumber: number): Promise<void> {
    const accessToken = await this.getAccessToken();
    const sheetId = config.sheetGid ?? (await this.lookupSheetId(config.spreadsheetId, config.sheetTabName));
    const response = await this.fetchImpl(
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
      }
    );

    await this.parseJson(response);
  }

  private async readValues(spreadsheetId: string, range: string): Promise<string[][]> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchImpl(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      }
    );

    const body = await this.parseJson<GoogleValuesResponse>(response);
    return body.values ?? [];
  }

  private async lookupSheetId(spreadsheetId: string, sheetTabName: string): Promise<number> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchImpl(
      `${this.sheetsApiBaseUrl}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      }
    );

    const body = await this.parseJson<GoogleSpreadsheetMetadataResponse>(response);
    const match = body.sheets?.find((sheet) => sheet.properties?.title === sheetTabName)?.properties?.sheetId;

    if (match === undefined) {
      throw new NotFoundError(`Sheet tab ${sheetTabName} was not found in spreadsheet ${spreadsheetId}.`);
    }

    return match;
  }

  private async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.tokenCache && this.tokenCache.expiresAtMs > now + 30_000) {
      return this.tokenCache.value;
    }

    const assertion = await this.createJwtAssertion(now);
    const response = await this.fetchImpl(this.oauthTokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

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
        scope: googleSheetsScope,
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

  private async parseJson<T = unknown>(response: Response): Promise<T> {
    if (!response.ok) {
      const bodyText = await response.text();
      throw new BadRequestError(`Google Sheets API request failed with ${response.status}.`, bodyText);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}
