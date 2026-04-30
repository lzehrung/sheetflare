import type { SpreadsheetWatch } from '@sheetflare/contracts';

type SpreadsheetWatchSummaryProps = {
  watch: SpreadsheetWatch;
};

export function formatSpreadsheetWatchTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

function isSpreadsheetWatchExpired(expirationAt: string | null) {
  if (!expirationAt) {
    return false;
  }

  const expirationAtMs = Date.parse(expirationAt);
  return !Number.isNaN(expirationAtMs) && expirationAtMs <= Date.now();
}

export function getSpreadsheetWatchStatus(watch: SpreadsheetWatch) {
  if (watch.lastWatchError) {
    return 'error';
  }

  if (isSpreadsheetWatchExpired(watch.expirationAt)) {
    return 'expired';
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
        <dd>{watch.projectSlugs.length > 0 ? watch.projectSlugs.join(', ') : 'None'}</dd>
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
