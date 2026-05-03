# Benchmarking And Validation

This document defines how to generate the evidence bundle needed for broader production use.

## Smoke Report

The smoke harness writes both markdown and JSON artifacts.

Set the normal smoke environment plus a report path:

```powershell
$env:SHEETFLARE_SMOKE_REPORT_PATH = "reports/smoke-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run smoke
```

Artifacts written:

- `<report>.md`: human-readable deployment validation report
- `<report>.json`: structured artifact for automation or later comparison

The smoke report captures:

- readiness
- admin route access
- private/public auth behavior
- cache status
- create/get/update/delete
- reindex
- request and response samples for each major path

## Large Sheet Benchmark

The benchmark suite is the primary way to prove the system still behaves well at very large sizes.
It is designed around a dedicated benchmark table with writable columns and a target row count of `500000` by default.

Set the same base environment used by smoke for the admin/read paths, then add the benchmark-specific values:

```powershell
$env:SHEETFLARE_BASE_URL = "https://<worker-host>"
$env:SHEETFLARE_ADMIN_CREDENTIAL = "<admin-token>"
$env:SHEETFLARE_PRIVATE_PROJECT = "<project-slug>"
$env:SHEETFLARE_PRIVATE_TABLE = "<table-slug>"
$env:SHEETFLARE_PRIVATE_READ_KEY = "<private-read-key>"
$env:SHEETFLARE_BENCHMARK_REPORT_PATH = "reports/benchmark-$(Get-Date -Format yyyyMMdd-HHmmss).md"
$env:SHEETFLARE_BENCHMARK_TARGET_ROWS = "500000"
$env:SHEETFLARE_BENCHMARK_BATCH_ROWS = "1000"
$env:SHEETFLARE_BENCHMARK_STALE_WAIT_MS = "16000"
$env:GOOGLE_CLIENT_EMAIL = "<service-account-email>"
$env:GOOGLE_PRIVATE_KEY = "<service-account-private-key>"
npm run benchmark
```

Use a smaller `SHEETFLARE_BENCHMARK_BATCH_ROWS` if you want shorter individual Google Sheets writes during seed, or keep the default `1000` for fewer requests.

Artifacts written:

- `<report>.md`: benchmark summary
- `<report>.json`: structured latency, seed, and failure artifact

Set `SHEETFLARE_BENCHMARK_STALE_WAIT_MS` to `0` if you want to skip the stale-wait phase for a quick operator smoke check.

The benchmark suite:

- seeds or tops up the configured table to the target row count directly through Google Sheets
- clears any excess rows when the table is larger than the requested target
- forces a reindex and records the rebuild time
- measures hot indexed list reads
- measures point reads after a stale-wait window
- confirms `contains` is rejected on a large table instead of silently degrading into a scan
- measures reindex while reads continue

Recommended benchmark table shape:

- a managed ID column such as `_id`
- at least one additional indexed string field such as `name`
- an optional status field such as `status`
- an optional numeric field such as `score`
- no read-only or formula-managed columns in the benchmark table itself

## Load And Churn Report

The load harness is still useful for steady-state pressure tests once the large-sheet path is proven.

Set the same smoke variables used by the smoke harness, then add:

```powershell
$env:SHEETFLARE_LOAD_REPORT_PATH = "reports/load-$(Get-Date -Format yyyyMMdd-HHmmss).md"
$env:SHEETFLARE_LOAD_STALE_WAIT_MS = "16000"
$env:SHEETFLARE_LOAD_MANUAL_CHURN_PAUSE_MS = "30000"
npm run load
```

Artifacts written:

- `<report>.md`: load summary
- `<report>.json`: structured latency/failure artifact

The load harness covers:

- indexed list queries on a hot table
- repeated point reads after a stale wait window
- mixed create/update/delete cycles
- rate-limit pressure on one principal
- anonymous-read separation across many synthetic principals
- reindex while reads continue
- optional manual churn window for direct sheet edits during traffic

## Recommended Starting Constraints

Use these as a conservative first pass, not as a proven public limit:

- `TABLE_MAX_FULL_SCAN_ROWS=10000`
- `cacheTtlSeconds` between `15` and `60`
- one hot table per meaningful workload, because each table is one `TableDO`
- no more than `32` indexed fields including the managed ID column
- treat `contains` as a bounded operator, not as a default public query primitive

## What To Publish After A Real Run

After running `npm run smoke`, `npm run benchmark`, and `npm run load` against a real deployment, publish these numbers in the root README:

- benchmark target row count
- seeded row count before the run
- configured `TABLE_MAX_FULL_SCAN_ROWS`
- request mix
- concurrency used
- seed duration
- reindex duration
- p50 / p95 / max latency per scenario
- first `429` point for same-principal pressure
- whether manual churn was exercised
- any observed Cloudflare or app-level limits
