import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listDriveWatchRetryAdvice,
  listDriveWatches,
  planDriveWatchRegistration,
  registerDriveWatches
} from './setup-drive-watches';

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
            channelId: 'channel-sheet-1',
            lastWatchError: null
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
        channelId: 'channel-sheet-1',
        lastWatchError: null
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

describe('planDriveWatchRegistration', () => {
  const noActions = { applySecretsNow: false, deployNow: false, bootstrapNow: false };
  const known = { apiUrl: 'https://example.workers.dev', adminCredential: 'sfk_admin.secret' };

  it('re-registers watches after --apply-secrets rotates the webhook secret and the API is reachable', () => {
    expect(planDriveWatchRegistration({
      actions: { ...noActions, applySecretsNow: true },
      ...known
    })).toEqual({ kind: 'register' });
  });

  it('warns with the exact recovery command when the API URL is unknown after rotating secrets', () => {
    const plan = planDriveWatchRegistration({
      actions: { ...noActions, applySecretsNow: true },
      apiUrl: null,
      adminCredential: 'sfk_admin.secret'
    });

    expect(plan.kind).toBe('warn');
    if (plan.kind === 'warn') {
      expect(plan.message).toContain('Drive webhook secret');
      expect(plan.message).toContain('SHEETFLARE_BASE_URL');
      expect(plan.message).not.toContain('SHEETFLARE_ADMIN_CREDENTIAL');
      expect(plan.message).toContain('npm run ops:watch:drive');
    }
  });

  it('names the admin credential when only that is unknown', () => {
    const plan = planDriveWatchRegistration({
      actions: { ...noActions, applySecretsNow: true },
      apiUrl: known.apiUrl,
      adminCredential: null
    });

    expect(plan.kind).toBe('warn');
    if (plan.kind === 'warn') {
      expect(plan.message).toContain('SHEETFLARE_ADMIN_CREDENTIAL');
      expect(plan.message).not.toContain('SHEETFLARE_BASE_URL');
      expect(plan.message).toContain('npm run ops:watch:drive');
    }
  });

  it('registers after deploy or bootstrap as before, and stays silent when nothing is known yet', () => {
    expect(planDriveWatchRegistration({ actions: { ...noActions, deployNow: true }, ...known })).toEqual({ kind: 'register' });
    expect(planDriveWatchRegistration({ actions: { ...noActions, bootstrapNow: true }, ...known })).toEqual({ kind: 'register' });
    expect(planDriveWatchRegistration({
      actions: { ...noActions, deployNow: true },
      apiUrl: null,
      adminCredential: null
    })).toEqual({ kind: 'skip' });
  });

  it('does nothing for runs that neither apply secrets nor deploy nor bootstrap', () => {
    expect(planDriveWatchRegistration({ actions: noActions, ...known })).toEqual({ kind: 'skip' });
  });

  it('stays quiet when bootstrap has no API URL and secrets were not applied', () => {
    expect(planDriveWatchRegistration({
      actions: { ...noActions, bootstrapNow: true },
      apiUrl: null,
      adminCredential: 'sfk_admin.secret'
    })).toEqual({ kind: 'skip' });
  });

  it('warns with the recovery command when secrets were applied with bootstrap but the API URL is unknown', () => {
    const plan = planDriveWatchRegistration({
      actions: { applySecretsNow: true, deployNow: false, bootstrapNow: true },
      apiUrl: null,
      adminCredential: 'sfk_admin.secret'
    });

    expect(plan.kind).toBe('warn');
    if (plan.kind === 'warn') {
      expect(plan.message).toContain('SHEETFLARE_BASE_URL');
      expect(plan.message).toContain('npm run ops:watch:drive');
    }
  });
});
