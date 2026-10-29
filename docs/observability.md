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

Emitted by the route layer when a committed change or Drive notification cannot purge the edge cache. The mutation still succeeds and its response carries `X-Sheetflare-Cache-Invalidation: failed`; edge-cached reads can serve pre-change data until their TTL expires.

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
   Alert when `request.error` with `errorName: "UnauthorizedError"` rises sharply for the same `path` or principal family.

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
    Alert on any occurrence for critical tables, or on a sustained rate overall. Edge-cached reads can serve pre-change data until their TTL expires.

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
  - `event == "request.error" and errorName == "UnauthorizedError"`

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

- cache invalidation failure:
  - `event == "cache.invalidation.failed"`

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
