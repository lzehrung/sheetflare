import type { SpreadsheetWatch } from '@sheetflare/contracts';

type SpreadsheetWatchSummaryProps = {
  watch: SpreadsheetWatch;
};

export function formatSpreadsheetWatchTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

export function getSpreadsheetWatchStatus(watch: SpreadsheetWatch) {
  if (watch.lastWatchError) {
    return 'error';
  }

  if (watch.pendingChangedAt) {
    return 'pending reindex';
  }

  return 'active';
}

export function getSpreadsheetWatchStatusSummary(watch: SpreadsheetWatch) {
  return `${getSpreadsheetWatchStatus(watch)} / expires ${formatSpreadsheetWatchTimestamp(watch.expirationAt)}`;
}

export function SpreadsheetWatchSummary({ watch }: SpreadsheetWatchSummaryProps) {
  return (
    <>
      <div>
        <dt>Status</dt>
        <dd>{getSpreadsheetWatchStatus(watch)}</dd>
      </div>
      <div>
        <dt>Expires</dt>
        <dd>{formatSpreadsheetWatchTimestamp(watch.expirationAt)}</dd>
      </div>
      <div>
        <dt>Last Notification</dt>
        <dd>{formatSpreadsheetWatchTimestamp(watch.lastNotificationAt)}</dd>
      </div>
      <div>
        <dt>Last Auto Reindex</dt>
        <dd>{formatSpreadsheetWatchTimestamp(watch.lastReindexCompletedAt)}</dd>
      </div>
      <div>
        <dt>Projects</dt>
        <dd>{watch.projectSlugs.join(', ')}</dd>
      </div>
      {watch.pendingChangedAt ? (
        <div>
          <dt>Pending Change</dt>
          <dd>{formatSpreadsheetWatchTimestamp(watch.pendingChangedAt)}</dd>
        </div>
      ) : null}
      {watch.debounceUntil ? (
        <div>
          <dt>Debounce Until</dt>
          <dd>{formatSpreadsheetWatchTimestamp(watch.debounceUntil)}</dd>
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
