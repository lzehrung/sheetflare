import { getEnv, assert, assertPresent, logStep, logSuccess, requestJson, ScriptError } from './lib/runtime';
import { readSmokeConfig } from './lib/smoke-config';
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

type CreateRowResponse = {
  data: RowEnvelope;
  ignoredKeys: string[];
};

type GetRowResponse = {
  data: RowEnvelope;
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

type SmokeStep = {
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  summary: string;
  request: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    auth: 'anonymous' | 'admin' | 'private-read' | 'mutation';
  };
  response?: {
    status: number;
    excerpt: string;
  };
};

type SmokeReport = {
  kind: 'smoke';
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  privateProject: string;
  privateTable: string;
  publicProject: string | null;
  publicTable: string | null;
  steps: SmokeStep[];
  failureMessage: string | null;
};

function renderSmokeReportMarkdown(report: SmokeReport) {
  const lines = [
    '# Smoke Report',
    '',
    `- status: ${report.status}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt}`,
    `- baseUrl: ${report.baseUrl}`,
    `- privateTable: ${report.privateProject}/${report.privateTable}`,
    `- publicTable: ${report.publicProject && report.publicTable ? `${report.publicProject}/${report.publicTable}` : 'not configured'}`,
    ''
  ];

  if (report.failureMessage) {
    lines.push(`- failure: ${report.failureMessage}`, '');
  }

  lines.push('## Steps', '', '| Step | Status | Duration Ms | Summary |', '| --- | --- | ---: | --- |');
  for (const step of report.steps) {
    lines.push(`| ${step.name} | ${step.status} | ${step.durationMs} | ${step.summary.replace(/\|/g, '\\|')} |`);
  }

  lines.push('', '## Request And Response Samples', '');

  for (const step of report.steps) {
    lines.push(`### ${step.name}`, '');
    lines.push(`- status: ${step.status}`);
    lines.push(`- request: \`${step.request.method} ${step.request.path}\` (${step.request.auth})`);
    if (step.response) {
      lines.push(`- response status: ${step.response.status}`, '', '```json', step.response.excerpt, '```');
    } else {
      lines.push('- response: none captured');
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const {
    baseUrl,
    adminCredential,
    privateProject,
    privateTable,
    privateReadKey,
    mutationKey,
    publicProject,
    publicTable,
    idColumn,
    createValues,
    updateValues
  } = readSmokeConfig();
  const reportPath = getEnv('SHEETFLARE_SMOKE_REPORT_PATH');
  const startedAt = new Date().toISOString();
  const steps: SmokeStep[] = [];
  const smokeId = `smoke-${Date.now()}`;
  const hasPublicReadCoverage = Boolean(publicProject && publicTable);
  let createdRowId: string | null = null;

  async function runStep<T>(options: {
    name: string;
    request: SmokeStep['request'];
    summary: (value: T) => string;
    run: () => Promise<{
      responseStatus: number;
      responseBody: unknown;
      value: T;
    }>;
  }) {
    logStep(options.name);
    const startedAtMs = Date.now();

    try {
      const result = await options.run();
      const summary = options.summary(result.value);
      const step: SmokeStep = {
        name: options.name,
        status: 'passed',
        durationMs: Date.now() - startedAtMs,
        summary,
        request: options.request,
        response: {
          status: result.responseStatus,
          excerpt: summarizeJson(result.responseBody)
        }
      };
      steps.push(step);
      logSuccess(summary);
      return result.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({
        name: options.name,
        status: 'failed',
        durationMs: Date.now() - startedAtMs,
        summary: message,
        request: options.request
      });
      throw error;
    }
  }

  const report: SmokeReport = {
    kind: 'smoke',
    status: 'failed',
    startedAt,
    finishedAt: startedAt,
    baseUrl,
    privateProject,
    privateTable,
    publicProject,
    publicTable,
    steps,
    failureMessage: null
  };

  try {
    const readinessData = await runStep({
      name: 'Internal readiness check',
      request: {
        method: 'GET',
        path: '/ready',
        auth: 'anonymous'
      },
      summary: (value) => `Readiness reported controlPlane=${value.checks.controlPlane} rateLimit=${value.checks.rateLimit}.`,
      run: async () => {
        const readiness = await requestJson<{
          checks: {
            controlPlane: string;
            rateLimit: string;
          };
        }>({
          baseUrl,
          path: '/ready',
          expectedStatus: 200
        });
        const body = assertPresent(readiness.data, 'Readiness check returned an empty response body.');
        assert(body.checks.controlPlane === 'ok', 'Readiness check reported control-plane failure.');
        assert(body.checks.rateLimit === 'ok', 'Readiness check reported rate-limit failure.');
        return {
          responseStatus: readiness.response.status,
          responseBody: body,
          value: body
        };
      }
    });
    void readinessData;

    await runStep({
      name: 'Admin project listing',
      request: {
        method: 'GET',
        path: '/v1/admin/projects',
        auth: 'admin'
      },
      summary: () => 'Admin routes are reachable.',
      run: async () => {
        const response = await requestJson<Record<string, unknown>>({
          baseUrl,
          path: '/v1/admin/projects',
          bearer: adminCredential,
          expectedStatus: 200
        });
        return {
          responseStatus: response.response.status,
          responseBody: assertPresent(response.data, 'Admin project listing returned an empty response body.'),
          value: true
        };
      }
    });

    await runStep({
      name: 'Private table rejects anonymous reads',
      request: {
        method: 'GET',
        path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
        auth: 'anonymous'
      },
      summary: () => 'Private table blocks anonymous reads.',
      run: async () => {
        const response = await requestJson<Record<string, unknown>>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
          expectedStatus: 401
        });
        return {
          responseStatus: response.response.status,
          responseBody: response.data,
          value: true
        };
      }
    });

    await runStep({
      name: 'Private table accepts scoped read key',
      request: {
        method: 'GET',
        path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
        auth: 'private-read'
      },
      summary: (value) => `Private table read key succeeded with ${value.data.length} rows on the first page.`,
      run: async () => {
        const response = await requestJson<ListRowsResponse>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
          bearer: privateReadKey,
          expectedStatus: 200
        });
        return {
          responseStatus: response.response.status,
          responseBody: assertPresent(response.data, 'Private table read returned an empty response body.'),
          value: assertPresent(response.data, 'Private table read returned an empty response body.')
        };
      }
    });

    if (hasPublicReadCoverage) {
      await runStep({
        name: 'Public table accepts anonymous reads',
        request: {
          method: 'GET',
          path: `/v1/projects/${encodeURIComponent(publicProject!)}/tables/${encodeURIComponent(publicTable!)}/rows`,
          auth: 'anonymous'
        },
        summary: (value) => `Public-read table returned ${value.data.length} rows on the first page.`,
        run: async () => {
          const response = await requestJson<ListRowsResponse>({
            baseUrl,
            path: `/v1/projects/${encodeURIComponent(publicProject!)}/tables/${encodeURIComponent(publicTable!)}/rows`,
            expectedStatus: 200
          });
          return {
            responseStatus: response.response.status,
            responseBody: assertPresent(response.data, 'Public table read returned an empty response body.'),
            value: assertPresent(response.data, 'Public table read returned an empty response body.')
          };
        }
      });

      await runStep({
        name: 'Public-read table rejects anonymous writes',
        request: {
          method: 'POST',
          path: `/v1/projects/${encodeURIComponent(publicProject!)}/tables/${encodeURIComponent(publicTable!)}/rows`,
          auth: 'anonymous'
        },
        summary: () => 'Public-read table blocks anonymous writes.',
        run: async () => {
          const response = await requestJson<Record<string, unknown>>({
            baseUrl,
            path: `/v1/projects/${encodeURIComponent(publicProject!)}/tables/${encodeURIComponent(publicTable!)}/rows`,
            method: 'POST',
            expectedStatus: 401,
            body: {
              values: {
                ...createValues,
                [idColumn]: `public-${smokeId}`
              }
            }
          });
          return {
            responseStatus: response.response.status,
            responseBody: response.data,
            value: true
          };
        }
      });
    }

    const cacheStatusData = await runStep({
      name: 'Cache status includes stale reason',
      request: {
        method: 'GET',
        path: `/v1/admin/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/cache`,
        auth: 'admin'
      },
      summary: (value) => `Cache status is ${value.data.status}/${value.data.staleReason} with ${value.data.rowCount} rows.`,
      run: async () => {
        const response = await requestJson<CacheStatusResponse>({
          baseUrl,
          path: `/v1/admin/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/cache`,
          bearer: adminCredential,
          expectedStatus: 200
        });
        const body = assertPresent(response.data, 'Cache status returned an empty response body.');
        assert(typeof body.data.staleReason === 'string', 'Cache status must include staleReason.');
        return {
          responseStatus: response.response.status,
          responseBody: body,
          value: body
        };
      }
    });
    void cacheStatusData;

    const createdRow = await runStep({
      name: 'Create a smoke row',
      request: {
        method: 'POST',
        path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
        auth: 'mutation'
      },
      summary: (value) => `Created smoke row ${value.data.id}.`,
      run: async () => {
        const response = await requestJson<CreateRowResponse>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows`,
          method: 'POST',
          bearer: mutationKey,
          expectedStatus: 201,
          body: {
            values: {
              ...createValues,
              [idColumn]: smokeId
            }
          }
        });
        const body = assertPresent(response.data, 'Create row returned an empty response body.');
        createdRowId = body.data.id;
        assert(createdRowId === smokeId, `Expected created row id ${smokeId}, received ${createdRowId}.`);
        return {
          responseStatus: response.response.status,
          responseBody: body,
          value: body
        };
      }
    });
    void createdRow;

    await runStep({
      name: 'Read the smoke row back',
      request: {
        method: 'GET',
        path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
        auth: 'private-read'
      },
      summary: (value) => `Smoke row get returned ${value.data.id}.`,
      run: async () => {
        const response = await requestJson<GetRowResponse>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
          bearer: privateReadKey,
          expectedStatus: 200
        });
        const body = assertPresent(response.data, 'Get row returned an empty response body.');
        assert(body.data.id === smokeId, 'Smoke row get did not return the expected row.');
        return {
          responseStatus: response.response.status,
          responseBody: body,
          value: body
        };
      }
    });

    await runStep({
      name: 'Update the smoke row',
      request: {
        method: 'PATCH',
        path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
        auth: 'mutation'
      },
      summary: () => 'Smoke row update succeeded.',
      run: async () => {
        const response = await requestJson<CreateRowResponse>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
          method: 'PATCH',
          bearer: mutationKey,
          expectedStatus: 200,
          body: {
            values: updateValues
          }
        });
        return {
          responseStatus: response.response.status,
          responseBody: assertPresent(response.data, 'Update row returned an empty response body.'),
          value: true
        };
      }
    });

    await runStep({
      name: 'Force a reindex',
      request: {
        method: 'POST',
        path: `/v1/admin/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/reindex`,
        auth: 'admin'
      },
      summary: (value) => `Reindex succeeded with cache state ${value.cache.status}/${value.cache.staleReason}.`,
      run: async () => {
        const response = await requestJson<ReindexResponse>({
          baseUrl,
          path: `/v1/admin/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/reindex`,
          method: 'POST',
          bearer: adminCredential,
          expectedStatus: 200
        });
        const body = assertPresent(response.data, 'Reindex returned an empty response body.');
        assert(body.ok === true, 'Reindex did not succeed.');
        return {
          responseStatus: response.response.status,
          responseBody: body,
          value: body
        };
      }
    });

    await runStep({
      name: 'Delete the smoke row',
      request: {
        method: 'DELETE',
        path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
        auth: 'mutation'
      },
      summary: (value) => `Deleted smoke row ${value.deletedId}.`,
      run: async () => {
        const response = await requestJson<DeleteRowResponse>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(smokeId)}`,
          method: 'DELETE',
          bearer: mutationKey,
          expectedStatus: 200
        });
        const body = assertPresent(response.data, 'Delete row returned an empty response body.');
        assert(body.deletedId === smokeId, 'Delete did not remove the expected row.');
        createdRowId = null;
        return {
          responseStatus: response.response.status,
          responseBody: body,
          value: body
        };
      }
    });

    report.status = 'passed';
    report.finishedAt = new Date().toISOString();
      console.log('\n[done] smoke checks passed');
  } catch (error) {
    report.status = 'failed';
    report.failureMessage = error instanceof ScriptError || error instanceof Error
      ? error.message
      : String(error);

    if (createdRowId) {
      try {
        logStep(`Cleanup deleting smoke row ${createdRowId}`);
        const cleanup = await requestJson<DeleteRowResponse>({
          baseUrl,
          path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(createdRowId)}`,
          method: 'DELETE',
          bearer: mutationKey,
          expectedStatus: 200
        });
        const body = assertPresent(cleanup.data, 'Cleanup delete returned an empty response body.');
        steps.push({
          name: 'Cleanup delete',
          status: 'passed',
          durationMs: 0,
          summary: `Cleanup deleted ${body.deletedId}.`,
          request: {
            method: 'DELETE',
            path: `/v1/projects/${encodeURIComponent(privateProject)}/tables/${encodeURIComponent(privateTable)}/rows/${encodeURIComponent(createdRowId)}`,
            auth: 'mutation'
          },
          response: {
            status: cleanup.response.status,
            excerpt: summarizeJson(body)
          }
        });
        logSuccess('Cleanup delete succeeded');
      } catch (cleanupError) {
        console.error(
          cleanupError instanceof Error
            ? cleanupError.message
            : `Cleanup failed: ${String(cleanupError)}`
        );
      }
    }

    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    if (reportPath) {
      const artifactPaths = await writeReportArtifacts(
        reportPath,
        renderSmokeReportMarkdown(report),
        report
      );
      console.log(`[report] wrote ${artifactPaths.markdownPath}`);
      console.log(`[report] wrote ${artifactPaths.jsonPath}`);
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof ScriptError || error instanceof Error
    ? error.message
    : String(error);
  console.error(`\n[failed] ${message}`);
  process.exit(1);
});
