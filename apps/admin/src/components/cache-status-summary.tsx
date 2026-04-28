import type { TableCacheStatus } from '@sheetflare/contracts';

type CacheStatusSummaryProps = {
  cache: TableCacheStatus;
};

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet';
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
        <dt>Last Sync Completed</dt>
        <dd>{formatTimestamp(cache.lastSyncCompletedAt)}</dd>
      </div>
      <div>
        <dt>Last Sync Started</dt>
        <dd>{formatTimestamp(cache.lastSyncStartedAt)}</dd>
      </div>
      {cache.lastSyncError ? (
        <div>
          <dt>Last Sync Error</dt>
          <dd>{cache.lastSyncError}</dd>
        </div>
      ) : null}
    </>
  );
}
