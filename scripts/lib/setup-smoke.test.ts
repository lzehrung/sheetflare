import { describe, expect, it } from 'vitest';
import { createSmokeEnv } from './setup-smoke';
import type { SetupConfig } from './setup-config';
import { ScriptError } from './runtime';

const privateConfig: SetupConfig = {
  profile: 'local',
  deploy: {
    api: true,
    admin: false
  },
  privateProject: {
    slug: 'demo',
    name: 'Demo',
    spreadsheetId: 'sheet-1',
    tables: [
      {
        tableSlug: 'users',
        sheetTabName: 'Users',
        idColumn: '_id'
      }
    ]
  },
  publicReadProject: null,
  smoke: {
    enabled: true,
    privateTableSlug: 'users',
    publicTableSlug: null,
    adminKeyName: 'demo-admin',
    privateReadKeyName: 'demo-read',
    mutationKeyName: 'demo-mutation',
    createValues: {
      name: 'Smoke'
    },
    updateValues: {
      name: 'Smoke Updated'
    }
  }
};

describe('createSmokeEnv', () => {
  it('creates a private-only smoke environment', () => {
    expect(createSmokeEnv({
      config: privateConfig,
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toMatchObject({
      SHEETFLARE_PRIVATE_PROJECT: 'demo',
      SHEETFLARE_PRIVATE_TABLE: 'users',
      SHEETFLARE_SMOKE_ID_COLUMN: '_id'
    });
  });

  it('adds public-read smoke coverage when configured', () => {
    expect(createSmokeEnv({
      config: {
        ...privateConfig,
        publicReadProject: {
          slug: 'demo-public',
          name: 'Demo Public',
          spreadsheetId: 'sheet-1',
          tables: [
            {
              tableSlug: 'users',
              sheetTabName: 'Users'
            }
          ]
        },
        smoke: {
          ...privateConfig.smoke,
          publicTableSlug: 'users'
        }
      },
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toMatchObject({
      SHEETFLARE_PUBLIC_PROJECT: 'demo-public',
      SHEETFLARE_PUBLIC_TABLE: 'users'
    });
  });

  it('throws a ScriptError when the configured private smoke table is missing', () => {
    expect(() => createSmokeEnv({
      config: {
        ...privateConfig,
        smoke: {
          ...privateConfig.smoke,
          privateTableSlug: 'missing-table'
        }
      },
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toThrow(ScriptError);

    expect(() => createSmokeEnv({
      config: {
        ...privateConfig,
        smoke: {
          ...privateConfig.smoke,
          privateTableSlug: 'missing-table'
        }
      },
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toThrow('Private table missing-table was not found in setup config.');
  });
});
