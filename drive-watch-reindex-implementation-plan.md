# Drive Watch Reindex Plan

## Goal

Add an optional Google Drive notification path that marks spreadsheet-backed tables stale when the upstream spreadsheet changes, debounces bursty edits, and automatically reindexes affected tables without adding a second control plane.

This feature should preserve the current Sheetflare model:

- Google Sheets remains upstream truth
- `TableDO` remains local query truth
- sync behavior stays explicit and observable
- operators can understand when a spreadsheet changed, whether reindex is pending, and why a table is stale

## Product Shape

### What the feature does

- Accept Google Drive push notifications for watched spreadsheet files.
- Map a changed spreadsheet to all configured tables that reference it.
- Mark those tables as externally changed.
- Debounce repeated notifications for the same spreadsheet.
- Automatically trigger one reindex per affected table after the debounce window.
- Surface the external-change state in cache status and logs.

### What the feature does not do

- It does not compute row-level diffs from the notification.
- It does not attempt partial cache updates from Drive metadata alone.
- It does not require Apps Script.
- It does not make background sync hidden; the pending/debounced state must stay visible.

## Design

### External notification source

Use Google Drive file notifications for the spreadsheet file.

Reasoning:

- It fits the Cloudflare-first architecture.
- It gives an asynchronous "spreadsheet changed" signal without polling.
- It avoids a Google Apps Script sidecar.

### Debounce model

Debounce per spreadsheet, not per table.

Reasoning:

- One spreadsheet may back multiple tables.
- Operators think in terms of spreadsheet edits, not individual table timers.
- It reduces redundant work during bursty user editing sessions.

### Runtime ownership

- API route receives the Drive webhook notification.
- `ControlPlaneDO` owns watch registry and spreadsheet-level debounce state.
- `ProjectDO` continues to own project and table config lookup.
- `TableDO` continues to own actual reindex execution and cache metadata.

### Observability

Add explicit state for:

- last external change timestamp
- whether an external reindex is pending
- debounce deadline / next eligible reindex time
- last external reindex trigger time

Logs should distinguish:

- notification received
- notification ignored or rejected
- debounce scheduled or refreshed
- automatic external reindex started
- automatic external reindex succeeded
- automatic external reindex failed

## Implementation Steps

### 1. Contracts and cache-status surface

Add explicit contract fields so operators and tests can reason about the feature:

- extend `TableCacheStatus` with an `externalChange` object:
  - `pending: boolean`
  - `lastChangedAt: string | null`
  - `debounceUntil: string | null`
  - `lastAutoReindexAt: string | null`
- extend `staleReason` enum to include `external-change`
- update API and RPC result schemas
- update admin and script clients that read cache status

Acceptance:

- contracts compile cleanly
- existing cache status routes still validate
- admin and script fixtures include the new shape

### 2. Control-plane spreadsheet watch state

Add a control-plane SQLite table for spreadsheet watch state:

- `spreadsheet_watch_state`
  - `spreadsheet_id`
  - `channel_id`
  - `resource_id`
  - `resource_uri`
  - `expiration_at`
  - `last_notification_at`
  - `debounce_until`
  - `last_auto_reindex_at`

Add control-plane methods to:

- upsert watch metadata
- record notification receipt
- resolve tables by spreadsheet ID

Acceptance:

- state survives across requests
- registry lookup finds all tables for a spreadsheet

### 3. Table external-change metadata

Add `TableDO` metadata helpers:

- mark external change pending
- clear external change after successful auto reindex
- preserve external change details on failed auto reindex

`getCacheState()` should report:

- `staleReason: "external-change"` when pending external change exists
- the external-change object in cache status

Acceptance:

- cache status reflects pending external change without forcing immediate sync
- successful mutation/full sync interactions remain coherent

### 4. Debounced reindex orchestration

Add a control-plane orchestration method that:

- receives spreadsheet ID
- records/refreshes `last_notification_at`
- computes `debounce_until`
- marks affected tables as externally dirty
- schedules or performs the debounced reindex pass

Implementation note:

- prefer a simple alarm-like approach inside the DO if available in this runtime
- otherwise perform a cheap "reindex if deadline reached" check on each incoming notification and on explicit operator fetches of watch status

The first implementation should favor correctness and simplicity over perfect timer precision.

Acceptance:

- repeated notifications during the debounce window produce one eventual reindex
- multiple tables on the same spreadsheet are coalesced together

### 5. Drive webhook endpoint

Add an authenticated admin/webhook route in `apps/api` for Drive notifications.

Responsibilities:

- validate Google notification headers
- reject malformed or unknown channels
- map the file change to spreadsheet ID
- forward to control-plane orchestration
- return a fast success response

Security:

- only accept configured watch channels
- require channel ID/resource ID matching
- avoid treating arbitrary POSTs as spreadsheet changes

Acceptance:

- invalid notifications are rejected clearly
- valid notifications update watch/debounce state

### 6. Watch creation and renewal

Add operator automation for creating or renewing Drive watch channels.

Likely script shape:

- `npm run ops:watch:drive`

Responsibilities:

- enumerate configured spreadsheets from the control plane
- call Drive `files.watch` or equivalent supported watch path
- persist returned channel metadata
- print a concise operator summary

This first implementation may be manual/explicit rather than fully automatic renewal.

Acceptance:

- operator can create watches intentionally
- repo docs explain renewal/expiration expectations

### 7. Auto-reindex execution path

Add a control-plane method that triggers automatic reindex for all tables affected by a spreadsheet change:

- call the existing `table.reindex` path with a request context that identifies the trigger as external-drive-change
- update spreadsheet/table watch state on success/failure
- keep per-table failures isolated

Acceptance:

- one failing table does not block others from reindexing
- request context/logs identify external auto reindex distinctly from manual admin reindex

### 8. Admin UI and operator tooling

Update the admin UI and scripts to show:

- pending external change
- debounce deadline
- last auto reindex
- external-change stale reason

Update cache-health reporting so pending external change is visible.

Acceptance:

- operator can tell whether auto reindex is pending, completed, or failed

### 9. Tests

Add coverage across:

- contract/schema validation
- control-plane watch state persistence
- webhook validation and routing
- debounce coalescing
- table cache status for external-change state
- successful and failed auto reindex behavior
- admin UI rendering of external-change status

Required regression cases:

- multiple notifications within window yield one auto reindex
- external change marks cache stale even before reindex runs
- successful auto reindex clears pending external state
- failed auto reindex preserves pending/error visibility
- unknown/forged notification is rejected

### 10. Docs

Update:

- `README.md`
- `docs/quickstart.md`
- `docs/operator-runbook.md`
- `docs/observability.md`

Document:

- feature purpose
- operator setup
- watch expiration/renewal
- debounce behavior
- exact cache-status meaning
- failure handling and manual fallback to `ops:reindex`

## Suggested Delivery Batches

### Batch 1

- contract additions
- `TableDO` external-change metadata/status
- tests for cache-status surface

### Batch 2

- control-plane watch state
- debounce orchestration primitives
- tests for state transitions

### Batch 3

- Drive webhook route
- auto-reindex path
- end-to-end tests for notification to reindex flow

### Batch 4

- operator script for watch registration
- admin UI/docs/observability updates

## Open Decisions

### Watch endpoint choice

Validate the exact Drive watch method to use for the spreadsheet file in implementation:

- likely file-level watch for each spreadsheet
- only fall back to broader user change-log watch if file-level watch is materially worse operationally

### Renewal strategy

First pass should support explicit/manual renewal if that keeps the system simpler.

Automatic renewal can be added only if:

- expiration handling is well tested
- state transitions stay explicit to operators

### Debounce duration

Default target: 30 seconds.

Reasoning:

- fast enough to feel automatic
- long enough to collapse bursty human edits

Make this configurable only if there is a strong need.

## Acceptance Criteria

The feature is complete when:

- a valid Drive notification marks the mapped table caches as externally changed
- repeated notifications within the debounce window coalesce into one eventual reindex
- cache status and admin UI show pending external change explicitly
- automatic reindex uses the existing safe reindex path
- logs clearly show notification, debounce, and auto-reindex outcomes
- docs explain setup, limits, and failure handling
- `npm run check` passes
