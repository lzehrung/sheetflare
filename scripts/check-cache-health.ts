import { logStep, logSuccess, requestJson, ScriptError } from './lib/runtime';
import { readCacheHealthConfig } from './lib/cache-health-config';
import { summarizeJson, writeReportArtifacts } from './lib/reporting';

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

type CacheHealthEntry = {
  project: string;
  table: string;
  status: string;
  staleReason: string;
  rowCount: number;
  lastSyncError: string | null;
  healthy: boolean;
};

type CacheHealthReport = {
  kind: 'cache-health';
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  results: CacheHealthEntry[];
};

function renderMarkdown(report: CacheHealthReport) {
  const lines = [
    '# Cache Health Report',
    '',
    `- status: ${report.status}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt}`,
    `- baseUrl: ${report.baseUrl}`,
    '',
    '| Project | Table | Healthy | Status | Stale Reason | Row Count | Last Sync Error |',
    '| --- | --- | --- | --- | --- | ---: | --- |'
  ];

  for (const result of report.results) {
    lines.push(
      `| ${result.project} | ${result.table} | ${result.healthy ? 'yes' : 'no'} | ${result.status} | ${result.staleReason} | ${result.rowCount} | ${(result.lastSyncError ?? 'none').replace(/\|/g, '\\|')} |`
    );
  }

  lines.push('', '## Raw Results', '', '```json', summarizeJson(report.results, 4000), '```', '');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const config = readCacheHealthConfig();
  const startedAt = new Date().toISOString();
  const results: CacheHealthEntry[] = [];

  for (const target of config.targets) {
    logStep(`Checking cache health for ${target.project}/${target.table}`);
    const response = await requestJson<CacheStatusResponse>({
      baseUrl: config.baseUrl,
      path: `/v1/admin/projects/${encodeURIComponent(target.project)}/tables/${encodeURIComponent(target.table)}/cache`,
      bearer: config.adminCredential,
      expectedStatus: 200
    });
    const body = response.data;
    if (!body) {
      throw new ScriptError(`Cache health for ${target.project}/${target.table} returned an empty response body.`);
    }

    const healthy =
      body.data.status === 'ready' &&
      body.data.staleReason !== 'error' &&
      body.data.lastSyncError === null;

    results.push({
      project: target.project,
      table: target.table,
      status: body.data.status,
      staleReason: body.data.staleReason,
      rowCount: body.data.rowCount,
      lastSyncError: body.data.lastSyncError,
      healthy
    });
    logSuccess(`${target.project}/${target.table} -> ${body.data.status}/${body.data.staleReason}`);
  }

  const report: CacheHealthReport = {
    kind: 'cache-health',
    status: results.every((result) => result.healthy) ? 'passed' : 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    results
  };

  if (config.reportPath) {
    const artifactPaths = await writeReportArtifacts(
      config.reportPath,
      renderMarkdown(report),
      report
    );
    console.log(`[report] wrote ${artifactPaths.markdownPath}`);
    console.log(`[report] wrote ${artifactPaths.jsonPath}`);
  }

  if (report.status !== 'passed') {
    throw new ScriptError('One or more cache targets are unhealthy.');
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof ScriptError || error instanceof Error
    ? error.message
    : String(error);
  console.error(`\n[failed] ${message}`);
  process.exit(1);
});
