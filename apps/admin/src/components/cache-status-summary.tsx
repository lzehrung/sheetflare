import type { TableCacheStatus } from '@sheetflare/contracts';

type CacheStatusSummaryProps = {
  cache: TableCacheStatus;
};

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

function formatValidationSummary(cache: TableCacheStatus) {
  const issueLabel = cache.validation.issueCount === 1 ? 'issue' : 'issues';
  return cache.validation.status === 'ok'
    ? 'ok / 0 issues'
    : `${cache.validation.status} / ${cache.validation.issueCount} ${issueLabel}`;
}

function formatValidationIssues(cache: TableCacheStatus) {
  return cache.validation.issues
    .map((issue) => `row ${issue.rowNumber} (${issue.rowId}) ${issue.field} ${issue.code}: ${issue.message}`)
    .join('; ');
}

export function CacheStatusSummary({ cache }: CacheStatusSummaryProps) {
  return (
    <>
      <div>
        <dt>Cache</dt>
        <dd>{cache.status} / {cache.staleReason} / {cache.rowCount} rows</dd>
      </div>
      <div>
        <dt>Freshness</dt>
        <dd>{cache.stale ? 'Stale' : 'Fresh'} / TTL {cache.cacheTtlSeconds}s</dd>
      </div>
      <div>
        <dt>Validation</dt>
        <dd>{formatValidationSummary(cache)}</dd>
      </div>
      <div>
        <dt>Last Sync Completed</dt>
        <dd>{formatTimestamp(cache.lastSyncCompletedAt)}</dd>
      </div>
      <div>
        <dt>Last Sync Started</dt>
        <dd>{formatTimestamp(cache.lastSyncStartedAt)}</dd>
      </div>
      {cache.validation.issueCount > 0 ? (
        <div>
          <dt>Validation Issues</dt>
          <dd>{formatValidationIssues(cache)}</dd>
        </div>
      ) : null}
      {cache.lastSyncError ? (
        <div>
          <dt>Last Sync Error</dt>
          <dd>{cache.lastSyncError}</dd>
        </div>
      ) : null}
    </>
  );
}
