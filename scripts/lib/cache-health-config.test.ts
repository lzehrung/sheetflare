import { describe, expect, it } from 'vitest';
import { readCacheHealthConfig } from './cache-health-config';

describe('readCacheHealthConfig', () => {
  const baseEnv = {
    SHEETFLARE_BASE_URL: 'https://example.workers.dev',
    SHEETFLARE_ADMIN_CREDENTIAL: 'sfk_admin.secret',
    SHEETFLARE_CACHE_HEALTH_TABLES_JSON: '[{"project":"demo","table":"users"}]'
  } satisfies NodeJS.ProcessEnv;

  it('parses targets and optional report path', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_CACHE_HEALTH_REPORT_PATH: 'reports/cache-health.md'
    } satisfies NodeJS.ProcessEnv;

    expect(readCacheHealthConfig(env)).toMatchObject({
      reportPath: 'reports/cache-health.md',
      targets: [{ project: 'demo', table: 'users' }]
    });
  });

  it('rejects empty target arrays', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_CACHE_HEALTH_TABLES_JSON: '[]'
    } satisfies NodeJS.ProcessEnv;

    expect(() => readCacheHealthConfig(env)).toThrow(
      'SHEETFLARE_CACHE_HEALTH_TABLES_JSON must contain at least one target.'
    );
  });
});
