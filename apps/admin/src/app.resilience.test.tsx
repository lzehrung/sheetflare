// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './app';
import {
  createApiKeyPrincipal,
  createCacheStatus,
  createDeferred,
  createFakeWorker,
  createJsonResponse,
  createProjectConfig,
  createProjectSummary,
  createTableConfig,
  createWorkerError,
  type Deferred
} from './test-support';

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response;

function stubFetch(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function signIn(credential: string) {
  fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
    target: { value: credential }
  });
  fireEvent.click(screen.getByText('Save and load'));
}

function requestKey(input: RequestInfo | URL, init?: RequestInit) {
  return `${init?.method ?? 'GET'} ${String(input)}`;
}

describe('App review regressions', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('project-scoped admin keys', () => {
    function createScopedWorker() {
      return createFakeWorker({
        keys: [{ credential: 'sfk_demo.secret', projectSlug: 'demo', scopes: ['admin:projects', 'admin:keys'] }],
        projects: [createProjectConfig('demo'), createProjectConfig('prod')],
        tablesByProject: { demo: [createTableConfig('demo', 'users')] }
      });
    }

    it('offers a project slug entry and loads the project without global-only requests', async () => {
      const worker = createScopedWorker();
      stubFetch(worker.fetch);

      render(<App />);
      signIn('sfk_demo.secret');

      await screen.findByText(/not a global admin key/);
      expect(screen.getByText('Project key')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Project slug'), { target: { value: 'Demo Project' } });
      fireEvent.click(screen.getByRole('button', { name: 'Load project' }));
      expect(screen.getByText('Use lowercase letters, numbers, and single hyphens.')).toBeTruthy();
      expect(worker.requests).toEqual(['GET /v1/admin/projects']);

      fireEvent.change(screen.getByLabelText('Project slug'), { target: { value: 'demo' } });
      fireEvent.click(screen.getByRole('button', { name: 'Load project' }));

      await screen.findByTestId('project-card-demo');
      await screen.findByText('Spreadsheet watch status requires a global admin key.');
      await screen.findByText(/Global keys are only available to a global admin key/);
      await screen.findByText('Healthy 1');

      expect(worker.requests).toContain('GET /v1/admin/projects?project=demo');
      expect(worker.requests).toContain('GET /v1/admin/keys?project=demo');
      expect(worker.requests).not.toContain('GET /v1/admin/keys');
      expect(worker.requests).not.toContain('GET /v1/admin/system/google/drive/watches');
      expect(screen.queryByRole('button', { name: 'Save project' })).toBeNull();
      expect(screen.getByText('Creating projects requires a global admin key.')).toBeTruthy();
    });

    it('offers the project slug entry when the Worker answers 403 FORBIDDEN for a valid non-global key', async () => {
      stubFetch((input, init) => {
        const key = requestKey(input, init);
        if (key === 'GET /v1/admin/projects') {
          return createWorkerError(403, 'FORBIDDEN', 'This operation requires a global admin key.');
        }
        throw new Error(`Unexpected request: ${key}`);
      });

      render(<App />);
      signIn('sfk_demo.secret');

      await screen.findByLabelText('Project slug');
      expect(screen.getByText('Project key')).toBeTruthy();
    });

    it('reports a project outside the key scope without leaving the slug prompt', async () => {
      const worker = createScopedWorker();
      stubFetch(worker.fetch);

      render(<App />);
      signIn('sfk_demo.secret');
      await screen.findByLabelText('Project slug');

      fireEvent.change(screen.getByLabelText('Project slug'), { target: { value: 'prod' } });
      fireEvent.click(screen.getByRole('button', { name: 'Load project' }));

      await screen.findByRole('alert');
      expect(screen.getByRole('alert').textContent).toContain('This key is not authorized for project prod');
      expect(screen.getByLabelText('Project slug')).toBeTruthy();
      expect(screen.queryByTestId('project-card-prod')).toBeNull();
    });
  });

  describe('credential classification', () => {
    it('marks the Worker structured 401 for an invalid API key as a rejected credential', async () => {
      const worker = createFakeWorker({ keys: [], projects: [] });
      stubFetch(worker.fetch);

      render(<App />);
      signIn('sfk_unknown.secret');

      await screen.findByText(/Invalid API key\./);
      expect(screen.getByText('Rejected')).toBeTruthy();
      expect(screen.getByText(/Update the credential and try again\./)).toBeTruthy();
      expect(screen.queryByLabelText('Project slug')).toBeNull();
    });

    it('marks a missing-credential structured 401 as rejected', async () => {
      stubFetch(() => createWorkerError(401, 'UNAUTHORIZED', 'Unauthorized'));

      render(<App />);
      signIn('anything');

      await screen.findByText(/Update the credential and try again\./);
      expect(screen.getByText('Rejected')).toBeTruthy();
    });
  });

  describe('contract validation', () => {
    it('shows a recoverable error instead of unmounting when a 200 response has the wrong shape', async () => {
      let projectListCalls = 0;
      stubFetch((input, init) => {
        const key = requestKey(input, init);
        if (key === 'GET /v1/admin/projects') {
          projectListCalls += 1;
          return projectListCalls === 1 ? createJsonResponse({ data: null }) : createJsonResponse({ data: [] });
        }
        if (key === 'GET /v1/admin/keys') {
          return createJsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${key}`);
      });

      render(<App />);
      signIn('secret-token');

      await screen.findByText(/unexpected response for \/v1\/admin\/projects/);
      expect(screen.getByRole('heading', { name: 'Sheetflare Admin' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByText(/No projects yet/);
      expect(projectListCalls).toBe(2);
    });
  });

  describe('mutation followed by a failed refresh', () => {
    it('reports the committed mutation as success and offers a refresh retry', async () => {
      let created = false;
      let projectListCalls = 0;
      let postCalls = 0;
      stubFetch((input, init) => {
        const key = requestKey(input, init);
        if (key === 'GET /v1/admin/projects') {
          projectListCalls += 1;
          if (!created) {
            return createJsonResponse({ data: [] });
          }
          if (projectListCalls === 2) {
            return createWorkerError(503, 'SERVICE_UNAVAILABLE', 'Control plane unavailable.');
          }
          return createJsonResponse({ data: [createProjectSummary('reports')] });
        }
        if (key === 'POST /v1/admin/projects') {
          postCalls += 1;
          created = true;
          return createJsonResponse({ project: createProjectConfig('reports'), tables: [] }, 201);
        }
        if (key === 'GET /v1/admin/projects?project=reports') {
          return createJsonResponse({ project: createProjectConfig('reports'), tables: [] });
        }
        if (key === 'GET /v1/admin/keys' || key === 'GET /v1/admin/keys?project=reports') {
          return createJsonResponse({ data: [] });
        }
        if (key === 'GET /v1/admin/system/google/drive/watches') {
          return createJsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${key}`);
      });

      render(<App />);
      signIn('secret-token');

      await screen.findByText(/No projects yet/);
      const projectForm = within(screen.getByText('Project setup').closest('details') ?? document.body);
      fireEvent.change(projectForm.getByLabelText(/^Slug/), { target: { value: 'reports' } });
      fireEvent.change(projectForm.getByLabelText(/^Name/), { target: { value: 'Reports' } });
      fireEvent.change(projectForm.getByLabelText(/^Spreadsheet ID/), { target: { value: 'sheet-reports' } });
      fireEvent.change(projectForm.getByLabelText(/^Google Credential Ref/), { target: { value: 'default' } });
      fireEvent.click(projectForm.getByRole('button', { name: 'Save project' }));

      const warning = await screen.findByTestId('refresh-warning');
      expect(warning.textContent).toContain('Saving project reports succeeded');
      expect(warning.textContent).toContain('Control plane unavailable.');
      expect(screen.getByText('Saving project reports complete.')).toBeTruthy();
      expect(screen.getByTestId('project-card-reports')).toBeTruthy();
      expect(postCalls).toBe(1);

      fireEvent.click(within(warning).getByRole('button', { name: 'Retry refresh' }));
      await waitFor(() => expect(screen.queryByTestId('refresh-warning')).toBeNull());
      expect(screen.getByText('Refresh complete.')).toBeTruthy();
      expect(postCalls).toBe(1);
    });
  });

  describe('API key revocation', () => {
    function stubKeyFetch(onDelete: () => void) {
      return stubFetch((input, init) => {
        const key = requestKey(input, init);
        if (key === 'GET /v1/admin/projects') {
          return createJsonResponse({ data: [createProjectSummary('demo')] });
        }
        if (key === 'GET /v1/admin/projects?project=demo') {
          return createJsonResponse({ project: createProjectConfig('demo'), tables: [] });
        }
        if (key === 'GET /v1/admin/keys?project=demo') {
          return createJsonResponse({
            data: [createApiKeyPrincipal({ id: 'key-ops', name: 'Ops key' })]
          });
        }
        if (key === 'GET /v1/admin/keys' || key === 'GET /v1/admin/system/google/drive/watches') {
          return createJsonResponse({ data: [] });
        }
        if (key === 'DELETE /v1/admin/keys/key-ops') {
          onDelete();
          return createJsonResponse({ ok: true });
        }
        throw new Error(`Unexpected request: ${key}`);
      });
    }

    it('sends no DELETE when the confirmation is cancelled', async () => {
      const onDelete = vi.fn();
      const fetchMock = stubKeyFetch(onDelete);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      render(<App />);
      signIn('secret-token');
      await screen.findByText('Ops key');

      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('"Ops key" (key-ops)'));
      expect(onDelete).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('names the key and sends exactly one DELETE once confirmed', async () => {
      const onDelete = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      stubKeyFetch(onDelete);

      render(<App />);
      signIn('secret-token');
      await screen.findByText('Ops key');

      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

      await screen.findByText('Revoking key key-ops complete.');
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Ops key'));
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('key-ops'));
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe('new API key scopes', () => {
    it('preselects no admin scopes, describes every scope, and flags destructive ones', async () => {
      let createdScopes: string[] | null = null;
      stubFetch((input, init) => {
        const key = requestKey(input, init);
        if (key === 'GET /v1/admin/projects') {
          return createJsonResponse({ data: [createProjectSummary('demo')] });
        }
        if (key === 'GET /v1/admin/projects?project=demo') {
          return createJsonResponse({ project: createProjectConfig('demo'), tables: [] });
        }
        if (key === 'GET /v1/admin/keys' || key === 'GET /v1/admin/keys?project=demo') {
          return createJsonResponse({ data: [] });
        }
        if (key === 'GET /v1/admin/system/google/drive/watches') {
          return createJsonResponse({ data: [] });
        }
        if (key === 'POST /v1/admin/keys') {
          const body: unknown = JSON.parse(String(init?.body));
          createdScopes = typeof body === 'object' && body !== null && 'scopes' in body && Array.isArray(body.scopes)
            ? body.scopes.map(String)
            : null;
          return createJsonResponse({
            apiKey: 'sfk_new.secret',
            record: createApiKeyPrincipal({ id: 'new', name: 'ops-key' })
          }, 201);
        }
        throw new Error(`Unexpected request: ${key}`);
      });

      render(<App />);
      signIn('secret-token');
      await screen.findByText('Demo');

      const checkboxFor = (scope: string) => {
        const checkbox = screen.getByRole('checkbox', { name: new RegExp(`^${scope}`) });
        if (!(checkbox instanceof HTMLInputElement)) {
          throw new Error(`${scope} is not an input`);
        }
        return checkbox;
      };

      expect(checkboxFor('admin:projects').checked).toBe(false);
      expect(checkboxFor('admin:keys').checked).toBe(false);
      expect(checkboxFor('table:delete').checked).toBe(false);
      expect(checkboxFor('table:read').checked).toBe(true);

      for (const scope of ['table:read', 'table:create', 'table:update', 'table:delete', 'admin:projects', 'admin:keys']) {
        const describedBy = checkboxFor(scope).getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        const description = document.getElementById(describedBy ?? '');
        expect(description?.textContent?.length ?? 0).toBeGreaterThan(10);
      }
      expect(screen.getAllByText('Destructive')).toHaveLength(3);
      expect(checkboxFor('admin:projects').closest('label')?.textContent).toContain('Destructive');
      expect(checkboxFor('table:read').closest('label')?.textContent).not.toContain('Destructive');

      fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
      await screen.findByText('Creating API key ops-key complete.');
      expect(createdScopes).toEqual(['table:read']);
    });
  });

  describe('cache status fan-out', () => {
    function createFanOutFetch(tableCount: number) {
      const inFlight = new Set<string>();
      const pending = new Map<string, Deferred<Response>>();
      const signals = new Map<string, AbortSignal | null>();
      const started: string[] = [];
      let maxInFlight = 0;
      const bigTables = Array.from({ length: tableCount }, (_, index) => createTableConfig('big', `t${index}`));

      const fetchMock = stubFetch((input, init) => {
        const key = requestKey(input, init);
        if (key === 'GET /v1/admin/projects') {
          return createJsonResponse({ data: [createProjectSummary('big', tableCount), createProjectSummary('other')] });
        }
        if (key === 'GET /v1/admin/projects?project=big') {
          return createJsonResponse({ project: createProjectConfig('big'), tables: bigTables });
        }
        if (key === 'GET /v1/admin/projects?project=other') {
          return createJsonResponse({ project: createProjectConfig('other'), tables: [] });
        }
        if (key === 'GET /v1/admin/keys' || key.startsWith('GET /v1/admin/keys?')) {
          return createJsonResponse({ data: [] });
        }
        if (key === 'GET /v1/admin/system/google/drive/watches') {
          return createJsonResponse({ data: [] });
        }
        if (key.endsWith('/cache')) {
          const deferred = createDeferred<Response>();
          pending.set(key, deferred);
          signals.set(key, init?.signal ?? null);
          started.push(key);
          inFlight.add(key);
          maxInFlight = Math.max(maxInFlight, inFlight.size);
          return deferred.promise.finally(() => inFlight.delete(key));
        }
        throw new Error(`Unexpected request: ${key}`);
      });

      return {
        fetchMock,
        started,
        pending,
        signals,
        inFlightCount: () => inFlight.size,
        maxInFlight: () => maxInFlight
      };
    }

    it('never has more than four cache-status requests in flight and renders results as they settle', async () => {
      const fanOut = createFanOutFetch(10);

      render(<App />);
      signIn('secret-token');

      await waitFor(() => expect(fanOut.started).toHaveLength(4));
      expect(fanOut.inFlightCount()).toBe(4);

      fanOut.pending.get('GET /v1/admin/projects/big/tables/t0/cache')?.resolve(
        createJsonResponse({ data: createCacheStatus() })
      );

      await screen.findByText('Healthy 1');
      await waitFor(() => expect(fanOut.started).toHaveLength(5));
      expect(fanOut.maxInFlight()).toBe(4);
    });

    it('aborts outstanding cache-status requests when the project changes', async () => {
      const fanOut = createFanOutFetch(10);

      render(<App />);
      signIn('secret-token');
      await waitFor(() => expect(fanOut.started).toHaveLength(4));

      fireEvent.click(await screen.findByTestId('project-card-other'));

      await waitFor(() => {
        const signals = [...fanOut.signals.values()];
        expect(signals).toHaveLength(4);
        expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
      });
      expect(fanOut.started).toHaveLength(4);
    });
  });

  describe('project switching during target-bound actions', () => {
    it('disables project switching while a manual project refresh is in flight and keeps its result bound to the project', async () => {
      let demoDetailCalls = 0;
      const manualRefresh = createDeferred<Response>();
      stubFetch((input, init) => {
        const key = requestKey(input, init);
        if (key === 'GET /v1/admin/projects') {
          return createJsonResponse({ data: [createProjectSummary('demo', 1), createProjectSummary('prod', 1)] });
        }
        if (key === 'GET /v1/admin/projects?project=demo') {
          demoDetailCalls += 1;
          if (demoDetailCalls === 2) {
            return manualRefresh.promise;
          }
          return createJsonResponse({
            project: createProjectConfig('demo'),
            tables: [createTableConfig('demo', 'users')]
          });
        }
        if (key === 'GET /v1/admin/projects?project=prod') {
          return createJsonResponse({
            project: createProjectConfig('prod'),
            tables: [createTableConfig('prod', 'orders')]
          });
        }
        if (key.endsWith('/cache')) {
          return createJsonResponse({ data: createCacheStatus() });
        }
        if (key === 'GET /v1/admin/keys' || key.startsWith('GET /v1/admin/keys?')) {
          return createJsonResponse({ data: [] });
        }
        if (key === 'GET /v1/admin/system/google/drive/watches') {
          return createJsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${key}`);
      });

      render(<App />);
      signIn('secret-token');
      await screen.findAllByText('users');

      fireEvent.click(screen.getByRole('button', { name: 'Refresh project' }));
      await waitFor(() => expect(demoDetailCalls).toBe(2));

      const prodCard = screen.getByTestId('project-card-prod');
      expect(prodCard.hasAttribute('disabled')).toBe(true);
      fireEvent.click(prodCard);

      manualRefresh.resolve(
        createJsonResponse({
          project: createProjectConfig('demo'),
          tables: [createTableConfig('demo', 'users')]
        })
      );

      await screen.findByText('Refreshing project demo complete.');
      expect(screen.getByTestId('project-card-demo').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('project-card-prod').getAttribute('aria-pressed')).toBe('false');
      expect(screen.getAllByText('users').length).toBeGreaterThan(0);
      expect(screen.queryByText('orders')).toBeNull();
    });
  });
});
