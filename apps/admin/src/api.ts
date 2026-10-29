import {
  adminSessionPath,
  adminCreateApiKeyResultSchema,
  adminGetProjectResultSchema,
  adminInspectSpreadsheetTabResultSchema,
  adminListApiKeysResultSchema,
  adminListProjectsResultSchema,
  adminListSpreadsheetTabsResultSchema,
  adminListSpreadsheetWatchesResultSchema,
  deleteProjectResultSchema,
  deleteTableResultSchema,
  getTableCacheStatusResultSchema,
  refreshTableCacheResultSchema,
  reindexTableResultSchema,
  upsertTableResultSchema,
  type AdminSessionResponse,
  type ApiKeyPrincipal,
  type CreateProjectInput,
  type CreateTableInput
} from '@sheetflare/contracts';
import { buildAdminHeaders, type AdminAccess } from './auth';

type SchemaIssue = { path: readonly PropertyKey[]; message: string };

// Structural subset of a Zod schema: the admin app only needs to validate and read the parsed result.
type ResultSchema<T> = {
  safeParse(
    input: unknown
  ): { success: true; data: T } | { success: false; error: { issues: readonly SchemaIssue[] } };
};

export type AdminAuthFailure = 'invalid-credential' | 'insufficient-scope';

/** A non-2xx Worker response. Carries the HTTP status and the contract error code so callers never parse messages. */
export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(message: string, status: number, code: string | null, requestId: string | null) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** A 2xx Worker response whose JSON does not match the exported contract schema (for example version skew). */
export class AdminResponseShapeError extends Error {
  readonly requestId: string | null;

  constructor(message: string, requestId: string | null) {
    super(message);
    this.name = 'AdminResponseShapeError';
    this.requestId = requestId;
  }
}

// Missing or invalid credentials are 401. A valid key that lacks the required scope is 403 FORBIDDEN.
export function classifyAuthFailure(error: unknown): AdminAuthFailure | null {
  if (!(error instanceof AdminApiError)) {
    return null;
  }

  if (error.status === 403 && error.code === 'FORBIDDEN') {
    return 'insufficient-scope';
  }

  if (error.status === 401) {
    return 'invalid-credential';
  }

  return null;
}

function summarizeBody(text: string) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}

function parseJsonResponse(text: string) {
  if (text.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getApiErrorField(parsed: unknown, field: 'code' | 'message') {
  if (!isRecord(parsed) || !isRecord(parsed.error)) {
    return null;
  }

  const value = parsed.error[field];
  return typeof value === 'string' ? value : null;
}

function formatRequestError(response: Response, errorMessage: string | null, text: string) {
  const requestId = response.headers.get('x-request-id');
  const parts = [
    errorMessage ?? `Request failed: ${response.status}`,
    requestId ? `requestId=${requestId}` : null
  ];

  if (!errorMessage && text.trim().length > 0) {
    parts.push(`body=${summarizeBody(text)}`);
  }

  return parts.filter(Boolean).join(' ');
}

function formatShapeError(path: string, issues: readonly SchemaIssue[], requestId: string | null) {
  const firstIssue = issues[0];
  const location = firstIssue && firstIssue.path.length > 0 ? firstIssue.path.map(String).join('.') : 'response';
  return [
    `The Worker returned an unexpected response for ${path} (${location}: ${firstIssue?.message ?? 'does not match the contract'}).`,
    'The admin UI and the Worker may be on different versions.',
    requestId ? `requestId=${requestId}` : null
  ].filter(Boolean).join(' ');
}

async function requestAdminJson<T>(
  access: AdminAccess,
  path: string,
  schema: ResultSchema<T>,
  init?: RequestInit
): Promise<T> {
  const headers = {
    ...buildAdminHeaders(access),
    ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {})
  };
  const response = await fetch(path, {
    ...init,
    headers
  });

  const text = await response.text();
  const parsed = parseJsonResponse(text);
  const requestId = response.headers.get('x-request-id');

  if (!response.ok) {
    const errorMessage = getApiErrorField(parsed, 'message');
    const errorCode = getApiErrorField(parsed, 'code');
    if (response.status === 401 && errorMessage === null) {
      throw new AdminApiError('The configured admin credential was rejected.', 401, errorCode, requestId);
    }

    throw new AdminApiError(
      formatRequestError(response, errorMessage, text),
      response.status,
      errorCode,
      requestId
    );
  }

  if (parsed === null) {
    throw new AdminResponseShapeError(
      [
        'Request returned an invalid JSON response.',
        requestId ? `requestId=${requestId}` : null,
        text.trim().length > 0 ? `body=${summarizeBody(text)}` : null
      ].filter(Boolean).join(' '),
      requestId
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AdminResponseShapeError(formatShapeError(path, result.error.issues, requestId), requestId);
  }

  return result.data;
}

function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal ? { signal } : {};
}

function isOkResult(input: unknown): input is { ok: true } {
  return isRecord(input) && input.ok === true;
}

const okResultSchema: ResultSchema<{ ok: true }> = {
  safeParse(input) {
    if (isOkResult(input)) {
      return { success: true, data: { ok: true } };
    }

    return { success: false, error: { issues: [{ path: ['ok'], message: 'Expected ok: true.' }] } };
  }
};

export async function getAdminSession(): Promise<AdminSessionResponse> {
  const response = await fetch(adminSessionPath, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Local admin session lookup failed: ${response.status}`);
  }

  const parsed = parseJsonResponse(await response.text());
  if (
    !parsed
    || typeof parsed !== 'object'
    || !('serverCredential' in parsed)
    || typeof parsed.serverCredential !== 'boolean'
  ) {
    throw new Error('Local admin session lookup returned an invalid response.');
  }

  return { serverCredential: parsed.serverCredential };
}

export function listProjects(access: AdminAccess, signal?: AbortSignal) {
  return requestAdminJson(access, '/v1/admin/projects', adminListProjectsResultSchema, signalInit(signal));
}

export function getProject(access: AdminAccess, projectSlug: string, signal?: AbortSignal) {
  return requestAdminJson(
    access,
    `/v1/admin/projects?project=${encodeURIComponent(projectSlug)}`,
    adminGetProjectResultSchema,
    signalInit(signal)
  );
}

export function createProject(access: AdminAccess, input: CreateProjectInput) {
  return requestAdminJson(access, '/v1/admin/projects', adminGetProjectResultSchema, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function deleteProject(access: AdminAccess, projectSlug: string) {
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}`,
    deleteProjectResultSchema,
    { method: 'DELETE' }
  );
}

export function listSpreadsheetTabs(access: AdminAccess, projectSlug: string) {
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/spreadsheet/tabs`,
    adminListSpreadsheetTabsResultSchema
  );
}

export function listSpreadsheetWatches(access: AdminAccess) {
  return requestAdminJson(
    access,
    '/v1/admin/system/google/drive/watches',
    adminListSpreadsheetWatchesResultSchema
  );
}

export function inspectSpreadsheetTab(
  access: AdminAccess,
  projectSlug: string,
  tabName: string,
  headerRow?: number
) {
  const query = headerRow !== undefined ? `?headerRow=${encodeURIComponent(String(headerRow))}` : '';
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/spreadsheet/tabs/${encodeURIComponent(tabName)}${query}`,
    adminInspectSpreadsheetTabResultSchema
  );
}

export function createTable(access: AdminAccess, projectSlug: string, input: CreateTableInput) {
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables`,
    upsertTableResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(input)
    }
  );
}

export function deleteTable(access: AdminAccess, projectSlug: string, tableSlug: string) {
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}`,
    deleteTableResultSchema,
    { method: 'DELETE' }
  );
}

export function createApiKey(
  access: AdminAccess,
  input: {
    name: string;
    projectSlug?: string | null;
    scopes: string[];
  }
) {
  return requestAdminJson(access, '/v1/admin/keys', adminCreateApiKeyResultSchema, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function listApiKeys(access: AdminAccess, projectSlug?: string | null) {
  const query = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : '';
  return requestAdminJson(access, `/v1/admin/keys${query}`, adminListApiKeysResultSchema);
}

export function revokeApiKey(access: AdminAccess, apiKeyId: ApiKeyPrincipal['id']) {
  return requestAdminJson(
    access,
    `/v1/admin/keys/${encodeURIComponent(apiKeyId)}`,
    okResultSchema,
    { method: 'DELETE' }
  );
}

export function getCacheStatus(
  access: AdminAccess,
  projectSlug: string,
  tableSlug: string,
  signal?: AbortSignal
) {
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/cache`,
    getTableCacheStatusResultSchema,
    signalInit(signal)
  );
}

export function refreshTableCache(access: AdminAccess, projectSlug: string, tableSlug: string) {
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/refresh`,
    refreshTableCacheResultSchema,
    { method: 'POST' }
  );
}

export function reindexTable(access: AdminAccess, projectSlug: string, tableSlug: string) {
  return requestAdminJson(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/reindex`,
    reindexTableResultSchema,
    { method: 'POST' }
  );
}
