import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDriveWatchRetryAdvice, listDriveWatches, registerDriveWatches } from './setup-drive-watches';

describe('registerDriveWatches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers Drive watches through the admin api with explicit overrides when provided', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            spreadsheetId: 'sheet-1',
            channelId: 'channel-sheet-1'
          }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(registerDriveWatches({
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret',
      debounceSeconds: 45,
      expirationHours: 72
    })).resolves.toEqual([
      {
        spreadsheetId: 'sheet-1',
        channelId: 'channel-sheet-1'
      }
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/admin/system/google/drive/watches/register',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sfk_admin.secret',
          'content-type': 'application/json'
        }),
        body: JSON.stringify({
          debounceSeconds: 45,
          expirationHours: 72
        })
      })
    );
  });

  it('omits override fields when setup uses defaults', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await registerDriveWatches({
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'bootstrap.secret'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/admin/system/google/drive/watches/register',
      expect.objectContaining({
        body: JSON.stringify({})
      })
    );
  });

  it('lists Drive watches through the admin api', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: [
        {
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'default',
          channelId: 'channel-sheet-1',
          resourceId: 'resource-sheet-1',
          resourceUri: null,
          expirationAt: '2026-05-02T00:00:00.000Z',
          lastWatchError: null,
          lastNotificationAt: null,
          pendingChangedAt: null,
          debounceUntil: null,
          lastReindexStartedAt: null,
          lastReindexCompletedAt: null,
          lastReindexError: null,
          projectSlugs: ['sheetflare-prod']
        }
      ]
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listDriveWatches({
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret'
    })).resolves.toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        channelId: 'channel-sheet-1'
      })
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/admin/system/google/drive/watches',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer sfk_admin.secret'
        })
      })
    );
  });

  it('retries an empty watch list before giving up', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({
        data: [
          {
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            channelId: 'channel-sheet-1',
            resourceId: 'resource-sheet-1',
            resourceUri: null,
            expirationAt: '2026-05-02T00:00:00.000Z',
            lastWatchError: null,
            lastNotificationAt: null,
            pendingChangedAt: null,
            debounceUntil: null,
            lastReindexStartedAt: null,
            lastReindexCompletedAt: null,
            lastReindexError: null,
            projectSlugs: ['sheetflare-prod']
          }
        ]
      }));
    const sleep = vi.fn(async () => {});
    vi.stubGlobal('fetch', fetchMock);

    await expect(listDriveWatches({
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret',
      retries: 1,
      retryDelayMs: 5
    }, {
      sleep
    })).resolves.toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1'
      })
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('lists Drive watch retry advice through the admin api', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: [
        {
          spreadsheetId: 'sheet-1',
          status: 'cooldown-recommended',
          currentWatchExpirationAt: null,
          lastKnownStoppedAt: '2026-05-01T12:00:00.000Z',
          lastKnownExpirationAt: '2026-05-02T12:00:00.000Z',
          safeRetryAt: '2026-05-02T12:15:00.000Z',
          note: 'Wait before retrying.',
          projectSlugs: ['sheetflare-prod']
        }
      ]
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listDriveWatchRetryAdvice({
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret'
    })).resolves.toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        status: 'cooldown-recommended'
      })
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/admin/system/google/drive/watches/retry-advice',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer sfk_admin.secret'
        })
      })
    );
  });
});
