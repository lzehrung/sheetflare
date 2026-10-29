import { describe, expect, it } from 'vitest';
import {
  createBootstrapCommandOptions,
  createBootstrapConfigFromSetup,
  createBootstrapEnv,
  findCreatedKey,
  findCreatedKeyIfPresent,
  parseBootstrapOutput,
  readBootstrapCommandResult,
  redactBootstrapResultMarker
} from './setup-bootstrap';
import type { SetupConfig } from './setup-config';

const baseConfig: SetupConfig = {
  profile: 'production',
  adminUi: 'enabled',
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

  it('does not request key rotation unless asked', () => {
    expect(createBootstrapEnv(baseConfig, 'https://example.com', 'sfk_admin.secret').SHEETFLARE_BOOTSTRAP_ROTATE_KEYS).toBe('false');
    expect(createBootstrapEnv(baseConfig, 'https://example.com', 'sfk_admin.secret', { rotateKeys: true }).SHEETFLARE_BOOTSTRAP_ROTATE_KEYS).toBe('true');
  });

  it('forces the child rotate flag off when the parent process inherited true', () => {
    const previous = process.env.SHEETFLARE_BOOTSTRAP_ROTATE_KEYS;
    process.env.SHEETFLARE_BOOTSTRAP_ROTATE_KEYS = 'true';
    try {
      const env = createBootstrapEnv(baseConfig, 'https://example.com', 'sfk_admin.secret');
      expect({ ...process.env, ...env }.SHEETFLARE_BOOTSTRAP_ROTATE_KEYS).toBe('false');
    } finally {
      if (previous === undefined) {
        delete process.env.SHEETFLARE_BOOTSTRAP_ROTATE_KEYS;
      } else {
        process.env.SHEETFLARE_BOOTSTRAP_ROTATE_KEYS = previous;
      }
    }
  });

  it('parses keys the bootstrap skipped or revoked, and treats missing ones as absent rather than created', () => {
    const output = parseBootstrapOutput(`__SHEETFLARE_BOOTSTRAP_RESULT__={"projects":[],"apiKeys":[],"skippedKeys":[{"name":"demo-read","id":"key-1"}],"revokedKeys":[{"name":"demo-write","id":"key-2"}]}\n`);

    expect(output.skippedKeys).toEqual([{ name: 'demo-read', id: 'key-1' }]);
    expect(output.revokedKeys).toEqual([{ name: 'demo-write', id: 'key-2' }]);
    expect(findCreatedKeyIfPresent(output, 'demo-read')).toBeNull();
    expect(() => findCreatedKey(output, 'demo-read')).toThrow('expected API key demo-read');
  });

  it('collects minted keys from a failed bootstrap subprocess and still reports failure', () => {
    const outcome = readBootstrapCommandResult({
      code: 1,
      stdout: [
        'noise',
        '__SHEETFLARE_BOOTSTRAP_RESULT__={"projects":[],"apiKeys":[{"apiKey":"sfk_partial.secret","record":{"id":"key-1","name":"demo-read","projectSlug":"demo","scopes":["table:read"]}}],"skippedKeys":[],"revokedKeys":[]}',
        ''
      ].join('\n')
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failureMessage).toContain('Bootstrap failed');
    expect(outcome.output?.apiKeys.map((entry) => entry.apiKey)).toEqual(['sfk_partial.secret']);
  });

  it('defaults skipped and revoked keys to empty for older bootstrap output', () => {
    const output = parseBootstrapOutput(`__SHEETFLARE_BOOTSTRAP_RESULT__={"projects":[],"apiKeys":[]}\n`);

    expect(output.skippedKeys).toEqual([]);
    expect(output.revokedKeys).toEqual([]);
  });
});
