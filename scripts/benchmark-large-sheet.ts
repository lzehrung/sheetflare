import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { type AdminGetProjectResult } from '@sheetflare/contracts';
import { GoogleSheetsService, type GoogleSheetTableConfig } from '@sheetflare/google-sheets';
import { assertPresent, joinUrl, logStep, logSuccess, requestJson, ScriptError } from './lib/runtime';
import { readBenchmarkConfig } from './lib/benchmark-config';
import { buildBenchmarkRow, chooseBenchmarkFields } from './lib/benchmark-data';
import { summarizeJson, writeReportArtifacts } from './lib/reporting';

type RowEnvelope = {
  id: string;
  rowNumber: number;
  values: Record<string, unknown>;
};

type ListRowsResponse = {
  data: RowEnvelope[];
  nextCursor: string | null;
};

type CacheStatusResponse = {
  data: {
    status: string;
    stale: boolean;
    staleReason: string;
    rowCount: number;
    lastSyncStartedAt: string | null;
    lastSyncCompletedAt: string | null;
    lastSyncError: string | null;
  };
};

type ReindexResponse = {
  ok: true;
  rowCount: number;
  cache: {
    status: string;
    staleReason: string;
  };
};

type AttemptResult = {
  ok: boolean;
  status: number;
  durationMs: number;
  body: unknown;
  rawText: string;
  errorMessage?: string;
};

type ScenarioSample = {
  request: {
    method: 'GET' | 'POST';
    path: string;
    auth: 'private-read' | 'admin';
  };
  response: {
    status: number;
    excerpt: string;
  };
};

type ScenarioReport = {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  notes: string[];
  samples: ScenarioSample[];
};

type BenchmarkReport = {
  kind: 'large-sheet-benchmark';
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  projectSlug: string;
  tableSlug: string;
  spreadsheetId: string;
  sheetTabName: string;
  targetRows: number;
  batchRows: number;
  rowCountBefore: number;
  rowCountAfter: number;
  headers: string[];
  sortField: string;
  containsField: string;
  numericField: string | null;
  seed: {
    status: 'passed' | 'failed';
    durationMs: number;
    clearedRows: number;
    seededRows: number;
    batchCount: number;
    notes: string[];
  };
  reindex: {
    status: 'passed' | 'failed';
    durationMs: number;
    rowCount: number;
    cacheStatus: string;
    staleReason: string;
    notes: string[];
  };
  scenarios: ScenarioReport[];
  failureMessage: string | null;
};

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return Number(sorted[index]!.toFixed(2));
}

function summarizeAttempts(attempts: AttemptResult[]) {
  const durations = attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.durationMs);
  const successCount = attempts.filter((attempt) => attempt.ok).length;
  const failureCount = attempts.length - successCount;

  return {
    requestCount: attempts.length,
    successCount,
    failureCount,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length > 0 ? Number(Math.max(...durations).toFixed(2)) : null
  };
}

async function runConcurrent<T>(
  total: number,
  concurrency: number,
  work: (index: number) => Promise<T>
) {
  const results = new Array<T>(total);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= total) {
        return;
      }

      results[currentIndex] = await work(currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(total, concurrency) }, () => worker())
  );

  return results;
}

async function readResponseBody<T>(response: Response): Promise<{
  rawText: string;
  parsedBody: T | null;
  parseError: string | null;
}> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {
      rawText: text,
      parsedBody: null,
      parseError: null
    };
  }

  try {
    return {
      rawText: text,
      parsedBody: JSON.parse(text) as T,
      parseError: null
    };
  } catch (error) {
    return {
      rawText: text,
      parsedBody: null,
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function timedRequest<T>(options: {
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  bearer?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  expectedStatus?: number;
}) {
  const startedAt = performance.now();
  try {
    const response = await fetch(joinUrl(options.baseUrl, options.path), {
      method: options.method ?? 'GET',
      headers: {
        ...(options.headers ?? {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const payload = await readResponseBody<T>(response);
    return {
      ok: options.expectedStatus !== undefined ? response.status === options.expectedStatus : response.ok,
      status: response.status,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      body: payload.parsedBody,
      rawText: payload.rawText,
      ...(payload.parseError ? { errorMessage: payload.parseError } : {})
    } satisfies AttemptResult;
  } catch (error) {
    return {
      ok: false,
      status: -1,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      body: null,
      rawText: '',
      errorMessage: error instanceof Error ? error.message : String(error)
    } satisfies AttemptResult;
  }
}

function renderBenchmarkReportMarkdown(report: BenchmarkReport) {
  const lines = [
    '# Large Sheet Benchmark Report',
    '',
    `- status: ${report.status}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt}`,
    `- baseUrl: ${report.baseUrl}`,
    `- project: ${report.projectSlug}`,
    `- table: ${report.tableSlug}`,
    `- spreadsheetId: ${report.spreadsheetId}`,
    `- sheetTabName: ${report.sheetTabName}`,
    `- targetRows: ${report.targetRows}`,
    `- rowCountBefore: ${report.rowCountBefore}`,
    `- rowCountAfter: ${report.rowCountAfter}`,
    `- sortField: ${report.sortField}`,
    `- containsField: ${report.containsField}`,
    `- numericField: ${report.numericField ?? 'not selected'}`,
    ''
  ];

  lines.push(
    '## Seed',
    '',
    `- status: ${report.seed.status}`,
    `- durationMs: ${report.seed.durationMs}`,
    `- clearedRows: ${report.seed.clearedRows}`,
    `- seededRows: ${report.seed.seededRows}`,
    `- batchCount: ${report.seed.batchCount}`,
    `- notes: ${report.seed.notes.join('; ') || 'none'}`,
    ''
  );

  lines.push(
    '## Reindex',
    '',
    `- status: ${report.reindex.status}`,
    `- durationMs: ${report.reindex.durationMs}`,
    `- rowCount: ${report.reindex.rowCount}`,
    `- cacheStatus: ${report.reindex.cacheStatus}`,
    `- staleReason: ${report.reindex.staleReason}`,
    `- notes: ${report.reindex.notes.join('; ') || 'none'}`,
    ''
  );

  lines.push(
    '## Scenarios',
    '',
    '| Scenario | Status | Requests | Success | Failure | P50 Ms | P95 Ms | Max Ms | Notes |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  );

  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.name} | ${scenario.status} | ${scenario.requestCount} | ${scenario.successCount} | ${scenario.failureCount} | ${scenario.p50Ms ?? '-'} | ${scenario.p95Ms ?? '-'} | ${scenario.maxMs ?? '-'} | ${scenario.notes.join(' ').replace(/\|/g, '\\|')} |`
    );
  }

  lines.push('', '## Samples', '');
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.name}`, '');
    if (scenario.samples.length === 0) {
      lines.push('- no sample captured', '');
      continue;
    }

    for (const sample of scenario.samples) {
      lines.push(
        `- request: \`${sample.request.method} ${sample.request.path}\` (${sample.request.auth})`,
        `- response status: ${sample.response.status}`,
        '',
        '```json',
        sample.response.excerpt,
        '```',
        ''
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const benchmark = readBenchmarkConfig();
  const startedAt = new Date().toISOString();
  const scenarios: ScenarioReport[] = [];

  const projectResponse = await requestJson<AdminGetProjectResult>({
    baseUrl: benchmark.baseUrl,
    path: `/v1/admin/projects/${encodeURIComponent(benchmark.privateProject)}`,
    bearer: benchmark.adminCredential,
    expectedStatus: 200
  });
  const projectBody = assertPresent(projectResponse.data, 'Admin project lookup returned an empty response body.');
  const project = projectBody.project;
  const table = projectBody.tables.find((entry) => entry.tableSlug === benchmark.privateTable);
  if (!table) {
    throw new ScriptError(`Table ${benchmark.privateTable} was not found in project ${benchmark.privateProject}.`);
  }

  if (table.readOnlyFields.length > 0) {
    throw new ScriptError(
      `Benchmark tables must be fully writable. ${benchmark.privateProject}/${benchmark.privateTable} has read-only columns: ${table.readOnlyFields.join(', ')}.`
    );
  }

  const sheets = new GoogleSheetsService({
    clientEmail: benchmark.googleClientEmail,
    privateKey: benchmark.googlePrivateKey
  });
  const sheetConfig: GoogleSheetTableConfig = {
    ...table,
    spreadsheetId: project.spreadsheetId
  };
  const layout = await sheets.getHeaderLayout(sheetConfig);
  const headers = layout.headers;
  const benchmarkFields = chooseBenchmarkFields(table, headers);

  const cacheBeforeResponse = await requestJson<CacheStatusResponse>({
    baseUrl: benchmark.baseUrl,
    path: `/v1/admin/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/cache`,
    bearer: benchmark.adminCredential,
    expectedStatus: 200
  });
  const cacheBefore = assertPresent(cacheBeforeResponse.data, 'Cache status returned an empty response body.');

  const report: BenchmarkReport = {
    kind: 'large-sheet-benchmark',
    status: 'failed',
    startedAt,
    finishedAt: startedAt,
    baseUrl: benchmark.baseUrl,
    projectSlug: benchmark.privateProject,
    tableSlug: benchmark.privateTable,
    spreadsheetId: project.spreadsheetId,
    sheetTabName: table.sheetTabName,
    targetRows: benchmark.targetRows,
    batchRows: benchmark.batchRows,
    rowCountBefore: cacheBefore.data.rowCount,
    rowCountAfter: cacheBefore.data.rowCount,
    headers,
    sortField: benchmarkFields.sortField,
    containsField: benchmarkFields.containsField,
    numericField: benchmarkFields.numericField,
    seed: {
      status: 'failed',
      durationMs: 0,
      clearedRows: 0,
      seededRows: 0,
      batchCount: 0,
      notes: []
    },
    reindex: {
      status: 'failed',
      durationMs: 0,
      rowCount: cacheBefore.data.rowCount,
      cacheStatus: cacheBefore.data.status,
      staleReason: cacheBefore.data.staleReason,
      notes: []
    },
    scenarios,
    failureMessage: null
  };

  let clearedRows = 0;
  let seededRows = 0;
  let batchCount = 0;
  let seedNotes: string[] = [];
  let observedPointReadRowId: string | null = null;

  async function runScenario(
    name: string,
    work: () => Promise<Omit<ScenarioReport, 'name'>>
  ) {
    logStep(name);
    const result = await work();
    scenarios.push({
      name,
      ...result
    });
    if (result.status === 'passed') {
      logSuccess(`${name} complete.`);
    }
    return result;
  }

  async function getCacheStatus() {
    const response = await requestJson<CacheStatusResponse>({
      baseUrl: benchmark.baseUrl,
      path: `/v1/admin/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/cache`,
      bearer: benchmark.adminCredential,
      expectedStatus: 200
    });
    return assertPresent(response.data, 'Cache status returned an empty response body.');
  }

  try {
    const seedScenario = await runScenario('Seed the benchmark sheet', async () => {
      const startedAtMs = performance.now();
      const currentRows = cacheBefore.data.rowCount;
      clearedRows = 0;
      seededRows = 0;
      batchCount = 0;
      seedNotes = [];

      if (currentRows > benchmark.targetRows) {
        const clearStartRow = table.dataStartRow + benchmark.targetRows;
        const clearEndRow = table.dataStartRow + currentRows - 1;
        logStep(`Clearing ${currentRows - benchmark.targetRows} excess data rows before reseeding.`);
        await sheets.clearRowsRange(sheetConfig, clearStartRow, clearEndRow, headers.length);
        clearedRows = currentRows - benchmark.targetRows;
      }

      const rowsToWrite = Math.max(benchmark.targetRows - currentRows, 0);
      if (rowsToWrite > 0) {
        const firstRowIndex = currentRows + 1;
        seedNotes.push(`writing ${rowsToWrite} new rows`);
        for (let offset = 0; offset < rowsToWrite; offset += benchmark.batchRows) {
          const chunkSize = Math.min(benchmark.batchRows, rowsToWrite - offset);
          const chunkStartIndex = firstRowIndex + offset;
          const chunk = Array.from({ length: chunkSize }, (_, index) =>
            buildBenchmarkRow(headers, chunkStartIndex + index, {
              idColumn: table.idColumn,
              readOnlyFields: table.readOnlyFields,
              fieldRules: table.fieldRules
            })
          );
          await sheets.writeRowsBatch(sheetConfig, headers, chunk, table.dataStartRow + currentRows + offset);
          batchCount += 1;
          seededRows += chunk.length;
        }
      } else {
        seedNotes.push('existing cache already met the requested row target');
      }

      return {
        status: 'passed' as const,
        durationMs: Number((performance.now() - startedAtMs).toFixed(2)),
        requestCount: batchCount + (clearedRows > 0 ? 1 : 0),
        successCount: batchCount + (clearedRows > 0 ? 1 : 0),
        failureCount: 0,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
        notes: [
          `currentRows=${currentRows}`,
          `targetRows=${benchmark.targetRows}`,
          `batchRows=${benchmark.batchRows}`,
          ...seedNotes
        ],
        samples: []
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    report.seed = {
      status: seedScenario.status === 'passed' ? 'passed' : 'failed',
      durationMs: seedScenario.durationMs,
      clearedRows,
      seededRows,
      batchCount,
      notes: seedScenario.notes
    };

    const reindexStartedAt = performance.now();
    const reindexAttempt = await timedRequest<ReindexResponse>({
      baseUrl: benchmark.baseUrl,
      path: `/v1/admin/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/reindex`,
      method: 'POST',
      bearer: benchmark.adminCredential,
      expectedStatus: 200
    });
    const cacheAfterReindex = await getCacheStatus();
    const reindexResponse = reindexAttempt.ok
      ? assertPresent(reindexAttempt.body, 'Reindex response returned no JSON body.')
      : null;
    report.reindex = {
      status: reindexAttempt.ok ? 'passed' : 'failed',
      durationMs: Number((performance.now() - reindexStartedAt).toFixed(2)),
      rowCount: cacheAfterReindex.data.rowCount,
      cacheStatus: cacheAfterReindex.data.status,
      staleReason: cacheAfterReindex.data.staleReason,
      notes: [
        `reindexResponseRowCount=${reindexResponse ? reindexResponse.rowCount : 'unknown'}`
      ]
    };
    report.rowCountAfter = cacheAfterReindex.data.rowCount;

    if (cacheAfterReindex.data.rowCount !== benchmark.targetRows) {
      throw new ScriptError(
        `Benchmark cache row count mismatch after reindex. Expected ${benchmark.targetRows}, received ${cacheAfterReindex.data.rowCount}.`
      );
    }

    await runScenario('Indexed list queries on the large table', async () => {
      const path = `/v1/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/rows?limit=25&sort=${encodeURIComponent(`${benchmarkFields.sortField}:asc`)}`;
      const warmup = await requestJson<ListRowsResponse>({
        baseUrl: benchmark.baseUrl,
        path,
        bearer: benchmark.privateReadKey,
        expectedStatus: 200
      });
      const warmupBody = assertPresent(warmup.data, 'Indexed list warmup returned an empty response body.');
      observedPointReadRowId = assertPresent(
        warmupBody.data[0]?.id,
        'Indexed warmup did not return a row id for point-read validation.'
      );
      const startedAtMs = performance.now();
      const attempts = await runConcurrent(60, 6, async () =>
        timedRequest<ListRowsResponse>({
          baseUrl: benchmark.baseUrl,
          path,
          bearer: benchmark.privateReadKey,
          expectedStatus: 200
        })
      );
      return {
        status: attempts.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number((performance.now() - startedAtMs).toFixed(2)),
        ...summarizeAttempts(attempts),
        notes: [`sort=${benchmarkFields.sortField}:asc`, `rowsPerPage=${warmupBody.data.length}`],
        samples: [
          {
            request: {
              method: 'GET',
              path,
              auth: 'private-read'
            },
            response: {
              status: warmup.response.status,
              excerpt: summarizeJson(warmupBody)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    await runScenario('Point reads after the TTL becomes stale', async () => {
      const rowId = assertPresent(observedPointReadRowId, 'Indexed warmup did not return a row id for point-read validation.');
      const path = `/v1/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/rows/${encodeURIComponent(rowId)}`;

      logStep(`Waiting ${benchmark.staleWaitMs}ms so point reads execute after TTL expiry assumptions.`);
      await delay(benchmark.staleWaitMs);

      const startedAtMs = performance.now();
      const attempts = await runConcurrent(30, 3, async () =>
        timedRequest<{ data: RowEnvelope }>({
          baseUrl: benchmark.baseUrl,
          path,
          bearer: benchmark.privateReadKey,
          expectedStatus: 200
        })
      );

      return {
        status: attempts.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number((performance.now() - startedAtMs).toFixed(2)),
        ...summarizeAttempts(attempts),
        notes: [`staleWaitMs=${benchmark.staleWaitMs}`],
        samples: [
          {
            request: {
              method: 'GET',
              path,
              auth: 'private-read'
            },
            response: {
              status: attempts[0]?.status ?? 0,
              excerpt: summarizeJson(attempts[0]?.body ?? attempts[0]?.rawText ?? null)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    await runScenario('Contains rejection on the large table', async () => {
      const path = `/v1/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/rows?filter=${encodeURIComponent(JSON.stringify({
        [benchmarkFields.containsField]: {
          contains: 'needle-'
        }
      }))}`;
      const attempt = await timedRequest<Record<string, unknown>>({
        baseUrl: benchmark.baseUrl,
        path,
        bearer: benchmark.privateReadKey,
        expectedStatus: 400
      });

      return {
        status: attempt.ok ? 'passed' : 'failed',
        durationMs: attempt.durationMs,
        requestCount: 1,
        successCount: attempt.ok ? 1 : 0,
        failureCount: attempt.ok ? 0 : 1,
        p50Ms: attempt.ok ? attempt.durationMs : null,
        p95Ms: attempt.ok ? attempt.durationMs : null,
        maxMs: attempt.ok ? attempt.durationMs : null,
        notes: ['full-scan rejection is the desired outcome on the large table'],
        samples: [
          {
            request: {
              method: 'GET',
              path,
              auth: 'private-read'
            },
            response: {
              status: attempt.status,
              excerpt: summarizeJson(attempt.body)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    await runScenario('Reindex while reads continue', async () => {
      const startedAtMs = performance.now();
      const path = `/v1/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/rows?limit=25&sort=${encodeURIComponent(`${benchmarkFields.sortField}:asc`)}`;
      const readPromise = runConcurrent(40, 4, async () =>
        timedRequest<ListRowsResponse>({
          baseUrl: benchmark.baseUrl,
          path,
          bearer: benchmark.privateReadKey,
          expectedStatus: 200
        })
      );

      await delay(100);
      const reindexAttempt = await timedRequest<ReindexResponse>({
        baseUrl: benchmark.baseUrl,
        path: `/v1/admin/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/reindex`,
        method: 'POST',
        bearer: benchmark.adminCredential,
        expectedStatus: 200
      });
      const readAttempts = await readPromise;
      const combined = [...readAttempts, reindexAttempt];

      return {
        status: combined.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number((performance.now() - startedAtMs).toFixed(2)),
        ...summarizeAttempts(combined),
        notes: [`reindexDurationMs=${reindexAttempt.durationMs}`],
        samples: [
          {
            request: {
              method: 'POST',
              path: `/v1/admin/projects/${encodeURIComponent(benchmark.privateProject)}/tables/${encodeURIComponent(benchmark.privateTable)}/reindex`,
              auth: 'admin'
            },
            response: {
              status: reindexAttempt.status,
              excerpt: summarizeJson(reindexAttempt.body ?? reindexAttempt.rawText ?? null)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    report.status = scenarios.every((scenario) => scenario.status !== 'failed') && report.reindex.status === 'passed'
      ? 'passed'
      : 'failed';
    report.finishedAt = new Date().toISOString();

    if (report.status === 'passed') {
      console.log('\n[done] benchmark checks passed');
    } else {
      throw new ScriptError('One or more benchmark scenarios failed.');
    }
  } catch (error) {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    report.failureMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    const artifactPaths = await writeReportArtifacts(
      benchmark.reportPath,
      renderBenchmarkReportMarkdown(report),
      report
    );
    console.log(`[report] wrote ${artifactPaths.markdownPath}`);
    console.log(`[report] wrote ${artifactPaths.jsonPath}`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof ScriptError || error instanceof Error ? error.message : String(error);
  console.error(`\n[failed] ${message}`);
  process.exit(1);
});
