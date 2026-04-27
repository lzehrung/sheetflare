// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
