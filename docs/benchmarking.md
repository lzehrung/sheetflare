# Benchmarking And Validation

This document defines how to generate the evidence bundle needed for broader production use.

## Staging Smoke Report

The smoke harness can now write both markdown and JSON artifacts.

Set the normal smoke environment plus a report path:

```powershell
$env:SHEETFLARE_SMOKE_REPORT_PATH = "reports/staging/smoke-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run smoke
```

Artifacts written:

- `<report>.md`: human-readable staging validation report
- `<report>.json`: structured artifact for automation or later comparison

The smoke report captures:

- readiness
- admin route access
- private/public auth behavior
- cache status
- create/get/update/delete
- reindex
- request and response samples for each major path

## Load And Churn Report

Set the same staging variables used by the smoke harness, then add:

```powershell
$env:SHEETFLARE_LOAD_REPORT_PATH = "reports/staging/load-$(Get-Date -Format yyyyMMdd-HHmmss).md"
$env:SHEETFLARE_LOAD_STALE_WAIT_MS = "16000"
$env:SHEETFLARE_LOAD_MANUAL_CHURN_PAUSE_MS = "30000"
npm run load
```

Artifacts written:

- `<report>.md`: benchmark summary
- `<report>.json`: structured latency/failure artifact

The load harness covers:

- indexed list queries on a hot table
- repeated point reads after a stale wait window
- mixed create/update/delete cycles
- rate-limit pressure on one principal
- anonymous-read separation across many synthetic principals
- reindex while reads continue
- optional manual churn window for direct sheet edits during traffic

## Recommended First Pilot Settings

Use these as a conservative first pass, not as a proven public limit:

- `TABLE_MAX_FULL_SCAN_ROWS=10000`
- `cacheTtlSeconds` between `15` and `60`
- one hot table per meaningful workload, because each table is one `TableDO`
- no more than `32` indexed fields including the managed ID column
- treat `contains` as a bounded operator, not as a default public query primitive

## What To Publish After A Real Run

After running `npm run smoke` and `npm run load` against a real deployment, publish these numbers in the root README:

- row count tested
- configured `TABLE_MAX_FULL_SCAN_ROWS`
- request mix
- concurrency used
- p50 / p95 / max latency per scenario
- first `429` point for same-principal pressure
- whether manual churn was exercised
- any observed Cloudflare or app-level limits
