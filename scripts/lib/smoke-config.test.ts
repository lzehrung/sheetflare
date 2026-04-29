import { describe, expect, it } from 'vitest';
import { readSmokeConfig } from './smoke-config';

describe('readSmokeConfig', () => {
  const baseEnv = {
    SHEETFLARE_BASE_URL: 'https://example.workers.dev',
    SHEETFLARE_ADMIN_CREDENTIAL: 'sfk_admin.secret',
    SHEETFLARE_PRIVATE_PROJECT: 'private-demo',
    SHEETFLARE_PRIVATE_TABLE: 'users',
    SHEETFLARE_PRIVATE_READ_KEY: 'sfk_private.secret',
    SHEETFLARE_MUTATION_KEY: 'sfk_mutation.secret',
    SHEETFLARE_SMOKE_CREATE_VALUES_JSON: '{"name":"Smoke"}',
    SHEETFLARE_SMOKE_UPDATE_VALUES_JSON: '{"status":"active"}'
  } satisfies NodeJS.ProcessEnv;

  it('prefers the generic admin credential env var', () => {
    expect(readSmokeConfig(baseEnv)).toMatchObject({
      adminCredential: 'sfk_admin.secret',
      idColumn: '_id'
    });
  });

  it('falls back to the legacy bootstrap env var', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_ADMIN_CREDENTIAL: undefined,
      SHEETFLARE_ADMIN_BEARER: 'legacy-token'
    } satisfies NodeJS.ProcessEnv;

    expect(readSmokeConfig(env)).toMatchObject({
      adminCredential: 'legacy-token'
    });
  });

  it('rejects a blank managed id column override', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_SMOKE_ID_COLUMN: '   '
    } satisfies NodeJS.ProcessEnv;

    expect(() => readSmokeConfig(env)).toThrow(
      'SHEETFLARE_SMOKE_ID_COLUMN must not be blank when provided.'
    );
  });

  it('allows private-only smoke coverage when no public-read project is configured', () => {
    expect(readSmokeConfig(baseEnv)).toMatchObject({
      publicProject: null,
      publicTable: null
    });
  });

  it('requires public project and table together when enabling public-read coverage', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_PUBLIC_PROJECT: 'public-demo'
    } satisfies NodeJS.ProcessEnv;

    expect(() => readSmokeConfig(env)).toThrow(
      'SHEETFLARE_PUBLIC_PROJECT and SHEETFLARE_PUBLIC_TABLE must be set together when public-read coverage is enabled.'
    );
  });
});
