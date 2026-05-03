export type SkippedScenarioReport = {
  status: 'skipped';
  durationMs: 0;
  requestCount: 0;
  successCount: 0;
  failureCount: 0;
  p50Ms: null;
  p95Ms: null;
  maxMs: null;
  notes: string[];
  samples: [];
};

export function buildSkippedScenarioReport(note: string): SkippedScenarioReport {
  return {
    status: 'skipped',
    durationMs: 0,
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    notes: [note],
    samples: []
  };
}
