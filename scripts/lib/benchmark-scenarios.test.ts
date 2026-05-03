import { describe, expect, it } from 'vitest';
import { buildSkippedScenarioReport } from './benchmark-scenarios';

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
