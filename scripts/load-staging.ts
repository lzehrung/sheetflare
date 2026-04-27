import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPresent, getEnv, logStep, logSuccess, requestJson, ScriptError } from './lib/runtime';
import { summarizeJson, writeReportArtifacts } from './lib/reporting';
import { readLoadConfig } from './lib/load-config';

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

type CreateRowResponse = {
  data: RowEnvelope;
  ignoredKeys: string[];
};

type DeleteRowResponse = {
  ok: true;
  deletedId: string;
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
  errorMessage?: string;
};

type ScenarioSample = {
  request: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    auth: 'anonymous' | 'admin' | 'private-read' | 'mutation';
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

type LoadReport = {
  kind: 'staging-load';
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  privateTable: string;
  publicTable: string;
  rowCountBefore: number | null;
  rowCountAfter: number | null;
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

async function timedRequest<T>(options: Parameters<typeof requestJson<T>>[0]) {
  const startedAt = performance.now();
  try {
    const result = await requestJson<T>(options);
    return {
      ok: options.expectedStatus === undefined || result.response.status === options.expectedStatus,
      status: result.response.status,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      body: result.data
    } satisfies AttemptResult;
  } catch (error) {
    return {
      ok: false,
      status: -1,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      body: null,
      errorMessage: error instanceof Error ? error.message : String(error)
    } satisfies AttemptResult;
  }
}

function renderLoadReportMarkdown(report: LoadReport) {
  const lines = [
    '# Staging Load Report',
    '',
    `- status: ${report.status}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt}`,
    `- baseUrl: ${report.baseUrl}`,
    `- privateTable: ${report.privateTable}`,
    `- publicTable: ${report.publicTable}`,
    `- rowCountBefore: ${report.rowCountBefore ?? 'unknown'}`,
    `- rowCountAfter: ${report.rowCountAfter ?? 'unknown'}`,
    ''
  ];

  if (report.failureMessage) {
    lines.push(`- failure: ${report.failureMessage}`, '');
  }

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
  const config = readLoadConfig();
  const reportPath = config.reportPath ?? getEnv('SHEETFLARE_LOAD_REPORT_PATH');
  const startedAt = new Date().toISOString();
  const scenarios: ScenarioReport[] = [];

  const report: LoadReport = {
    kind: 'staging-load',
    status: 'failed',
    startedAt,
    finishedAt: startedAt,
    baseUrl: config.baseUrl,
    privateTable: `${config.privateProject}/${config.privateTable}`,
    publicTable: `${config.publicProject}/${config.publicTable}`,
    rowCountBefore: null,
    rowCountAfter: null,
    scenarios,
    failureMessage: null
  };

  async function getCacheStatus() {
    const response = await requestJson<CacheStatusResponse>({
      baseUrl: config.baseUrl,
      path: `/v1/admin/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/cache`,
      bearer: config.adminCredential,
      expectedStatus: 200
    });
    return assertPresent(response.data, 'Cache status returned an empty response body.');
  }

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

  const createdIds = new Set<string>();

  async function createBenchmarkRow(prefix: string) {
    const rowId = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const response = await requestJson<CreateRowResponse>({
      baseUrl: config.baseUrl,
      path: `/v1/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/rows`,
      method: 'POST',
      bearer: config.mutationKey,
      expectedStatus: 201,
      body: {
        values: {
          ...config.createValues,
          [config.idColumn]: rowId
        }
      }
    });
    createdIds.add(rowId);
    return {
      rowId,
      response: assertPresent(response.data, 'Benchmark create returned an empty response body.'),
      status: response.response.status
    };
  }

  async function deleteBenchmarkRow(rowId: string) {
    const response = await requestJson<DeleteRowResponse>({
      baseUrl: config.baseUrl,
      path: `/v1/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/rows/${encodeURIComponent(rowId)}`,
      method: 'DELETE',
      bearer: config.mutationKey,
      expectedStatus: 200
    });
    createdIds.delete(rowId);
    return {
      status: response.response.status,
      body: assertPresent(response.data, 'Benchmark delete returned an empty response body.')
    };
  }

  try {
    report.rowCountBefore = (await getCacheStatus()).data.rowCount;

    await runScenario('Indexed list queries on a hot table', async () => {
      const path = `/v1/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/rows?limit=25&sort=${encodeURIComponent(config.indexedListSort)}`;
      const warmup = await requestJson<ListRowsResponse>({
        baseUrl: config.baseUrl,
        path,
        bearer: config.privateReadKey,
        expectedStatus: 200
      });
      const warmupBody = assertPresent(warmup.data, 'Indexed list warmup returned an empty response body.');
      const startedAtMs = performance.now();
      const attempts = await runConcurrent(config.indexedListRequests, config.indexedListConcurrency, async () =>
        timedRequest<ListRowsResponse>({
          baseUrl: config.baseUrl,
          path,
          bearer: config.privateReadKey,
          expectedStatus: 200
        })
      );
      return {
        status: attempts.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number((performance.now() - startedAtMs).toFixed(2)),
        ...summarizeAttempts(attempts),
        notes: [`sort=${config.indexedListSort}`, `rowsPerPage=${warmupBody.data.length}`],
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
      const created = await createBenchmarkRow('load-read');
      const path = `/v1/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/rows/${encodeURIComponent(created.rowId)}`;

      logStep(`Waiting ${config.staleWaitMs}ms so point reads execute after TTL expiry assumptions.`);
      await delay(config.staleWaitMs);

      const startedAtMs = performance.now();
      const attempts = await runConcurrent(config.pointReadRequests, config.pointReadConcurrency, async () =>
        timedRequest<{ data: RowEnvelope }>({
          baseUrl: config.baseUrl,
          path,
          bearer: config.privateReadKey,
          expectedStatus: 200
        })
      );
      const cleanup = await deleteBenchmarkRow(created.rowId);

      return {
        status: attempts.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number((performance.now() - startedAtMs).toFixed(2)),
        ...summarizeAttempts(attempts),
        notes: [
          `staleWaitMs=${config.staleWaitMs}`,
          `cleanupStatus=${cleanup.status}`
        ],
        samples: [
          {
            request: {
              method: 'GET',
              path,
              auth: 'private-read'
            },
            response: {
              status: created.status,
              excerpt: summarizeJson(created.response)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    await runScenario('Mixed create update delete cycles', async () => {
      const startedAtMs = performance.now();
      const attempts = await runConcurrent(config.mutationCycles, config.mutationConcurrency, async (index) => {
        const cycleId = `load-mutation-${Date.now()}-${index}`;
        const cyclePath = `/v1/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/rows`;
        const cycleStartedAt = performance.now();

        try {
          await requestJson<CreateRowResponse>({
            baseUrl: config.baseUrl,
            path: cyclePath,
            method: 'POST',
            bearer: config.mutationKey,
            expectedStatus: 201,
            body: {
              values: {
                ...config.createValues,
                [config.idColumn]: cycleId
              }
            }
          });
          createdIds.add(cycleId);

          await requestJson<CreateRowResponse>({
            baseUrl: config.baseUrl,
            path: `${cyclePath}/${encodeURIComponent(cycleId)}`,
            method: 'PATCH',
            bearer: config.mutationKey,
            expectedStatus: 200,
            body: {
              values: config.updateValues
            }
          });

          await deleteBenchmarkRow(cycleId);

          return {
            ok: true,
            status: 200,
            durationMs: Number((performance.now() - cycleStartedAt).toFixed(2)),
            body: {
              rowId: cycleId
            }
          } satisfies AttemptResult;
        } catch (error) {
          return {
            ok: false,
            status: -1,
            durationMs: Number((performance.now() - cycleStartedAt).toFixed(2)),
            body: null,
            errorMessage: error instanceof Error ? error.message : String(error)
          } satisfies AttemptResult;
        }
      });

      return {
        status: attempts.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number((performance.now() - startedAtMs).toFixed(2)),
        ...summarizeAttempts(attempts),
        notes: ['each cycle=create+patch+delete'],
        samples: attempts[0]?.ok
          ? [
              {
                request: {
                  method: 'POST',
                  path: cyclePathForReport(config.privateProject, config.privateTable),
                  auth: 'mutation'
                },
                response: {
                  status: attempts[0].status,
                  excerpt: summarizeJson(attempts[0].body)
                }
              }
            ]
          : []
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    await runScenario('Rate limit pressure and principal separation', async () => {
      const adminPath = '/v1/admin/projects';
      const samePrincipalAttempts: AttemptResult[] = [];
      let first429At: number | null = null;

      for (let index = 0; index < config.rateLimitSamePrincipalRequests; index += 1) {
        const attempt = await timedRequest<Record<string, unknown>>({
          baseUrl: config.baseUrl,
          path: adminPath,
          bearer: config.adminCredential
        });
        samePrincipalAttempts.push(attempt);
        if (attempt.status === 429) {
          first429At = index + 1;
          break;
        }
      }

      const publicPath = `/v1/projects/${encodeURIComponent(config.publicProject)}/tables/${encodeURIComponent(config.publicTable)}/rows?limit=1`;
      const distributedAttempts = await runConcurrent(
        config.rateLimitPrincipalCount * config.rateLimitRequestsPerPrincipal,
        Math.min(10, config.rateLimitPrincipalCount),
        async (index) => {
          const principalIndex = Math.floor(index / config.rateLimitRequestsPerPrincipal);
          return timedRequest<ListRowsResponse>({
            baseUrl: config.baseUrl,
            path: publicPath,
            expectedStatus: 200,
            headers: {
              'x-forwarded-for': `198.51.100.${principalIndex + 10}`
            }
          });
        }
      );

      const combined = [...samePrincipalAttempts, ...distributedAttempts];

      return {
        status: distributedAttempts.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number(combined.reduce((sum, attempt) => sum + attempt.durationMs, 0).toFixed(2)),
        ...summarizeAttempts(combined),
        notes: [
          first429At ? `samePrincipalFirst429At=${first429At}` : 'samePrincipalFirst429At=not-hit',
          `distributedPrincipals=${config.rateLimitPrincipalCount}`
        ],
        samples: [
          {
            request: {
              method: 'GET',
              path: adminPath,
              auth: 'admin'
            },
            response: {
              status: samePrincipalAttempts[0]?.status ?? 0,
              excerpt: summarizeJson(samePrincipalAttempts[0]?.body ?? null)
            }
          },
          {
            request: {
              method: 'GET',
              path: publicPath,
              auth: 'anonymous'
            },
            response: {
              status: distributedAttempts[0]?.status ?? 0,
              excerpt: summarizeJson(distributedAttempts[0]?.body ?? null)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    await runScenario('Reindex while reads continue', async () => {
      const path = `/v1/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/rows?limit=25&sort=${encodeURIComponent(config.indexedListSort)}`;
      const readPromise = runConcurrent(config.reindexReadRequests, config.reindexReadConcurrency, async () =>
        timedRequest<ListRowsResponse>({
          baseUrl: config.baseUrl,
          path,
          bearer: config.privateReadKey,
          expectedStatus: 200
        })
      );

      await delay(100);
      const reindexAttempt = await timedRequest<ReindexResponse>({
        baseUrl: config.baseUrl,
        path: `/v1/admin/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/reindex`,
        method: 'POST',
        bearer: config.adminCredential,
        expectedStatus: 200
      });
      const readAttempts = await readPromise;
      const combined = [...readAttempts, reindexAttempt];

      return {
        status: combined.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number(combined.reduce((sum, attempt) => sum + attempt.durationMs, 0).toFixed(2)),
        ...summarizeAttempts(combined),
        notes: [`reindexDurationMs=${reindexAttempt.durationMs}`],
        samples: [
          {
            request: {
              method: 'POST',
              path: `/v1/admin/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/reindex`,
              auth: 'admin'
            },
            response: {
              status: reindexAttempt.status,
              excerpt: summarizeJson(reindexAttempt.body)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    await runScenario('Manual external sheet churn window', async () => {
      if (config.manualChurnPauseMs <= 0) {
        return {
          status: 'skipped',
          durationMs: 0,
          requestCount: 0,
          successCount: 0,
          failureCount: 0,
          p50Ms: null,
          p95Ms: null,
          maxMs: null,
          notes: ['set SHEETFLARE_LOAD_MANUAL_CHURN_PAUSE_MS to enable this operator-assisted scenario'],
          samples: []
        } satisfies Omit<ScenarioReport, 'name'>;
      }

      const created = await createBenchmarkRow('load-churn');
      const rowPath = `/v1/projects/${encodeURIComponent(config.privateProject)}/tables/${encodeURIComponent(config.privateTable)}/rows/${encodeURIComponent(created.rowId)}`;
      const endTime = Date.now() + config.manualChurnPauseMs;
      const attempts: AttemptResult[] = [];

      logStep(`Manually reorder or edit the backing sheet now. Observation window: ${config.manualChurnPauseMs}ms.`);

      while (Date.now() < endTime) {
        attempts.push(await timedRequest<{ data: RowEnvelope }>({
          baseUrl: config.baseUrl,
          path: rowPath,
          bearer: config.privateReadKey,
          expectedStatus: 200
        }));
        await delay(250);
      }

      const patchAttempt = await timedRequest<CreateRowResponse>({
        baseUrl: config.baseUrl,
        path: rowPath,
        method: 'PATCH',
        bearer: config.mutationKey,
        expectedStatus: 200,
        body: {
          values: config.updateValues
        }
      });
      attempts.push(patchAttempt);
      const cleanup = await deleteBenchmarkRow(created.rowId);

      return {
        status: attempts.every((attempt) => attempt.ok) ? 'passed' : 'failed',
        durationMs: Number(attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0).toFixed(2)),
        ...summarizeAttempts(attempts),
        notes: [
          `manualWindowMs=${config.manualChurnPauseMs}`,
          `cleanupStatus=${cleanup.status}`
        ],
        samples: [
          {
            request: {
              method: 'PATCH',
              path: rowPath,
              auth: 'mutation'
            },
            response: {
              status: patchAttempt.status,
              excerpt: summarizeJson(patchAttempt.body)
            }
          }
        ]
      } satisfies Omit<ScenarioReport, 'name'>;
    });

    report.rowCountAfter = (await getCacheStatus()).data.rowCount;
    report.status = scenarios.every((scenario) => scenario.status !== 'failed') ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString();

    if (report.status === 'passed') {
      console.log('\n[done] staging load checks passed');
    } else {
      throw new ScriptError('One or more load scenarios failed.');
    }
  } catch (error) {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    report.failureMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    for (const rowId of createdIds) {
      try {
        await deleteBenchmarkRow(rowId);
      } catch {
        // Best effort cleanup only.
      }
    }

    if (report.rowCountAfter === null) {
      try {
        report.rowCountAfter = (await getCacheStatus()).data.rowCount;
      } catch {
        // Ignore post-failure cache lookup errors.
      }
    }

    report.finishedAt = new Date().toISOString();
    if (reportPath) {
      const artifactPaths = await writeReportArtifacts(
        reportPath,
        renderLoadReportMarkdown(report),
        report
      );
      console.log(`[report] wrote ${artifactPaths.markdownPath}`);
      console.log(`[report] wrote ${artifactPaths.jsonPath}`);
    }
  }
}

function cyclePathForReport(projectSlug: string, tableSlug: string) {
  return `/v1/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/rows`;
}

void main().catch((error: unknown) => {
  const message = error instanceof ScriptError || error instanceof Error
    ? error.message
    : String(error);
  console.error(`\n[failed] ${message}`);
  process.exit(1);
});
