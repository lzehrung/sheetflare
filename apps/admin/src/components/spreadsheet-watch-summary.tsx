import type { SpreadsheetWatch } from '@sheetflare/contracts';

type SpreadsheetWatchSummaryProps = {
  watch: SpreadsheetWatch;
};

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

function getWatchStatus(watch: SpreadsheetWatch) {
  if (watch.lastWatchError) {
    return 'error';
  }

  if (watch.pendingChangedAt) {
    return 'pending reindex';
  }

  return 'active';
}

export function SpreadsheetWatchSummary({ watch }: SpreadsheetWatchSummaryProps) {
  return (
    <>
      <div>
        <dt>Status</dt>
        <dd>{getWatchStatus(watch)}</dd>
      </div>
      <div>
        <dt>Expires</dt>
        <dd>{formatTimestamp(watch.expirationAt)}</dd>
      </div>
      <div>
        <dt>Last Notification</dt>
        <dd>{formatTimestamp(watch.lastNotificationAt)}</dd>
      </div>
      <div>
        <dt>Last Auto Reindex</dt>
        <dd>{formatTimestamp(watch.lastReindexCompletedAt)}</dd>
      </div>
      <div>
        <dt>Projects</dt>
        <dd>{watch.projectSlugs.join(', ')}</dd>
      </div>
      {watch.pendingChangedAt ? (
        <div>
          <dt>Pending Change</dt>
          <dd>{formatTimestamp(watch.pendingChangedAt)}</dd>
        </div>
      ) : null}
      {watch.debounceUntil ? (
        <div>
          <dt>Debounce Until</dt>
          <dd>{formatTimestamp(watch.debounceUntil)}</dd>
        </div>
      ) : null}
      {watch.lastWatchError ? (
        <div>
          <dt>Last Watch Error</dt>
          <dd>{watch.lastWatchError}</dd>
        </div>
      ) : null}
    </>
  );
}
