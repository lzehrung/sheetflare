import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminCredentialHeaderName } from './auth';
import { deleteProject, deleteTable, inspectSpreadsheetTab, listApiKeys, listProjects, listSpreadsheetTabs, listSpreadsheetWatches, refreshTableCache, revokeApiKey } from './api';

describe('admin api helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes request id and body summary when a non-JSON error response is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html>upstream unavailable</html>', {
          status: 503,
          headers: {
            'x-request-id': 'req-123'
          }
        })
      )
    );

    await expect(listProjects('secret')).rejects.toThrow(
      'Request failed: 503 requestId=req-123 body=<html>upstream unavailable</html>'
    );
  });

  it('surfaces invalid JSON on successful responses clearly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html>ok?</html>', {
          status: 200,
          headers: {
            'x-request-id': 'req-200'
          }
        })
      )
    );

    await expect(listProjects('secret')).rejects.toThrow(
      'Request returned an invalid JSON response. requestId=req-200 body=<html>ok?</html>'
    );
  });

  it('lists project-scoped keys through the admin api', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: 'key-1',
              projectSlug: 'demo',
              name: 'Demo key',
              scopes: ['table:read'],
              createdAt: '2026-04-26T00:00:00.000Z',
              revokedAt: null,
              lastUsedAt: null
            }
          ]
        })
      )
    );

    await expect(listApiKeys('secret', 'demo')).resolves.toEqual({
      data: [
        expect.objectContaining({
          id: 'key-1',
          projectSlug: 'demo'
        })
      ]
    });
  });

  it('revokes keys through the admin api', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeApiKey('secret', 'key-1')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/keys/key-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          [adminCredentialHeaderName]: 'secret'
        }
      })
    );
  });

  it('deletes projects through the admin api', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      deletedProject: 'demo',
      deletedTables: ['users']
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteProject('secret', 'demo')).resolves.toEqual({
      ok: true,
      deletedProject: 'demo',
      deletedTables: ['users']
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          [adminCredentialHeaderName]: 'secret'
        }
      })
    );
  });

  it('deletes tables through the admin api', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      deletedTable: 'users'
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteTable('secret', 'demo', 'users')).resolves.toEqual({
      ok: true,
      deletedTable: 'users'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo/tables/users',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          [adminCredentialHeaderName]: 'secret'
        }
      })
    );
  });

  it('refreshes a stale table cache through the admin api', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        rowCount: 3,
        cache: {
          status: 'ready',
          cacheTtlSeconds: 15,
          stale: false,
          staleReason: 'fresh',
          rowCount: 3,
          lastSyncStartedAt: '2026-04-26T00:00:00.000Z',
          lastSyncCompletedAt: '2026-04-26T00:00:02.000Z',
          lastSyncError: null,
          validation: {
            status: 'ok',
            issueCount: 0,
            issues: [],
            validatedAt: '2026-04-26T00:00:02.000Z'
          },
          externalChange: {
            pending: false,
            lastChangedAt: null,
            debounceUntil: null,
            lastAutoReindexAt: null
          }
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshTableCache('secret', 'demo', 'users')).resolves.toMatchObject({
      ok: true,
      rowCount: 3
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo/tables/users/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: {
          [adminCredentialHeaderName]: 'secret'
        }
      })
    );
  });

  it('lists spreadsheet tabs through the admin api', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            title: 'Users',
            sheetGid: 11
          }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listSpreadsheetTabs('secret', 'demo')).resolves.toEqual({
      data: [
        {
          title: 'Users',
          sheetGid: 11
        }
      ]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo/spreadsheet/tabs',
      expect.objectContaining({
        headers: {
          [adminCredentialHeaderName]: 'secret'
        }
      })
    );
  });

  it('lists spreadsheet watch status through the admin api', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            channelId: 'channel-sheet-1',
            resourceId: 'resource-sheet-1',
            resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
            expirationAt: '2026-05-03T00:00:00.000Z',
            lastWatchError: null,
            lastNotificationAt: '2026-04-26T00:00:00.000Z',
            pendingChangedAt: null,
            debounceUntil: null,
            lastReindexStartedAt: null,
            lastReindexCompletedAt: '2026-04-26T00:00:10.000Z',
            lastReindexError: null,
            projectSlugs: ['demo']
          }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listSpreadsheetWatches('secret')).resolves.toEqual({
      data: [
        expect.objectContaining({
          spreadsheetId: 'sheet-1',
          lastWatchError: null
        })
      ]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/system/google/drive/watches',
      expect.objectContaining({
        headers: {
          [adminCredentialHeaderName]: 'secret'
        }
      })
    );
  });

  it('inspects a spreadsheet tab header row through the admin api', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          tab: {
            title: 'Users',
            sheetGid: 11
          },
          headerRow: 3,
          headers: ['_id', 'email', 'status']
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(inspectSpreadsheetTab('secret', 'demo', 'Users', 3)).resolves.toEqual({
      data: {
        tab: {
          title: 'Users',
          sheetGid: 11
        },
        headerRow: 3,
        headers: ['_id', 'email', 'status']
      }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo/spreadsheet/tabs/Users?headerRow=3',
      expect.objectContaining({
        headers: {
          [adminCredentialHeaderName]: 'secret'
        }
      })
    );
  });

  it('surfaces specific 401 messages instead of always reporting a rejected credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'UNAUTHORIZED',
              message: 'This operation requires a global admin key.',
              details: null
            }
          },
          {
            status: 401,
            headers: {
              'x-request-id': 'req-401'
            }
          }
        )
      )
    );

    await expect(listSpreadsheetWatches('secret')).rejects.toThrow(
      'This operation requires a global admin key. requestId=req-401'
    );
  });
});
