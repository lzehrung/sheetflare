import type {
  ApiKeyPrincipal,
  ApiScope,
  ProjectConfig,
  ProjectSummary,
  TableCacheStatus,
  TableConfig
} from '@sheetflare/contracts';

export function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req-ui'
    }
  });
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value) {
      if (!resolvePromise) {
        throw new Error('Deferred promise resolver was not initialized.');
      }

      resolvePromise(value);
    }
  };
}

const timestamp = '2026-04-26T00:00:00.000Z';

export function createProjectConfig(slug: string, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    spreadsheetId: `sheet-${slug}`,
    googleCredentialRef: 'default',
    defaultAuthMode: 'private',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

export function createProjectSummary(slug: string, tableCount = 0): ProjectSummary {
  const project = createProjectConfig(slug);
  return {
    slug,
    name: project.name,
    spreadsheetId: project.spreadsheetId,
    googleCredentialRef: project.googleCredentialRef,
    tableCount,
    updatedAt: project.updatedAt
  };
}

export function createTableConfig(projectSlug: string, tableSlug: string): TableConfig {
  return {
    projectSlug,
    tableSlug,
    sheetTabName: tableSlug,
    idColumn: '_id',
    indexedFields: ['_id'],
    readOnlyFields: [],
    fieldRules: {},
    headerRow: 1,
    dataStartRow: 2,
    readEnabled: true,
    createEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    cacheTtlSeconds: 15,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createCacheStatus(): TableCacheStatus {
  return {
    status: 'ready',
    cacheTtlSeconds: 15,
    stale: false,
    staleReason: 'fresh',
    rowCount: 3,
    lastSyncStartedAt: timestamp,
    lastSyncCompletedAt: timestamp,
    dataGeneration: 0,
    lastSyncError: null,
    validation: {
      status: 'ok',
      issueCount: 0,
      issues: [],
      validatedAt: timestamp
    },
    externalChange: {
      pending: false,
      lastChangedAt: null,
      debounceUntil: null,
      lastAutoReindexAt: null
    }
  };
}

export function createApiKeyPrincipal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
  return {
    id: 'key-1',
    projectSlug: 'demo',
    name: 'Demo key',
    scopes: ['table:read'],
    createdAt: timestamp,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides
  };
}

export function createWorkerError(status: number, code: string, message: string) {
  return createJsonResponse({ error: { code, message, details: null } }, status);
}

type FakeWorkerKey = {
  credential: string;
  projectSlug: string | null;
  scopes: ApiScope[];
};

type FakeWorkerOptions = {
  keys: FakeWorkerKey[];
  projects: ProjectConfig[];
  tablesByProject?: Record<string, TableConfig[]>;
};

type FakeWorkerPrincipal =
  | { kind: 'anonymous' }
  | { kind: 'api-key'; key: FakeWorkerKey };

/**
 * An HTTP-level stand-in for the Worker's admin routes that reproduces the real authorization rules from
 * apps/api/src/index.ts (authenticateRequest, assertAdminScope, assertGlobalAdminScope, assertProjectScope)
 * and its exact 401 messages, so UI tests exercise real scope behavior instead of canned responses.
 */
export function createFakeWorker(options: FakeWorkerOptions) {
  const requests: string[] = [];

  function authenticate(init: RequestInit | undefined): FakeWorkerPrincipal | Response {
    const authorization = new Headers(init?.headers).get('authorization');
    if (!authorization) {
      return { kind: 'anonymous' };
    }

    const credential = authorization.slice('Bearer '.length).trim();
    const key = options.keys.find((candidate) => candidate.credential === credential);
    if (!key) {
      return createWorkerError(401, 'UNAUTHORIZED', 'Invalid API key.');
    }

    return { kind: 'api-key', key };
  }

  function unauthorized(message = 'Unauthorized') {
    return createWorkerError(401, 'UNAUTHORIZED', message);
  }

  function assertScope(principal: FakeWorkerPrincipal, scope: ApiScope): Response | null {
    if (principal.kind !== 'api-key' || !principal.key.scopes.includes(scope)) {
      return unauthorized();
    }

    return null;
  }

  function assertGlobalScope(principal: FakeWorkerPrincipal, scope: ApiScope): Response | null {
    const denied = assertScope(principal, scope);
    if (denied) {
      return denied;
    }

    if (principal.kind === 'api-key' && principal.key.projectSlug) {
      return unauthorized('This operation requires a global admin key.');
    }

    return null;
  }

  function assertProjectScope(principal: FakeWorkerPrincipal, scope: ApiScope, projectSlug: string): Response | null {
    const denied = assertScope(principal, scope);
    if (denied) {
      return denied;
    }

    if (principal.kind === 'api-key' && principal.key.projectSlug && principal.key.projectSlug !== projectSlug) {
      return unauthorized();
    }

    return null;
  }

  async function fetchWorker(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'http://worker.test');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/__sheetflare/admin-session') {
      return createJsonResponse({ serverCredential: false });
    }

    requests.push(`${method} ${url.pathname}${url.search}`);

    const principal = authenticate(init);
    if (principal instanceof Response) {
      return principal;
    }

    if (url.pathname === '/v1/admin/projects' && method === 'GET') {
      const projectSlug = url.searchParams.get('project');
      if (projectSlug) {
        const denied = assertProjectScope(principal, 'admin:projects', projectSlug);
        const project = options.projects.find((candidate) => candidate.slug === projectSlug);
        if (denied) {
          return denied;
        }
        if (!project) {
          return createWorkerError(404, 'NOT_FOUND', `Project ${projectSlug} was not found.`);
        }

        return createJsonResponse({ project, tables: options.tablesByProject?.[projectSlug] ?? [] });
      }

      const denied = assertGlobalScope(principal, 'admin:projects');
      if (denied) {
        return denied;
      }

      return createJsonResponse({
        data: options.projects.map((project) =>
          createProjectSummary(project.slug, options.tablesByProject?.[project.slug]?.length ?? 0)
        )
      });
    }

    if (url.pathname === '/v1/admin/keys' && method === 'GET') {
      const denied = assertScope(principal, 'admin:keys');
      if (denied) {
        return denied;
      }

      return createJsonResponse({ data: [] });
    }

    if (url.pathname === '/v1/admin/system/google/drive/watches' && method === 'GET') {
      const denied = assertGlobalScope(principal, 'admin:projects');
      if (denied) {
        return denied;
      }

      return createJsonResponse({ data: [] });
    }

    const cacheMatch = /^\/v1\/admin\/projects\/([^/]+)\/tables\/([^/]+)\/cache$/.exec(url.pathname);
    if (cacheMatch?.[1] && method === 'GET') {
      const denied = assertProjectScope(principal, 'admin:projects', cacheMatch[1]);
      if (denied) {
        return denied;
      }

      return createJsonResponse({ data: createCacheStatus() });
    }

    return createWorkerError(404, 'NOT_FOUND', `Unexpected request: ${method} ${url.pathname}`);
  }

  return { fetch: fetchWorker, requests };
}
