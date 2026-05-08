import { describe, expect, it } from 'vitest';
import {
  createBootstrapCommandOptions,
  createBootstrapConfigFromSetup,
  createBootstrapEnv,
  findCreatedKey,
  parseBootstrapOutput,
  redactBootstrapResultMarker
} from './setup-bootstrap';
import type { SetupConfig } from './setup-config';

const baseConfig: SetupConfig = {
  profile: 'local',
  deploy: {
    api: true,
    admin: true
  },
  privateProject: {
    slug: 'demo',
    name: 'Demo',
    spreadsheetId: 'sheet-1',
    googleCredentialRef: 'default',
    tables: [
      {
        tableSlug: 'users',
        sheetTabName: 'Users',
        idColumn: '_id',
        indexedFields: ['email']
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

describe('createBootstrapConfigFromSetup', () => {
  it('creates private and smoke key bootstrap inputs', () => {
    expect(createBootstrapConfigFromSetup(baseConfig)).toEqual({
      projects: [
        {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'default',
          defaultAuthMode: 'private',
          tables: [
            {
              tableSlug: 'users',
              sheetTabName: 'Users',
              idColumn: '_id',
              indexedFields: ['email']
            }
          ]
        }
      ],
      apiKeys: [
        {
          name: 'demo-admin',
          scopes: ['admin:projects', 'admin:keys', 'table:read', 'table:create', 'table:update', 'table:delete']
        },
        {
          name: 'demo-read',
          projectSlug: 'demo',
          scopes: ['table:read']
        },
        {
          name: 'demo-mutation',
          projectSlug: 'demo',
          scopes: ['table:read', 'table:create', 'table:update', 'table:delete']
        }
      ]
    });
  });

  it('includes an optional public-read project when configured', () => {
    expect(createBootstrapConfigFromSetup({
      ...baseConfig,
      publicReadProject: {
        slug: 'demo-public',
        name: 'Demo Public',
        spreadsheetId: 'sheet-1',
        googleCredentialRef: 'default',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      smoke: {
        ...baseConfig.smoke,
        publicTableSlug: 'users'
      }
    }).projects[1]).toMatchObject({
      slug: 'demo-public',
      defaultAuthMode: 'public-read'
    });
  });

  it('omits generated smoke keys when smoke is disabled', () => {
    expect(createBootstrapConfigFromSetup({
      ...baseConfig,
      smoke: {
        ...baseConfig.smoke,
        enabled: false
      }
    }).apiKeys).toEqual([]);
  });
});

describe('bootstrap output parsing', () => {
  it('parses the bootstrap marker line and finds created keys', () => {
    const output = parseBootstrapOutput(`noise\n__SHEETFLARE_BOOTSTRAP_RESULT__={"projects":[],"apiKeys":[{"apiKey":"sfk_value.secret","record":{"id":"key-1","name":"demo-read","projectSlug":"demo","scopes":["table:read"]}}]}\n`);

    expect(findCreatedKey(output, 'demo-read')).toBe('sfk_value.secret');
  });

  it('redacts bootstrap result marker lines before echoing captured output', () => {
    expect(redactBootstrapResultMarker([
      'before',
      '__SHEETFLARE_BOOTSTRAP_RESULT__={"projects":[],"apiKeys":[{"apiKey":"sfk_value.secret","record":{"id":"key-1","name":"demo-read","projectSlug":"demo","scopes":["table:read"]}}]}',
      'after'
    ].join('\n'))).toBe([
      'before',
      'after'
    ].join('\n'));
  });

  it('adds the full-result mode flag for setup-driven bootstrap runs', () => {
    expect(createBootstrapEnv(baseConfig, 'https://example.com', 'sfk_admin.secret')).toMatchObject({
      SHEETFLARE_BOOTSTRAP_RESULT_MODE: 'full'
    });
  });

  it('disables bootstrap stdout and stderr echo so secret-bearing result markers stay local', () => {
    const env = createBootstrapEnv(baseConfig, 'https://example.com', 'sfk_admin.secret');
    expect(createBootstrapCommandOptions(env)).toMatchObject({
      env,
      echoStdout: false,
      echoStderr: false
    });
  });
});
