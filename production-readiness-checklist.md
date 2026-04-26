# Production Readiness Checklist

This document defines what must be true before Sheetflare should be trusted for production use beyond a controlled internal deployment.

The standard is not "the tests pass."

The standard is:

- correctness under real sheet drift
- clear operational behavior under failure
- known scale limits
- secure day-2 operation
- repeatable deploy and rollback behavior

## Current Assessment

Today the system is reasonable for:

- controlled self-hosted deployment
- known workloads
- an operator who understands the constraints

Today the system is not yet proven for:

- unknown customer workloads
- large public-read traffic
- hands-off operations
- incident response without repo familiarity

## Exit Criteria

Do not call the system production-ready for broad external use until every item in `Required Before External Production` is complete and verified.

Each item below has:

- goal
- exact change or activity
- proof required

## Required Before External Production

### 1. Real staging deployment validation

Goal:
- prove the deployed Cloudflare Worker + Durable Objects + Google Sheets integration behaves the same as the local harnessed tests

Exact work:
- deploy a staging Worker with real Durable Objects and a real test spreadsheet
- create at least two staging projects:
  - one `private`
  - one `public-read`
- configure at least two tables:
  - small table
  - large table with enough rows to cross the full-scan threshold
- run a scripted smoke suite against the deployed staging base URL

The smoke suite must verify:
- cold `list` triggers sync and succeeds
- warm `list` stays cached
- stale `get` still resolves correctly
- create updates sheet and cache
- update still succeeds after manual sheet row reordering
- delete repairs cached row numbers correctly
- duplicate managed IDs fail clearly
- blank managed IDs fail clearly
- `public-read` tables allow anonymous read and still block writes
- `private` tables reject anonymous read
- `contains` over threshold fails with the documented error
- cache status exposes `staleReason`

Proof required:
- committed smoke script or test harness in the repo
- staging run output captured in a short markdown report
- at least one example request/response per major path

### 2. Publish the scale envelope

Goal:
- replace implicit limits with explicit operator-facing constraints

Exact work:
- document supported and unsupported workload shapes in `README.md`
- include:
  - expected concurrency model per table
  - effect of one `TableDO` per table
  - meaning of `maxFullScanRows`
  - which filters are index-backed
  - which queries can force scan rejection
  - expected impact of large `contains` queries
- state a recommended initial operating envelope, for example:
  - maximum tested row count
  - maximum tested indexed field count
  - expected request rate per hot table
  - recommended `cacheTtlSeconds` ranges

Proof required:
- README section updated with concrete numbers, not vague warnings
- numbers tied to an actual benchmark or staging test result

### 3. Add load and churn testing

Goal:
- prove the design holds under realistic sustained use

Exact work:
- add a repeatable load test script for the staging deployment
- test at minimum:
  - repeated indexed `list` queries on a hot table
  - repeated point reads on stale TTL
  - mixed create/update/delete on a writable table
  - repeated rate-limit checks across many principals
  - reindex while reads continue
- include a churn scenario where the underlying sheet is manually edited during API traffic

Success criteria must include:
- no incorrect row returned
- no duplicate or phantom rows after mutation
- no stuck `syncing` state
- no cache corruption after failed sync
- acceptable latency for indexed reads and point mutations

Proof required:
- committed load script
- recorded benchmark summary with:
  - row count
  - request mix
  - latency percentiles
  - failure count
  - observed Cloudflare or application limits

### 4. Add a production operator runbook

Goal:
- make failures supportable without reading the source

Exact work:
- add `docs/operator-runbook.md`
- cover:
  - bootstrap setup
  - creating admin keys
  - rotating Google credentials
  - rotating admin bootstrap token
  - interpreting cache status fields
  - interpreting `staleReason`
  - what to do when sync fails
  - what to do when a sheet has duplicate IDs
  - what to do when a sheet has blank IDs
  - when to force reindex
  - when to reduce query shape or add an index

Proof required:
- runbook exists and is linked from root README
- each operator endpoint used in the runbook has a real example command

### 5. Add alertable observability

Goal:
- move from logs-only debugging to actionable production signals

Exact work:
- define a minimal metrics and alerting plan
- at minimum capture and alert on:
  - `table.sync.failed`
  - repeated `staleReason: error`
  - repeated `429` responses
  - auth failures above a threshold
  - sync duration outliers
  - cache row count jumps or drops after sync
- if external metrics are not added in-code, document the exact log fields and log queries needed in the chosen platform

Proof required:
- documented alert conditions
- one tested failure example for sync failure and one for rate-limit pressure

### 6. Tighten bootstrap admin handling

Goal:
- ensure `ADMIN_BEARER_TOKEN` is break-glass only

Exact work:
- update docs so the normal path is:
  - deploy with bootstrap token
  - mint scoped admin API key
  - stop using bootstrap token for routine work
- optionally add an env-controlled mode to disable bootstrap auth after initial setup
- document token rotation procedure

Proof required:
- README or runbook explicitly marks bootstrap token as break-glass
- if disable-bootstrap mode is added, it has tests

### 7. Add deployment and rollback procedure

Goal:
- make release behavior predictable under bad deploys

Exact work:
- add `docs/deploy.md` with:
  - required env vars and secrets
  - deploy command
  - post-deploy smoke checks
  - rollback command or rollback procedure
  - how to verify Durable Object migrations are correct
- include a release checklist with:
  - `npm run lint`
  - `npm test`
  - `npm run typecheck`
  - `npm run build`
  - staging smoke pass

Proof required:
- deployment doc exists
- at least one real staging deploy has been executed using that procedure

## Strongly Recommended Code Changes

These are not all blockers, but they materially improve trust.

### 1. Make scan threshold configurable

Why:
- `maxFullScanRows` is currently hard-coded in [packages/cloudflare/src/do/table-do.ts](./packages/cloudflare/src/do/table-do.ts)

Change:
- move it to configuration with a safe default
- expose the configured value in docs and possibly cache/query error details

Proof:
- tests for default and override behavior

### 2. Add sync-duration and row-count assertions in tests

Why:
- current tests prove behavior, but not operational sanity signals

Change:
- add assertions that sync status transitions and row counts remain coherent after failure and recovery

Proof:
- regression tests around failure, recovery, and reindex

### 3. Add a small `scripts/` toolkit for operators

Why:
- repeatable operations reduce support burden

Change:
- add scripts for:
  - mint admin key
  - reindex table
  - fetch cache status
  - run staging smoke suite

Proof:
- scripts are documented and runnable

## Suggested Validation Order

Do these in order:

1. Add the operator runbook and deploy doc.
2. Build the staging smoke suite.
3. Deploy staging and capture a passing report.
4. Add load/churn testing and capture benchmark limits.
5. Update README with the proven operating envelope.
6. Add alerts or documented log-based alert queries.
7. Decide whether bootstrap admin disablement is required for your environment.

## Minimum Evidence Bundle Before Launch

Before saying "production-ready," the repo should contain:

- `production-readiness-checklist.md`
- `docs/operator-runbook.md`
- `docs/deploy.md`
- staging smoke script
- load or churn test script
- one short staging validation report
- one short benchmark report

## Final Gate

The system is ready for broader production use only when all of the following are true:

- deployed staging smoke suite passes
- load/churn tests define and confirm the supported operating envelope
- operator runbook exists and is usable by someone other than the implementer
- alerts exist for sync failure, stale error state, and rate-limit pressure
- release and rollback procedure has been exercised at least once
- README documents the actual tested limits and constraints

Until then, treat the system as production-capable for controlled deployments, not production-proven for general external use.
