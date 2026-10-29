import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminRequestHeaderName, type AdminAccess } from './auth';
import { AdminApiError, AdminResponseShapeError, classifyAuthFailure, deleteProject, getProject, deleteTable, inspectSpreadsheetTab, listApiKeys, listProjects, listSpreadsheetTabs, listSpreadsheetWatches, refreshTableCache, revokeApiKey } from './api';

const browserAccess: AdminAccess = { source: 'browser', credential: 'secret' };

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

    await expect(listProjects(browserAccess)).rejects.toThrow(
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

    await expect(listProjects(browserAccess)).rejects.toThrow(
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

    await expect(listApiKeys(browserAccess, 'demo')).resolves.toEqual({
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

    await expect(revokeApiKey(browserAccess, 'key-1')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/keys/key-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          [adminRequestHeaderName]: '1',
          authorization: 'Bearer secret'
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

    await expect(deleteProject(browserAccess, 'demo')).resolves.toEqual({
      ok: true,
      deletedProject: 'demo',
      deletedTables: ['users']
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          [adminRequestHeaderName]: '1',
          authorization: 'Bearer secret'
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

    await expect(deleteTable(browserAccess, 'demo', 'users')).resolves.toEqual({
      ok: true,
      deletedTable: 'users'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo/tables/users',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          [adminRequestHeaderName]: '1',
          authorization: 'Bearer secret'
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
          dataGeneration: 0,
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

    await expect(refreshTableCache(browserAccess, 'demo', 'users')).resolves.toMatchObject({
      ok: true,
      rowCount: 3
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/admin/projects/demo/tables/users/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: {
          [adminRequestHeaderName]: '1',
          authorization: 'Bearer secret'
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

    await expect(listSpreadsheetTabs(browserAccess, 'demo')).resolves.toEqual({
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
          [adminRequestHeaderName]: '1',
          authorization: 'Bearer secret'
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

    await expect(listSpreadsheetWatches(browserAccess)).resolves.toEqual({
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
          [adminRequestHeaderName]: '1',
          authorization: 'Bearer secret'
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

    await expect(inspectSpreadsheetTab(browserAccess, 'demo', 'Users', 3)).resolves.toEqual({
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
          [adminRequestHeaderName]: '1',
          authorization: 'Bearer secret'
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

    await expect(listSpreadsheetWatches(browserAccess)).rejects.toThrow(
      'This operation requires a global admin key. requestId=req-401'
    );
  });

  describe('typed client errors', () => {
    function workerError(status: number, code: string, message: string) {
      return vi.fn(async () => Response.json({ error: { code, message, details: null } }, { status }));
    }

    it('carries status and code from the Worker error body', async () => {
      vi.stubGlobal('fetch', workerError(401, 'UNAUTHORIZED', 'Unauthorized'));

      const error = await listProjects(browserAccess).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AdminApiError);
      expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    });

    it('classifies a 401 as a rejected credential even when the body uses an old scope-denial message', async () => {
      for (const message of [
        'Unauthorized',
        'Invalid API key.',
        'Unsupported authorization scheme.',
        'This operation requires a global admin key.',
        'This key cannot list API keys for another project.',
        'This key can only create API keys for its own project.',
        'API keys can only delegate scopes they already have.'
      ]) {
        vi.stubGlobal('fetch', workerError(401, 'UNAUTHORIZED', message));
        const error = await listProjects(browserAccess).catch((caught: unknown) => caught);
        expect(classifyAuthFailure(error)).toBe('invalid-credential');
      }
    });

    it('classifies 403 FORBIDDEN as insufficient scope without reading the message', async () => {
      for (const message of [
        'Forbidden',
        'This operation requires a global admin key.',
        'This key cannot list API keys for another project.',
        'This API key does not have the "admin:projects" scope.'
      ]) {
        vi.stubGlobal('fetch', workerError(403, 'FORBIDDEN', message));
        const error = await listProjects(browserAccess).catch((caught: unknown) => caught);
        expect(classifyAuthFailure(error)).toBe('insufficient-scope');
      }
    });

    it('does not classify non-auth failures or foreign errors', async () => {
      vi.stubGlobal('fetch', workerError(503, 'SERVICE_UNAVAILABLE', 'Unavailable'));
      const unavailable = await listProjects(browserAccess).catch((caught: unknown) => caught);

      expect(unavailable).toBeInstanceOf(AdminApiError);
      expect(classifyAuthFailure(unavailable)).toBeNull();
      expect(classifyAuthFailure(new Error('rejected'))).toBeNull();

      vi.stubGlobal('fetch', workerError(403, 'BAD_GATEWAY', 'Google Sheets authentication or permission check failed.'));
      const otherForbidden = await listProjects(browserAccess).catch((caught: unknown) => caught);
      expect(classifyAuthFailure(otherForbidden)).toBeNull();
    });

    it('treats a bodyless 401 as a rejected credential', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

      const error = await listProjects(browserAccess).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ status: 401, message: 'The configured admin credential was rejected.' });
      expect(classifyAuthFailure(error)).toBe('invalid-credential');
    });
  });

  describe('response contract validation', () => {
    it('rejects a successful response whose shape does not match the contract', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ data: null }, { headers: { 'x-request-id': 'req-skew' } }))
      );

      const error = await listProjects(browserAccess).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AdminResponseShapeError);
      expect(error).toMatchObject({ requestId: 'req-skew' });
      expect(error instanceof Error ? error.message : '').toContain('/v1/admin/projects (data:');
    });

    it('rejects a revoke acknowledgement that is not ok: true', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false })));

      await expect(revokeApiKey(browserAccess, 'key-1')).rejects.toBeInstanceOf(AdminResponseShapeError);
    });

    it('rejects a project detail response missing its project', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tables: [] })));

      await expect(getProject(browserAccess, 'demo')).rejects.toBeInstanceOf(AdminResponseShapeError);
    });
  });
});
