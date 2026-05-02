import type { SpreadsheetWatchRetryAdvice } from '@sheetflare/contracts';
import type { SetupConfig } from './setup-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSetupDoctorFailureMessage, runSetupDoctor } from './setup-doctor';

const baseConfig: SetupConfig = {
  profile: 'production',
  deploy: {
    api: true,
    admin: true
  },
  privateProject: {
    slug: 'sheetflare-prod',
    name: 'Sheetflare Prod',
    spreadsheetId: 'sheet-1',
    googleCredentialRef: 'default',
    tables: [
      {
        tableSlug: 'tasks',
        sheetTabName: 'tasks',
        idColumn: '_id',
        indexedFields: ['name', 'status'],
        cacheTtlSeconds: 60
      }
    ]
  },
  publicReadProject: null,
  smoke: {
    enabled: true,
    privateTableSlug: 'tasks',
    publicTableSlug: null,
    adminKeyName: 'prod-admin',
    privateReadKeyName: 'prod-read',
    mutationKeyName: 'prod-mutation',
    createValues: {
      name: 'Smoke Row',
      status: 'active'
    },
    updateValues: {
      status: 'inactive'
    }
  }
};

function activeRetryAdvice(): SpreadsheetWatchRetryAdvice[] {
  return [
    {
      spreadsheetId: 'sheet-1',
      status: 'active-watch-present',
      currentWatchExpirationAt: '2099-05-01T00:00:00.000Z',
      lastKnownStoppedAt: null,
      lastKnownExpirationAt: null,
      safeRetryAt: null,
      note: 'A known Drive watch is still active for this spreadsheet.',
      projectSlugs: ['sheetflare-prod']
    }
  ];
}

describe('runSetupDoctor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats warnings as verification failures for setup --verify', () => {
    expect(getSetupDoctorFailureMessage([
      {
        name: 'Drive watch status',
        status: 'warning',
        summary: 'Missing watch',
        remediation: 'Register it'
      }
    ])).toBe('Setup verification found 1 warning.');
  });

  it('reports a fully healthy environment when all live checks pass', async () => {
    const results = await runSetupDoctor({
      config: baseConfig,
      runtimeState: {
        googleClientEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
        namedGoogleCredentials: 'missing',
        apiUrl: 'https://sheetflare-api.example.workers.dev',
        adminUrl: 'https://sheetflare-admin.pages.dev',
        adminBearerToken: 'bootstrap.secret',
        adminUiUsername: 'admin',
        adminUiPassword: 'password',
        adminApiKey: 'sfk_admin.secret',
        privateReadKey: 'sfk_read.secret',
        mutationKey: 'sfk_mutation.secret'
      },
      prereqResults: [
        {
          name: 'Wrangler auth',
          status: 'ready',
          summary: 'Wrangler authentication is available for deploy steps.',
          remediation: null
        }
      ]
    }, {
      fetchReady: vi.fn(async () => ({
        ok: true,
        checks: {
          defaultGoogleCredential: 'configured' as const,
          namedGoogleCredentials: 'missing' as const,
          googleDriveWebhookSecret: 'configured' as const,
          bootstrapAdmin: 'configured' as const
        },
        notes: []
      })),
      listPagesProjects: vi.fn(async () => [{ name: 'sheetflare-admin' }]),
      verifyAdminPagesDeployment: vi.fn(async () => {}),
      listDriveWatches: vi.fn(async () => [
        {
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'default',
          channelId: 'channel-1',
          resourceId: 'resource-1',
          resourceUri: null,
          expirationAt: '2099-05-01T00:00:00.000Z',
          lastWatchError: null,
          lastNotificationAt: null,
          pendingChangedAt: null,
          debounceUntil: null,
          lastReindexStartedAt: null,
          lastReindexCompletedAt: null,
          lastReindexError: null,
          projectSlugs: ['sheetflare-prod']
        }
      ]),
      listDriveWatchRetryAdvice: vi.fn(async () => activeRetryAdvice())
    });

    expect(results.every((result) => result.status === 'ready')).toBe(true);
  });

  it('blocks when the placeholder Google client email is still configured', async () => {
    const results = await runSetupDoctor({
      config: baseConfig,
      runtimeState: {
        googleClientEmail: 'service-account@your-gcp-project.iam.gserviceaccount.com',
        namedGoogleCredentials: 'missing',
        apiUrl: null,
        adminUrl: null,
        adminBearerToken: null,
        adminUiUsername: null,
        adminUiPassword: null,
        adminApiKey: null,
        privateReadKey: null,
        mutationKey: null
      },
      prereqResults: []
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Google credential',
          status: 'blocked'
        })
      ])
    );
  });

  it('warns when Drive watch status is missing for the configured spreadsheet', async () => {
    const results = await runSetupDoctor({
      config: baseConfig,
      runtimeState: {
        googleClientEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
        namedGoogleCredentials: 'missing',
        apiUrl: 'https://sheetflare-api.example.workers.dev',
        adminUrl: 'https://sheetflare-admin.pages.dev',
        adminBearerToken: 'bootstrap.secret',
        adminUiUsername: null,
        adminUiPassword: null,
        adminApiKey: 'sfk_admin.secret',
        privateReadKey: null,
        mutationKey: null
      },
      prereqResults: []
    }, {
      fetchReady: vi.fn(async () => ({
        ok: true,
        checks: {
          defaultGoogleCredential: 'configured' as const,
          namedGoogleCredentials: 'missing' as const,
          googleDriveWebhookSecret: 'configured' as const,
          bootstrapAdmin: 'configured' as const
        },
        notes: []
      })),
      listPagesProjects: vi.fn(async () => []),
      verifyAdminPagesDeployment: vi.fn(async () => {}),
      listDriveWatches: vi.fn(async () => []),
      listDriveWatchRetryAdvice: vi.fn(async (): Promise<SpreadsheetWatchRetryAdvice[]> => [
        {
          spreadsheetId: 'sheet-1',
          status: 'ready-to-retry',
          currentWatchExpirationAt: null,
          lastKnownStoppedAt: null,
          lastKnownExpirationAt: null,
          safeRetryAt: null,
          note: 'No active or previously stopped watch is recorded for this spreadsheet.',
          projectSlugs: ['sheetflare-prod']
        }
      ])
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Drive watch status',
          status: 'warning'
        })
      ])
    );
  });

  it('accepts named-credential-only deployments when setup config does not use default', async () => {
    const results = await runSetupDoctor({
      config: {
        ...baseConfig,
        privateProject: {
          ...baseConfig.privateProject,
          googleCredentialRef: 'prod'
        }
      },
      runtimeState: {
        googleClientEmail: null,
        namedGoogleCredentials: 'configured',
        apiUrl: 'https://sheetflare-api.example.workers.dev',
        adminUrl: 'https://sheetflare-admin.pages.dev',
        adminBearerToken: 'bootstrap.secret',
        adminUiUsername: 'admin',
        adminUiPassword: 'password',
        adminApiKey: 'sfk_admin.secret',
        privateReadKey: 'sfk_read.secret',
        mutationKey: 'sfk_mutation.secret'
      },
      prereqResults: [
        {
          name: 'Wrangler auth',
          status: 'ready',
          summary: 'Wrangler authentication is available for deploy steps.',
          remediation: null
        }
      ]
    }, {
      fetchReady: vi.fn(async () => ({
        ok: true,
        checks: {
          defaultGoogleCredential: 'missing' as const,
          namedGoogleCredentials: 'configured' as const,
          googleDriveWebhookSecret: 'configured' as const,
          bootstrapAdmin: 'configured' as const
        },
        notes: []
      })),
      listPagesProjects: vi.fn(async () => [{ name: 'sheetflare-admin' }]),
      verifyAdminPagesDeployment: vi.fn(async () => {}),
      listDriveWatches: vi.fn(async () => [
        {
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'prod',
          channelId: 'channel-1',
          resourceId: 'resource-1',
          resourceUri: null,
          expirationAt: '2099-05-01T00:00:00.000Z',
          lastWatchError: null,
          lastNotificationAt: null,
          pendingChangedAt: null,
          debounceUntil: null,
          lastReindexStartedAt: null,
          lastReindexCompletedAt: null,
          lastReindexError: null,
          projectSlugs: ['sheetflare-prod']
        }
      ]),
      listDriveWatchRetryAdvice: vi.fn(async () => activeRetryAdvice())
    });

    expect(results.every((result) => result.status === 'ready')).toBe(true);
  });

  it('accepts structured 503 /ready responses and still reports the detailed blocking state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      checks: {
        defaultGoogleCredential: 'missing',
        namedGoogleCredentials: 'missing',
        googleDriveWebhookSecret: 'configured',
        bootstrapAdmin: 'configured'
      },
      notes: ['Neither the default Google service-account credential nor named GOOGLE_CREDENTIALS_JSON entries are configured.']
    }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-ready'
      }
    })));

    const results = await runSetupDoctor({
      config: baseConfig,
      runtimeState: {
        googleClientEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
        namedGoogleCredentials: 'missing',
        apiUrl: 'https://sheetflare-api.example.workers.dev',
        adminUrl: null,
        adminBearerToken: null,
        adminUiUsername: null,
        adminUiPassword: null,
        adminApiKey: null,
        privateReadKey: null,
        mutationKey: null
      },
      prereqResults: []
    }, {
      listPagesProjects: vi.fn(async () => []),
      verifyAdminPagesDeployment: vi.fn(async () => {}),
      listDriveWatches: vi.fn(async () => []),
      listDriveWatchRetryAdvice: vi.fn(async () => [])
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'API readiness',
          status: 'blocked',
          summary: 'API /ready reports that neither the default Google credential nor named Google credentials are configured.'
        })
      ])
    );
  });

  it('warns with cooldown guidance instead of immediate retry when retry advice recommends waiting', async () => {
    const results = await runSetupDoctor({
      config: baseConfig,
      runtimeState: {
        googleClientEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
        namedGoogleCredentials: 'missing',
        apiUrl: 'https://sheetflare-api.example.workers.dev',
        adminUrl: 'https://sheetflare-admin.pages.dev',
        adminBearerToken: 'bootstrap.secret',
        adminUiUsername: null,
        adminUiPassword: null,
        adminApiKey: 'sfk_admin.secret',
        privateReadKey: null,
        mutationKey: null
      },
      prereqResults: []
    }, {
      fetchReady: vi.fn(async () => ({
        ok: true,
        checks: {
          defaultGoogleCredential: 'configured' as const,
          namedGoogleCredentials: 'missing' as const,
          googleDriveWebhookSecret: 'configured' as const,
          bootstrapAdmin: 'configured' as const
        },
        notes: []
      })),
      listPagesProjects: vi.fn(async () => []),
      verifyAdminPagesDeployment: vi.fn(async () => {}),
      listDriveWatches: vi.fn(async () => []),
      listDriveWatchRetryAdvice: vi.fn(async (): Promise<SpreadsheetWatchRetryAdvice[]> => [
        {
          spreadsheetId: 'sheet-1',
          status: 'cooldown-recommended',
          currentWatchExpirationAt: null,
          lastKnownStoppedAt: '2026-05-01T12:00:00.000Z',
          lastKnownExpirationAt: '2026-05-02T12:00:00.000Z',
          safeRetryAt: '2026-05-02T12:15:00.000Z',
          note: 'Wait until after the last known watch expiration plus a short grace window before re-registering.',
          projectSlugs: ['sheetflare-prod']
        }
      ])
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Drive watch status',
          status: 'warning',
          summary: expect.stringContaining('cooldown window'),
          remediation: 'Wait until after the reported safe retry time, then run npm run ops:watch:drive.'
        })
      ])
    );
  });
});
