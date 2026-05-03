import { describe, expect, it } from 'vitest';
import { buildFailedScenarioReport, buildSkippedScenarioReport } from './benchmark-scenarios';

describe('buildSkippedScenarioReport', () => {
  it('returns a skipped scenario summary with no requests', () => {
    expect(buildSkippedScenarioReport('staleWaitMs=0')).toEqual({
      status: 'skipped',
      durationMs: 0,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      notes: ['staleWaitMs=0'],
      samples: []
    });
  });
});

describe('buildFailedScenarioReport', () => {
  it('returns a failed scenario summary with the error message', () => {
    expect(buildFailedScenarioReport(new Error('seed failed'), 12.34)).toEqual({
      status: 'failed',
      durationMs: 12.34,
      requestCount: 0,
      successCount: 0,
      failureCount: 1,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      notes: ['error=seed failed'],
      samples: []
    });
  });
});
