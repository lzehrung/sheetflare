import type {
  AdminCreateApiKeyResult,
  AdminGetProjectResult,
  AdminListProjectsResult,
  CreateProjectInput,
  CreateTableInput,
  GetTableCacheStatusResult,
  ReindexTableResult
} from '@sheetflare/contracts';
import { buildAdminHeaders } from './auth';

type ApiErrorResponse = {
  error?: {
    message?: string;
  };
};

async function requestAdminJson<T>(
  credential: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = {
    ...buildAdminHeaders(credential),
    ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {})
  };
  const response = await fetch(path, {
    ...init,
    headers
  });

  if (response.status === 401) {
    throw new Error('The configured admin credential was rejected.');
  }

  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) as T | ApiErrorResponse : null;

  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error?.message
      ? parsed.error.message
      : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

export function listProjects(credential: string) {
  return requestAdminJson<AdminListProjectsResult>(credential, '/v1/admin/projects');
}

export function getProject(credential: string, projectSlug: string) {
  return requestAdminJson<AdminGetProjectResult>(
    credential,
    `/v1/admin/projects?project=${encodeURIComponent(projectSlug)}`
  );
}

export function createProject(credential: string, input: CreateProjectInput) {
  return requestAdminJson<AdminGetProjectResult>(credential, '/v1/admin/projects', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function createTable(credential: string, projectSlug: string, input: CreateTableInput) {
  return requestAdminJson<{ data: CreateTableInput & { projectSlug: string } }>(
    credential,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables`,
    {
      method: 'POST',
      body: JSON.stringify(input)
    }
  );
}

export function createApiKey(
  credential: string,
  input: {
    name: string;
    projectSlug?: string | null;
    scopes: string[];
  }
) {
  return requestAdminJson<AdminCreateApiKeyResult>(credential, '/v1/admin/keys', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function getCacheStatus(credential: string, projectSlug: string, tableSlug: string) {
  return requestAdminJson<GetTableCacheStatusResult>(
    credential,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/cache`
  );
}

export function reindexTable(credential: string, projectSlug: string, tableSlug: string) {
  return requestAdminJson<ReindexTableResult>(
    credential,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/reindex`,
    {
      method: 'POST'
    }
  );
}
