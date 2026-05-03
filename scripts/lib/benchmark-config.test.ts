import { describe, expect, it } from 'vitest';
import { readBenchmarkConfig } from './benchmark-config';

describe('readBenchmarkConfig', () => {
  const baseEnv = {
    SHEETFLARE_BASE_URL: 'https://example.workers.dev',
    SHEETFLARE_ADMIN_CREDENTIAL: 'sfk_admin.secret',
    SHEETFLARE_PRIVATE_PROJECT: 'private-demo',
    SHEETFLARE_PRIVATE_TABLE: 'users',
    SHEETFLARE_PRIVATE_READ_KEY: 'sfk_private.secret',
    SHEETFLARE_BENCHMARK_REPORT_PATH: 'reports/benchmark.md',
    SHEETFLARE_BENCHMARK_STALE_WAIT_MS: '16000',
    GOOGLE_CLIENT_EMAIL: 'service-account@example.com',
    GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n'
  } satisfies NodeJS.ProcessEnv;

  it('uses the default large-sheet target and batch size', () => {
    expect(readBenchmarkConfig(baseEnv)).toMatchObject({
      reportPath: 'reports/benchmark.md',
      targetRows: 500_000,
      batchRows: 1_000,
      staleWaitMs: 16_000
    });
  });

  it('accepts explicit row and batch overrides', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_BENCHMARK_TARGET_ROWS: '250000',
      SHEETFLARE_BENCHMARK_BATCH_ROWS: '500',
      SHEETFLARE_BENCHMARK_STALE_WAIT_MS: '9000'
    } satisfies NodeJS.ProcessEnv;

    expect(readBenchmarkConfig(env)).toMatchObject({
      targetRows: 250_000,
      batchRows: 500,
      staleWaitMs: 9_000
    });
  });

  it('rejects invalid positive integer overrides', () => {
    const env = {
      ...baseEnv,
      SHEETFLARE_BENCHMARK_TARGET_ROWS: '0'
    } satisfies NodeJS.ProcessEnv;

    expect(() => readBenchmarkConfig(env)).toThrow(
      'SHEETFLARE_BENCHMARK_TARGET_ROWS must be a positive integer when provided.'
    );
  });
});
