import type { SetupConfig } from './setup-config';
import { describe, expect, it, vi } from 'vitest';
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

describe('runSetupDoctor', () => {
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
      ])
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
      listDriveWatches: vi.fn(async () => [])
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
      ])
    });

    expect(results.every((result) => result.status === 'ready')).toBe(true);
  });
});
