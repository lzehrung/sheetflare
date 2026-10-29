# Observability And Alerts

Sheetflare emits structured JSON log events from the Worker, the table cache layer, and the control plane's Drive-watch alarm. This document lists the event schemas, defines the minimum alert conditions for production-like operation, and provides copy-paste query predicates for common log platforms.

Both `apps/api/wrangler.jsonc` and `apps/api/wrangler.staging.jsonc` set `observability.enabled: true`, which turns on Workers Logs for the Worker and its Durable Objects. Without it, none of these events are retained. Log events are internal: they can include upstream Google messages and raw exception text, which API responses and the stored `lastReindexError` / `lastWatchError` fields never contain.

## Structured Events

### Request completion

Emitted by the route layer:

- `event: "request.complete"`
- `method`
- `path`
- `status`
- `durationMs`
- `requestId`
- `principal`
- `rateLimitPrincipal`
- `rateLimitRouteFamily`
- `rateLimitOperationKey`
- `rateLimitLimit`
- `rateLimitRemaining`
- `rateLimitResetAt`

### Request failure

Emitted by the route layer:

- `event: "request.error"`
- `method`
- `path`
- `requestId`
- `principal`
- `rateLimitPrincipal`
- `rateLimitRouteFamily`
- `rateLimitOperationKey`
- `errorName`
- `errorMessage`

### Successful table sync

Emitted by `TableDO`:

- `event: "table.sync.complete"`
- `projectSlug`
- `tableSlug`
- `rowCount`
- `validationStatus`
- `validationIssueCount`
- `durationMs`
- `requestId`
- `route`
- `principal`

### Failed table sync

Emitted by `TableDO`:

- `event: "table.sync.failed"`
- `projectSlug`
- `tableSlug`
- `durationMs`
- `errorMessage`
- `requestId`
- `route`
- `principal`

### Cache invalidation failure

Emitted as a `warn` by the route layer when a Workers Cache purge is rejected. Cached reads are keyed by the table's data generation, so a purge failure does not serve stale data. The purge is best-effort garbage collection: it only frees edge storage ahead of the entry TTL. The mutation still succeeds, and the response does not report purge status.

- `event: "cache.invalidation.failed"`
- `method`
- `path`
- `requestId`
- `errorName`
- `errorMessage`

### Failed Drive reindex

Emitted by `ControlPlaneDO` once per failed table each time the Drive-watch alarm reindexes a spreadsheet:

- `event: "drive.reindex.failed"`
- `spreadsheetId`
- `projectSlug`
- `tableSlug` (`null` when the project's table list could not be read)
- `attempt`: consecutive failed reindex attempts for the spreadsheet
- `nextAttemptAt`
- `errorName`, `errorCode`, `errorMessage`, `errorDetails`

The alarm still reindexes the spreadsheet's other tables. The spreadsheet stays pending, and retries back off from its debounce (at least 30 seconds) by doubling up to 1 hour; a new Drive notification schedules the next attempt at its own debounce. `npm run ops:watch:drive:status` shows the first failure as `lastReindexError: "<project>/<table>: <message>"`.

### Failed Drive watch renewal

Emitted by `ControlPlaneDO` when the alarm cannot renew an expiring watch:

- `event: "drive.watch.renew.failed"`
- `spreadsheetId`
- `channelId`
- `expirationAt`: when the current channel stops delivering notifications
- `lastWatchError`: the message stored on the watch
- `errorName`, `errorCode`, `errorMessage`, `errorDetails` (absent for configuration problems: a missing stored webhook URL or `GOOGLE_DRIVE_WEBHOOK_SECRET`)

### Failed Drive watch stop

Emitted by `ControlPlaneDO` when Google rejects `channels.stop` for a channel that is no longer tracked, after a project delete, a re-registration, or a renewal:

- `event: "drive.watch.stop.failed"`
- `spreadsheetId`
- `channelId`
- `attempt`
- `nextAttemptAt`
- `errorName`, `errorCode`, `errorMessage`, `errorDetails`

The operation that retired the channel has already succeeded. The alarm retries the stop, backing off from 1 minute by doubling up to 1 hour, until Google accepts it or the channel reaches its expiration.

### Rejected Drive notification

Emitted by `ControlPlaneDO` as a warning when a Drive notification names a channel it does not track:

- `event: "drive.notification.rejected"`
- `channelId`
- `resourceId`
- `resourceState`
- `messageNumber`
- `reason`: `"unknown-channel"` or `"resource-mismatch"`

A replaced or stopped channel can keep delivering briefly until its stop succeeds or it expires, so isolated events are expected.

### Failed Google request

Emitted by the Google Sheets adapter for each failed Google API response:

- `event: "google.request.failed"`
- `operation`: the Google call that failed
- `status`: the HTTP status Google returned
- `googleStatus`, `reason`: Google's `error.status` and first `error.errors[].reason`, when present
- `driveSubscriptionQuotaExceeded`: `true` when Drive rejected a watch for the file-subscription rate limit
- `upstreamMessage`: Google's error message or raw response body, truncated to 2000 characters

API error responses for Google failures return only `status`, `googleStatus`, `reason`, and `driveSubscriptionQuotaExceeded` in `error.details`. The upstream text appears only in this event.

Operator action: `401` or `403` means Google rejected the credential or its access to the spreadsheet; check the service account's sharing and the `googleCredentialRef` ([google-service-accounts.md](./google-service-accounts.md)). `429` means Google quota was exceeded; reduce load, and for `driveSubscriptionQuotaExceeded` follow [Register Drive Watches](./operator-runbook.md#register-drive-watches). `5xx` is usually transient; investigate only when it persists.

### Unconfirmed table write

Emitted by `TableDO` when a create, update, or delete may have been applied by Google but could not be confirmed, for example after a lost response or a 5xx:

- `event: "table.write.unconfirmed"`
- `projectSlug`, `tableSlug`
- `operation`: `create`, `update`, or `delete`
- `rowId`
- `errorName`, `errorMessage`

The table is marked for resync, so the next read reloads it from the sheet. The API still returns the original write error. Operator action: compare the row with `rowId` in the sheet against the intended change, and correct the sheet if needed. Repeated events for one table point to Google or network instability; check the matching `google.request.failed` events.

### Failed create rollback

Emitted by `TableDO` when a create fails after Google appended the row and the automatic rollback could not remove it. The API returns `503`:

- `event: "table.create.rollback_failed"`
- `projectSlug`, `tableSlug`
- `rowId`
- `appendedRowNumber`: the appended sheet row, or `null` when Google's append response was lost
- `createError`, `rollbackError`: the original and rollback error messages

The table is marked for resync, and the partial row stays in the sheet, so the next resync caches it. Operator action: find the row whose managed ID is `rowId` (use `appendedRowNumber` when it is not `null`), delete it if it is partial, then [force a reindex](./operator-runbook.md#force-reindex).


## Minimum Alert Conditions

Alert on these conditions before broad production use:

1. `table.sync.failed`
   Alert when the same `projectSlug/tableSlug` emits one or more failures in a 5 minute window.

2. Repeated stale error state
   Schedule `npm run ops:cache:health` against critical tables and alert on any non-zero exit.
   This detects:
   - `status !== "ready"`
   - `staleReason === "error"` or `staleReason === "external-change"` that does not clear
   - `lastSyncError !== null`

3. Repeated `429` responses
   Alert when `request.complete` with `status: 429` exceeds your expected threshold for the same `path` and `principal` in a 5 minute window.

4. Auth failure spikes
   Alert when `request.error` with `errorName: "UnauthorizedError"` (`401`: missing or invalid credential) or `errorName: "ForbiddenError"` (`403 FORBIDDEN`: valid key without the required scope) rises sharply for the same `path` or principal family.

5. Sync duration outliers
   Alert when `table.sync.complete.durationMs` or `table.sync.failed.durationMs` materially exceeds the recent baseline for the same table.

6. Row-count jumps or drops
   Review `table.sync.complete.rowCount` per table and alert on unexpected deltas after sync.

7. Validation drift warnings
   Alert when `table.sync.complete.validationStatus == "warning"` for critical tables, or when `validationIssueCount` rises unexpectedly after a sync.

8. External-change reindex backlog
   Alert when critical tables remain in `staleReason: "external-change"` beyond the intended debounce window, which usually means Drive notifications are arriving but automatic reindex is failing or blocked.

9. Drive watch renewal health
   Inspect `npm run ops:watch:drive:status` and alert when `expirationAt` is in the past or `lastWatchError` remains non-null for critical spreadsheets.

10. `drive.reindex.failed`
    Alert when the same `spreadsheetId/projectSlug/tableSlug` reaches `attempt >= 3`. Retries are then minutes to an hour apart, and the table refreshes only when it is read.

11. `drive.watch.renew.failed`
    Alert on any event for a critical spreadsheet. Notifications stop at the event's `expirationAt` unless renewal recovers or watches are re-registered.

12. `drive.watch.stop.failed`
    Alert when the same `channelId` reaches `attempt >= 5` (about 15 minutes of failures). The channel keeps sending notifications that are rejected until it stops or expires.

13. `drive.notification.rejected`
    Alert when the same `channelId` keeps producing events for more than 15 minutes. A channel that never stops, or a watch the control plane lost track of, shows up this way.

14. `cache.invalidation.failed`
    Alert on a sustained rate of purge rejections, not on a single event. Workers Cache purge uses a budget of 5 requests a minute after a burst of 25, so isolated rejections are expected. A sustained rate means that budget is exhausted. Purge failure does not make reads stale.

15. `table.create.rollback_failed`
    Alert on any occurrence. A partial row can remain in the sheet until an operator removes it.

## Executable Health Check

Set a list of critical tables:

```powershell
$env:SHEETFLARE_CACHE_HEALTH_TABLES_JSON = '[{"project":"demo-private","table":"users"},{"project":"demo-public","table":"users"}]'
$env:SHEETFLARE_CACHE_HEALTH_REPORT_PATH = "reports/ops/cache-health-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run ops:cache:health
```

Use this in a scheduler or synthetic monitor. A non-zero exit means one or more critical tables are unhealthy.

## Query Predicates

Use these exact predicates in your chosen log platform:

- sync failure:
  - `event == "table.sync.failed"`

- rate-limit pressure:
  - `event == "request.complete" and status == 429`

- auth spike:
  - `event == "request.error" and errorName in ["UnauthorizedError", "ForbiddenError"]`

- slow syncs:
  - `event in ["table.sync.complete", "table.sync.failed"] and durationMs > <your-threshold>`

- row-count anomaly review:
  - `event == "table.sync.complete"` grouped by `projectSlug, tableSlug`

- validation drift review:
  - `event == "table.sync.complete" and validationStatus == "warning"`

- Drive reindex failure, repeated:
  - `event == "drive.reindex.failed" and attempt >= 3` grouped by `spreadsheetId, projectSlug, tableSlug`

- Drive watch renewal failure:
  - `event == "drive.watch.renew.failed"`

- Drive watch stop failure, repeated:
  - `event == "drive.watch.stop.failed" and attempt >= 5` grouped by `channelId`

- rejected Drive notifications:
  - `event == "drive.notification.rejected"` grouped by `channelId, reason`

- cache invalidation failure (alert on a sustained rate; a single rejection is within the purge budget):
  - `event == "cache.invalidation.failed"`

- unconfirmed table write:
  - `event == "table.write.unconfirmed"` grouped by `projectSlug, tableSlug`

- failed create rollback:
  - `event == "table.create.rollback_failed"`

- Google request failure:
  - `event == "google.request.failed"` grouped by `operation, status`

## Tested Failure Workflow

Once staging exists, exercise at minimum:

1. A forced sync failure
   Example: introduce a duplicate managed ID, trigger reindex, confirm:
   - `table.sync.failed` log appears
   - `npm run ops:cache:health` fails
   - the failure is visible in the cache report

2. A rate-limit pressure case
   Run `npm run load`, confirm:
   - `request.complete` emits `429`
   - the benchmark report records the first same-principal `429`
   - your alert threshold would have triggered if the pressure were sustained
