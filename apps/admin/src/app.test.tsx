// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiKeyPrincipal } from '@sheetflare/contracts';
import { App } from './app';

const storage = new Map<string, string>();

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req-ui'
    }
  });
}

function installLocalStorage() {
  const localStorageMock = {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    }
  };

  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    configurable: true
  });
}

describe('App', () => {
  beforeEach(() => {
    storage.clear();
    installLocalStorage();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists global keys separately and shows revoked status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/v1/admin/projects' && method === 'GET') {
        return createJsonResponse({
          data: [
            {
              slug: 'demo',
              name: 'Demo',
              spreadsheetId: 'sheet-1',
              tableCount: 1,
              updatedAt: '2026-04-26T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects?project=demo') {
        return createJsonResponse({
          project: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z'
          },
          tables: []
        });
      }

      if (url === '/v1/admin/keys?project=demo') {
        return createJsonResponse({
          data: [
            {
              id: 'project-key',
              projectSlug: 'demo',
              name: 'Project key',
              scopes: ['table:read'],
              createdAt: '2026-04-26T00:00:00.000Z',
              revokedAt: null,
              lastUsedAt: null
            },
            {
              id: 'project-revoked',
              projectSlug: 'demo',
              name: 'Project revoked',
              scopes: ['table:read'],
              createdAt: '2026-04-26T00:00:00.000Z',
              revokedAt: '2026-04-27T00:00:00.000Z',
              lastUsedAt: null
            }
          ]
        });
      }

      if (url === '/v1/admin/keys') {
        return createJsonResponse({
          data: [
            {
              id: 'global-key',
              projectSlug: null,
              name: 'Global key',
              scopes: ['admin:keys'],
              createdAt: '2026-04-26T00:00:00.000Z',
              revokedAt: null,
              lastUsedAt: null
            }
          ]
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
      target: { value: 'secret-token' }
    });
    fireEvent.click(screen.getByText('Save and load'));

    await screen.findByText('Demo');
    await screen.findByText('Global Admin Keys');
    await screen.findByText('Global key');
    await screen.findByText('Project revoked');
    expect(screen.getAllByText('Revoked').length).toBeGreaterThan(0);
  });

  it('revokes a key and refreshes the status in the UI', async () => {
    let keys: ApiKeyPrincipal[] = [
      {
        id: 'project-key',
        projectSlug: 'demo',
        name: 'Project key',
        scopes: ['table:read'],
        createdAt: '2026-04-26T00:00:00.000Z',
        revokedAt: null,
        lastUsedAt: null
      }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/v1/admin/projects' && method === 'GET') {
        return createJsonResponse({
          data: [
            {
              slug: 'demo',
              name: 'Demo',
              spreadsheetId: 'sheet-1',
              tableCount: 1,
              updatedAt: '2026-04-26T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects?project=demo') {
        return createJsonResponse({
          project: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z'
          },
          tables: []
        });
      }

      if (url === '/v1/admin/keys?project=demo') {
        return createJsonResponse({ data: keys });
      }

      if (url === '/v1/admin/keys') {
        return createJsonResponse({ data: [] });
      }

      if (url === '/v1/admin/keys/project-key' && method === 'DELETE') {
        keys = [
          {
            ...keys[0]!,
            revokedAt: '2026-04-27T00:00:00.000Z'
          }
        ];
        return createJsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
      target: { value: 'secret-token' }
    });
    fireEvent.click(screen.getByText('Save and load'));

    await screen.findByText('Project key');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(screen.getAllByText('Revoked').length).toBeGreaterThan(0);
    });
  });

  it('keeps cache state scoped to the selected project when table slugs overlap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/v1/admin/projects' && method === 'GET') {
        return createJsonResponse({
          data: [
            {
              slug: 'demo',
              name: 'Demo',
              spreadsheetId: 'sheet-1',
              tableCount: 1,
              updatedAt: '2026-04-26T00:00:00.000Z'
            },
            {
              slug: 'prod',
              name: 'Prod',
              spreadsheetId: 'sheet-2',
              tableCount: 1,
              updatedAt: '2026-04-27T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects?project=demo') {
        return createJsonResponse({
          project: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z'
          },
          tables: [
            {
              projectSlug: 'demo',
              tableSlug: 'users',
              sheetTabName: 'Users',
              idColumn: '_id',
              indexedFields: ['_id', 'status'],
              headerRow: 1,
              dataStartRow: 2,
              readEnabled: true,
              createEnabled: true,
              updateEnabled: true,
              deleteEnabled: true,
              cacheTtlSeconds: 15,
              createdAt: '2026-04-26T00:00:00.000Z',
              updatedAt: '2026-04-26T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects?project=prod') {
        return createJsonResponse({
          project: {
            slug: 'prod',
            name: 'Prod',
            spreadsheetId: 'sheet-2',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-27T00:00:00.000Z',
            updatedAt: '2026-04-27T00:00:00.000Z'
          },
          tables: [
            {
              projectSlug: 'prod',
              tableSlug: 'users',
              sheetTabName: 'Users',
              idColumn: '_id',
              indexedFields: ['_id', 'status'],
              headerRow: 1,
              dataStartRow: 2,
              readEnabled: true,
              createEnabled: true,
              updateEnabled: true,
              deleteEnabled: true,
              cacheTtlSeconds: 15,
              createdAt: '2026-04-27T00:00:00.000Z',
              updatedAt: '2026-04-27T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects/demo/tables/users/cache') {
        return createJsonResponse({
          data: {
            status: 'ready',
            cacheTtlSeconds: 15,
            stale: false,
            staleReason: 'fresh',
            rowCount: 3,
            lastSyncStartedAt: '2026-04-26T00:00:00.000Z',
            lastSyncCompletedAt: '2026-04-26T00:00:01.000Z',
            lastSyncError: null
          }
        });
      }

      if (url === '/v1/admin/projects/prod/tables/users/cache') {
        return createJsonResponse({
          data: {
            status: 'ready',
            cacheTtlSeconds: 15,
            stale: false,
            staleReason: 'fresh',
            rowCount: 1,
            lastSyncStartedAt: '2026-04-27T00:00:00.000Z',
            lastSyncCompletedAt: '2026-04-27T00:00:01.000Z',
            lastSyncError: null
          }
        });
      }

      if (url === '/v1/admin/keys?project=demo' || url === '/v1/admin/keys?project=prod' || url === '/v1/admin/keys') {
        return createJsonResponse({ data: [] });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
      target: { value: 'secret-token' }
    });
    fireEvent.click(screen.getByText('Save and load'));

    await screen.findByTestId('table-card-users');
    await screen.findByText('ready / fresh / 3 rows');

    fireEvent.click(screen.getByTestId('project-card-prod'));
    await waitFor(() => {
      expect(screen.getByTestId('project-card-prod').getAttribute('aria-pressed')).toBe('true');
    });

    await waitFor(() => {
      expect(screen.queryByText('ready / fresh / 3 rows')).toBeNull();
      expect(screen.getByText('ready / fresh / 1 rows')).toBeTruthy();
    });
  });

  it('auto-loads cache status, links to the spreadsheet, and refreshes stale tables on demand', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/v1/admin/projects' && method === 'GET') {
        return createJsonResponse({
          data: [
            {
              slug: 'demo',
              name: 'Demo',
              spreadsheetId: 'sheet-1',
              tableCount: 1,
              updatedAt: '2026-04-26T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects?project=demo') {
        return createJsonResponse({
          project: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z'
          },
          tables: [
            {
              projectSlug: 'demo',
              tableSlug: 'users',
              sheetTabName: 'Users',
              idColumn: '_id',
              indexedFields: ['_id', 'status'],
              headerRow: 1,
              dataStartRow: 2,
              readEnabled: true,
              createEnabled: true,
              updateEnabled: true,
              deleteEnabled: true,
              cacheTtlSeconds: 15,
              createdAt: '2026-04-26T00:00:00.000Z',
              updatedAt: '2026-04-26T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects/demo/tables/users/cache' && method === 'GET') {
        return createJsonResponse({
          data: {
            status: 'ready',
            cacheTtlSeconds: 15,
            stale: true,
            staleReason: 'ttl-expired',
            rowCount: 0,
            lastSyncStartedAt: '2026-04-26T00:00:00.000Z',
            lastSyncCompletedAt: '2026-04-26T00:00:01.000Z',
            lastSyncError: null
          }
        });
      }

      if (url === '/v1/admin/projects/demo/tables/users/refresh' && method === 'POST') {
        return createJsonResponse({
          ok: true,
          rowCount: 3,
          cache: {
            status: 'ready',
            cacheTtlSeconds: 15,
            stale: false,
            staleReason: 'fresh',
            rowCount: 3,
            lastSyncStartedAt: '2026-04-26T00:00:02.000Z',
            lastSyncCompletedAt: '2026-04-26T00:00:03.000Z',
            lastSyncError: null
          }
        });
      }

      if (url === '/v1/admin/keys?project=demo' || url === '/v1/admin/keys') {
        return createJsonResponse({ data: [] });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
      target: { value: 'secret-token' }
    });
    fireEvent.click(screen.getByText('Save and load'));

    await screen.findByText('ready / ttl-expired / 0 rows');
    const spreadsheetLink = screen.getByRole('link', { name: 'Open in Google Sheets' });
    expect(spreadsheetLink.getAttribute('href')).toBe('https://docs.google.com/spreadsheets/d/sheet-1/edit');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh if stale' }));
    await screen.findByText('Refreshing cache for demo/users if stale complete.');
    await screen.findByText('ready / fresh / 3 rows');
  });

  it('clears the revealed key when the selected project changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/v1/admin/projects' && method === 'GET') {
        return createJsonResponse({
          data: [
            {
              slug: 'demo',
              name: 'Demo',
              spreadsheetId: 'sheet-1',
              tableCount: 0,
              updatedAt: '2026-04-26T00:00:00.000Z'
            },
            {
              slug: 'prod',
              name: 'Prod',
              spreadsheetId: 'sheet-2',
              tableCount: 0,
              updatedAt: '2026-04-27T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects?project=demo' || url === '/v1/admin/projects?project=prod') {
        const projectSlug = url.endsWith('prod') ? 'prod' : 'demo';
        return createJsonResponse({
          project: {
            slug: projectSlug,
            name: projectSlug === 'demo' ? 'Demo' : 'Prod',
            spreadsheetId: projectSlug === 'demo' ? 'sheet-1' : 'sheet-2',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z'
          },
          tables: []
        });
      }

      if (url === '/v1/admin/keys' && method === 'POST') {
        return createJsonResponse({
          apiKey: 'sfk_created.secret',
          record: {
            id: 'created',
            projectSlug: 'demo',
            name: 'Ops key',
            scopes: ['table:read'],
            createdAt: '2026-04-26T00:00:00.000Z',
            revokedAt: null,
            lastUsedAt: null
          }
        });
      }

      if (url === '/v1/admin/keys?project=demo' || url === '/v1/admin/keys?project=prod' || url === '/v1/admin/keys') {
        return createJsonResponse({ data: [] });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
      target: { value: 'secret-token' }
    });
    fireEvent.click(screen.getByText('Save and load'));

    await screen.findByText('Demo');
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByText('New key:');

    fireEvent.click(screen.getByTestId('project-card-prod'));
    await waitFor(() => {
      expect(screen.getByTestId('project-card-prod').getAttribute('aria-pressed')).toBe('true');
    });

    await waitFor(() => {
      expect(screen.queryByText('New key:')).toBeNull();
    });
  });

  it('refreshes the project registry and reselects the first available project when the current one disappears', async () => {
    let registryVersion: 'initial' | 'after-refresh' = 'initial';

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/v1/admin/projects' && method === 'GET') {
        return createJsonResponse({
          data: registryVersion === 'initial'
            ? [
                {
                  slug: 'demo',
                  name: 'Demo',
                  spreadsheetId: 'sheet-1',
                  tableCount: 0,
                  updatedAt: '2026-04-26T00:00:00.000Z'
                },
                {
                  slug: 'prod',
                  name: 'Prod',
                  spreadsheetId: 'sheet-2',
                  tableCount: 0,
                  updatedAt: '2026-04-27T00:00:00.000Z'
                }
              ]
            : [
                {
                  slug: 'demo',
                  name: 'Demo',
                  spreadsheetId: 'sheet-1',
                  tableCount: 0,
                  updatedAt: '2026-04-26T00:00:00.000Z'
                }
              ]
        });
      }

      if (url === '/v1/admin/projects?project=demo') {
        return createJsonResponse({
          project: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z'
          },
          tables: []
        });
      }

      if (url === '/v1/admin/projects?project=prod') {
        return createJsonResponse({
          project: {
            slug: 'prod',
            name: 'Prod',
            spreadsheetId: 'sheet-2',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-27T00:00:00.000Z',
            updatedAt: '2026-04-27T00:00:00.000Z'
          },
          tables: []
        });
      }

      if (url === '/v1/admin/keys?project=demo' || url === '/v1/admin/keys?project=prod' || url === '/v1/admin/keys') {
        return createJsonResponse({ data: [] });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
      target: { value: 'secret-token' }
    });
    fireEvent.click(screen.getByText('Save and load'));

    await screen.findByText('Demo');
    fireEvent.click(screen.getByTestId('project-card-prod'));
    await waitFor(() => {
      expect(screen.getByTestId('project-card-prod').getAttribute('aria-pressed')).toBe('true');
    });

    registryVersion = 'after-refresh';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));

    await waitFor(() => {
      expect(screen.queryByTestId('project-card-prod')).toBeNull();
      expect(screen.getByTestId('project-card-demo').getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('shows inline validation for invalid table drafts before submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/v1/admin/projects' && method === 'GET') {
        return createJsonResponse({
          data: [
            {
              slug: 'demo',
              name: 'Demo',
              spreadsheetId: 'sheet-1',
              tableCount: 0,
              updatedAt: '2026-04-26T00:00:00.000Z'
            }
          ]
        });
      }

      if (url === '/v1/admin/projects?project=demo') {
        return createJsonResponse({
          project: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            defaultAuthMode: 'private',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z'
          },
          tables: []
        });
      }

      if (url === '/v1/admin/keys?project=demo' || url === '/v1/admin/keys') {
        return createJsonResponse({ data: [] });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('sfk_... or bootstrap token'), {
      target: { value: 'secret-token' }
    });
    fireEvent.click(screen.getByText('Save and load'));

    await screen.findByText('Create Table');
    const selectedProjectSection = screen.getByText('Selected Project');
    const panel = selectedProjectSection.closest('section');
    expect(panel).not.toBeNull();

    const scope = within(panel as HTMLElement);
    const tableSlugInput = scope.getByText('Table Slug').closest('label')?.querySelector('input');
    const headerRowInput = scope.getByText('Header Row').closest('label')?.querySelector('input');
    const dataStartRowInput = scope.getByText('Data Start Row').closest('label')?.querySelector('input');
    const cacheTtlInput = scope.getByText('Cache TTL Seconds').closest('label')?.querySelector('input');

    expect(tableSlugInput).not.toBeNull();
    expect(headerRowInput).not.toBeNull();
    expect(dataStartRowInput).not.toBeNull();
    expect(cacheTtlInput).not.toBeNull();

    fireEvent.change(tableSlugInput as HTMLInputElement, {
      target: { value: 'Users Table' }
    });
    fireEvent.change(headerRowInput as HTMLInputElement, {
      target: { value: '2' }
    });
    fireEvent.change(dataStartRowInput as HTMLInputElement, {
      target: { value: '1' }
    });
    fireEvent.change(cacheTtlInput as HTMLInputElement, {
      target: { value: '-1' }
    });

    expect(scope.getByText('Use lowercase letters, numbers, and single hyphens.')).toBeTruthy();
    expect(scope.getByText('dataStartRow must be greater than headerRow.')).toBeTruthy();
    expect(scope.getByText('Cache TTL must be a non-negative integer.')).toBeTruthy();
    expect(scope.getByRole('button', { name: 'Save table' })).toHaveProperty('disabled', true);
  });
});
