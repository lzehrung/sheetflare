import type { GetTableCacheStatusResult, TableCacheStatus } from '@sheetflare/contracts';
import { summarizeJson } from './reporting';

export type CacheStatusResponse = GetTableCacheStatusResult;

export type CacheHealthEntry = {
  project: string;
  table: string;
  status: string;
  staleReason: string;
  rowCount: number;
  lastSyncError: string | null;
  validationStatus: TableCacheStatus['validation']['status'];
  validationIssueCount: number;
  healthy: boolean;
};

export type CacheHealthReport = {
  kind: 'cache-health';
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  results: CacheHealthEntry[];
};

export function isCacheHealthy(cache: TableCacheStatus) {
  return (
    cache.status === 'ready' &&
    cache.staleReason !== 'error' &&
    cache.lastSyncError === null &&
    cache.validation.status === 'ok'
  );
}

export function buildCacheHealthEntry(
  project: string,
  table: string,
  cache: TableCacheStatus
): CacheHealthEntry {
  return {
    project,
    table,
    status: cache.status,
    staleReason: cache.staleReason,
    rowCount: cache.rowCount,
    lastSyncError: cache.lastSyncError,
    validationStatus: cache.validation.status,
    validationIssueCount: cache.validation.issueCount,
    healthy: isCacheHealthy(cache)
  };
}

export function buildCacheHealthReport(
  baseUrl: string,
  startedAt: string,
  finishedAt: string,
  results: CacheHealthEntry[]
): CacheHealthReport {
  return {
    kind: 'cache-health',
    status: results.every((result) => result.healthy) ? 'passed' : 'failed',
    startedAt,
    finishedAt,
    baseUrl,
    results
  };
}

export function renderCacheHealthMarkdown(report: CacheHealthReport) {
  const lines = [
    '# Cache Health Report',
    '',
    `- status: ${report.status}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt}`,
    `- baseUrl: ${report.baseUrl}`,
    '',
    '| Project | Table | Healthy | Status | Stale Reason | Validation | Issues | Row Count | Last Sync Error |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |'
  ];

  for (const result of report.results) {
    lines.push(
      `| ${result.project} | ${result.table} | ${result.healthy ? 'yes' : 'no'} | ${result.status} | ${result.staleReason} | ${result.validationStatus} | ${result.validationIssueCount} | ${result.rowCount} | ${(result.lastSyncError ?? 'none').replace(/\|/g, '\\|')} |`
    );
  }

  lines.push('', '## Raw Results', '', '```json', summarizeJson(report.results, 4000), '```', '');
  return `${lines.join('\n')}\n`;
}
