import { logStep, logSuccess, requestJson, ScriptError } from './lib/runtime';
import { readCacheHealthConfig } from './lib/cache-health-config';
import { writeReportArtifacts } from './lib/reporting';
import {
  buildCacheHealthEntry,
  buildCacheHealthReport,
  type CacheStatusResponse,
  renderCacheHealthMarkdown
} from './lib/cache-health';

async function main() {
  const config = readCacheHealthConfig();
  const startedAt = new Date().toISOString();
  const results = [];

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

    results.push(buildCacheHealthEntry(target.project, target.table, body.data));
    logSuccess(
      `${target.project}/${target.table} -> ${body.data.status}/${body.data.staleReason} / validation=${body.data.validation.status}`
    );
  }

  const report = buildCacheHealthReport(config.baseUrl, startedAt, new Date().toISOString(), results);

  if (config.reportPath) {
    const artifactPaths = await writeReportArtifacts(
      config.reportPath,
      renderCacheHealthMarkdown(report),
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
