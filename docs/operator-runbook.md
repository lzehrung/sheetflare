# Operator Runbook

This runbook is for operators running a deployed Sheetflare instance.

It assumes:

- the API Worker is already deployed
- you have a base URL
- you have the bootstrap admin bearer token or an admin API key

## Core Concepts

- Google Sheets is the upstream source of truth.
- `TableDO` SQLite is the normal read surface.
- Row numbers are cache state, not stable identity.
- Managed row IDs are required and must stay unique and non-blank.

## Bootstrap Setup

1. Set the base URL:

```powershell
$env:SHEETFLARE_BASE_URL = "https://your-worker.example.workers.dev"
```

2. Set the bootstrap bearer token:

```powershell
$env:SHEETFLARE_ADMIN_CREDENTIAL = "<ADMIN_BEARER_TOKEN>"
```

3. Create a scoped admin key and stop using the bootstrap token for routine work:

```powershell
$env:SHEETFLARE_ADMIN_KEY_NAME = "ops-admin"
npm run ops:create-admin-key
```

Bootstrap projects, tables, and API keys from one JSON config:

```powershell
npm run ops:bootstrap
```

Treat `ADMIN_BEARER_TOKEN` as break-glass only.
For routine scripts, set `SHEETFLARE_ADMIN_CREDENTIAL` to the scoped admin API key instead.

For Google credential setup details, use [google-service-accounts.md](./google-service-accounts.md).

## Check Cache Status

Set the target table:

```powershell
$env:SHEETFLARE_PROJECT = "demo"
$env:SHEETFLARE_TABLE = "users"
```

Fetch status:

```powershell
npm run ops:cache
```

Important fields:

- `status`
- `stale`
- `staleReason`
- `rowCount`
- `lastSyncStartedAt`
- `lastSyncCompletedAt`
- `lastSyncError`

Interpretation:

- `fresh`: cache is usable and within TTL/config
- `never-synced`: table has not completed its first sync
- `ttl-expired`: cache is old but point reads and mutations can still use narrow repair behavior
- `config-changed`: table config changed in a way that requires resync
- `error`: last sync failed and needs investigation

For critical tables, automate this check:

```powershell
$env:SHEETFLARE_CACHE_HEALTH_TABLES_JSON = '[{"project":"demo","table":"users"}]'
npm run ops:cache:health
```

This exits non-zero when a critical table is not healthy.

## Force Reindex

Use when:

- a table is stuck in `error`
- sheet structure was repaired manually
- indexed fields changed
- you want to verify the cache can fully rebuild

Command:

```powershell
npm run ops:reindex
```

Expected result:

- `ok: true`
- `cache.status: "ready"`
- `cache.staleReason: "fresh"` for a successful healthy rebuild

## Interpreting Common Failures

### Duplicate managed row IDs

Symptoms:

- sync fails
- list/reindex returns an error about duplicate managed row ID

Cause:

- two rows in the configured ID column contain the same non-blank ID

Fix:

1. Open the source sheet.
2. Find duplicate values in the managed ID column.
3. Make every managed ID unique.
4. Run `npm run ops:reindex`.

### Blank managed row IDs

Symptoms:

- sync fails
- list/reindex returns an error about blank managed row ID

Cause:

- one or more data rows have an empty cell in the configured ID column

Fix:

1. Open the source sheet.
2. Fill every blank managed ID cell with a stable unique ID.
3. Run `npm run ops:reindex`.

### Duplicate header names

Symptoms:

- sync fails with duplicate header error

Cause:

- the configured header row contains the same non-empty column name more than once

Fix:

1. Rename the duplicate columns so each non-empty header is unique.
2. Run `npm run ops:reindex`.

### Full-scan rejection

Symptoms:

- a query fails with an error saying it requires a full scan beyond the configured threshold

Cause:

- the query uses a scan-heavy operator such as `contains` on a large cached table

Fix:

1. Prefer indexed equality/range queries.
2. Add an index if the query pattern is legitimate and frequent.
3. If the query is inherently scan-heavy, narrow it or accept that the API will reject it.

## Rotating Credentials

### Rotate Google credentials

1. Update the deployed secret or variable backing `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`, or update the named ref in `GOOGLE_CREDENTIALS_JSON`.
2. Confirm project config still references the correct credential ref.
3. Reindex one table on each affected project.
4. Verify cache status returns to `fresh`.

Use [google-service-accounts.md](./google-service-accounts.md) if you need the exact secret layout, named credential JSON shape, or key-rotation sequence.

### Rotate bootstrap admin token

1. Create or confirm a working admin API key first.
2. Replace `ADMIN_BEARER_TOKEN` in the deployed environment.
3. Verify bootstrap auth only if you intentionally keep it enabled.
4. Keep routine operations on the scoped admin API key.

## Production Smoke Check

Set the required environment variables documented in [deploy.md](./deploy.md), then run:

```powershell
npm run smoke:staging
```

The smoke script verifies:

- readiness endpoint internal checks
- admin route access
- private-table anonymous rejection
- private-table keyed reads
- public-read anonymous access
- public-read anonymous write rejection
- cache status `staleReason`
- create/get/update/delete on a smoke row
- admin reindex

If you are validating for broader external use, also run:

```powershell
npm run load:staging
```

Use [benchmarking.md](./benchmarking.md) and [observability.md](./observability.md) for the reporting and alerting workflow around those runs.

## When To Escalate

Escalate to code investigation when:

- sync repeatedly returns `error` after the sheet is visibly corrected
- row counts drift unexpectedly after healthy reindex
- point reads or mutations start failing while IDs remain unique and non-blank
- rate-limit behavior looks wrong across principals or route families
