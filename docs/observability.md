# Observability And Alerts

Sheetflare already emits structured JSON logs from the Worker and `TableDO`. This document defines the minimum alert plan for production-like operation.

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

### Request failure

Emitted by the route layer:

- `event: "request.error"`
- `method`
- `path`
- `requestId`
- `principal`
- `errorName`
- `errorMessage`

### Successful table sync

Emitted by `TableDO`:

- `event: "table.sync.complete"`
- `projectSlug`
- `tableSlug`
- `rowCount`
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

## Minimum Alert Conditions

Alert on these conditions before broad production use:

1. `table.sync.failed`
   Alert when the same `projectSlug/tableSlug` emits one or more failures in a 5 minute window.

2. Repeated stale error state
   Schedule `npm run ops:cache:health` against critical tables and alert on any non-zero exit.
   This detects:
   - `status !== "ready"`
   - `staleReason === "error"`
   - `lastSyncError !== null`

3. Repeated `429` responses
   Alert when `request.complete` with `status: 429` exceeds your expected threshold for the same `path` and `principal` in a 5 minute window.

4. Auth failure spikes
   Alert when `request.error` with `errorName: "UnauthorizedError"` rises sharply for the same `path` or principal family.

5. Sync duration outliers
   Alert when `table.sync.complete.durationMs` or `table.sync.failed.durationMs` materially exceeds the recent baseline for the same table.

6. Row-count jumps or drops
   Review `table.sync.complete.rowCount` per table and alert on unexpected deltas after sync.

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
