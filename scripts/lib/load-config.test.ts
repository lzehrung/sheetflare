import { describe, expect, it } from 'vitest';
import { readLoadConfig } from './load-config';

describe('readLoadConfig', () => {
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

  it('derives the default indexed sort from the managed id column', () => {
    expect(readLoadConfig(baseEnv)).toMatchObject({
      indexedListSort: '_id:asc',
      staleWaitMs: 16000
    });
  });

  it('accepts explicit load overrides and report path', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_SMOKE_ID_COLUMN: 'managed_id',
      SHEETFLARE_LOAD_SORT: 'status:asc',
      SHEETFLARE_LOAD_REPORT_PATH: 'reports/load-report.md',
      SHEETFLARE_LOAD_MUTATION_CYCLES: '5'
    } satisfies NodeJS.ProcessEnv;

    expect(readLoadConfig(env)).toMatchObject({
      indexedListSort: 'status:asc',
      reportPath: 'reports/load-report.md',
      mutationCycles: 5
    });
  });

  it('rejects invalid positive integer overrides', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_LOAD_INDEXED_LIST_REQUESTS: '0'
    } satisfies NodeJS.ProcessEnv;

    expect(() => readLoadConfig(env)).toThrow(
      'SHEETFLARE_LOAD_INDEXED_LIST_REQUESTS must be a positive integer when provided.'
    );
  });

  it('has no synthetic-principal knobs, because the Worker rate-limits by cf-connecting-ip and ignores x-forwarded-for', () => {
    const config = readLoadConfig({
      ...baseEnv,
      SHEETFLARE_LOAD_RATE_LIMIT_PRINCIPAL_COUNT: '25',
      SHEETFLARE_LOAD_RATE_LIMIT_REQUESTS_PER_PRINCIPAL: '3'
    });

    expect(config).toHaveProperty('rateLimitSamePrincipalRequests', 400);
    expect(config).not.toHaveProperty('rateLimitPrincipalCount');
    expect(config).not.toHaveProperty('rateLimitRequestsPerPrincipal');
  });
});
