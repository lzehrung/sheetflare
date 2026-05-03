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

export type FailedScenarioReport = {
  status: 'failed';
  durationMs: number;
  requestCount: 0;
  successCount: 0;
  failureCount: 1;
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

export function buildFailedScenarioReport(error: unknown, durationMs: number): FailedScenarioReport {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'failed',
    durationMs,
    requestCount: 0,
    successCount: 0,
    failureCount: 1,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    notes: [`error=${message}`],
    samples: []
  };
}
