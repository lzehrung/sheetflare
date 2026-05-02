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

Preferred first-run path:

```powershell
npm run setup
```

That command can write `sheetflare.setup.json`, deploy, bootstrap, and smoke-check the first project.
It also keeps local reusable secret state in `.sheetflare.setup.local.json`; treat that file as secret material and keep it on the operator machine only.

Post-deploy verification path:

```powershell
npm run setup -- --verify
```

That re-checks the resolved Google credential source, Worker `/ready`, protected admin root plus proxied `/docs`, and Drive watch coverage for the spreadsheets declared in the setup config.

Manual fallback:

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

Project deletion is destructive for Sheetflare-managed control-plane state only. It clears configured table caches before removing project metadata, revokes API keys scoped to that project, and stops Google Drive watches for spreadsheets no remaining project uses. It does not delete the upstream Google spreadsheet.

For Google credential setup details, use [google-service-accounts.md](./google-service-accounts.md).

## Bootstrap A New Spreadsheet-Backed Project

When you are onboarding a spreadsheet for the first time, the minimal operator flow is:

1. Share the spreadsheet with the configured Sheetflare service-account email as an `Editor`.
2. Confirm the source tab has a stable `_id` column with unique non-blank values.
3. Decide whether any columns must stay sheet-managed, for example formula or operator-owned columns, and list them in `readOnlyFields`.
4. Decide whether the API should enforce `fieldRules` such as required, unique, enum, normalize, or type checks.
5. Set `SHEETFLARE_BOOTSTRAP_CONFIG_JSON`.
6. Run `npm run ops:bootstrap`.

Example:

```powershell
$env:SHEETFLARE_BOOTSTRAP_CONFIG_JSON = @'
{
  "projects": [
    {
      "slug": "demo-private",
      "name": "Demo Private",
      "spreadsheetId": "<SPREADSHEET_ID>",
      "googleCredentialRef": "default",
      "defaultAuthMode": "private",
      "tables": [
        {
          "tableSlug": "users",
          "sheetTabName": "Users",
          "idColumn": "_id",
          "indexedFields": ["name", "status"],
          "readOnlyFields": ["status_label"],
          "fieldRules": {
            "email": {
              "required": true,
              "unique": true,
              "normalize": ["trim", "lowercase"]
            },
            "status": {
              "enum": ["pending", "active"]
            }
          },
          "cacheTtlSeconds": 15
        }
      ]
    }
  ],
  "apiKeys": [
    {
      "name": "private-read",
      "projectSlug": "demo-private",
      "scopes": ["table:read"]
    },
    {
      "name": "mutation",
      "projectSlug": "demo-private",
      "scopes": ["table:create", "table:update", "table:delete"]
    }
  ]
}
'@

npm run ops:bootstrap
```

For a public anonymous read surface, create a separate project with `defaultAuthMode` set to `"public-read"` rather than widening the private project's auth model.

`readOnlyFields` is the right tool when:

- a column is driven by a sheet formula
- a column is maintained manually in Sheets
- the API should expose the value but must never overwrite it

`fieldRules` are the right tool when:

- a value must be present on API writes
- a field should only allow a fixed set of string values
- a field such as `email` must stay unique
- a value should be normalized before write, for example trimmed/lowercased email
- a field should reject non-numeric, non-boolean, or non-ISO date inputs

Raw sheet reads remain string-first. If a column needs typed validation or typed indexed filtering, declare that explicitly with `fieldRules.type` instead of relying on the cell text to be inferred.

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
- `validation`

`lastSyncStartedAt`, `lastSyncCompletedAt`, and `validation` describe the last full cache rebuild from Google Sheets. Successful point mutations update the cache in place but do not rewrite those sync timestamps.

Interpretation:

- `fresh`: cache is usable and within TTL/config
- `never-synced`: table has not completed its first sync
- `ttl-expired`: cache is old but point reads and mutations can still use narrow repair behavior
- `config-changed`: table config changed in a way that requires resync
- `external-change`: Google Drive reported a spreadsheet update and a debounced auto-reindex is pending
- `error`: last sync failed and needs investigation

Validation interpretation:

- `validation.status: "ok"`: the last full sync did not detect field-rule drift
- `validation.status: "warning"`: the last full sync found rows that violate configured `fieldRules`, for example duplicates after normalization or invalid enum/type values
- `validation.validatedAt`: when that validation snapshot was last recomputed during a full sync
- `validation.issues`: a capped sample for operator triage, not an exhaustive dump
- `externalChange.pending`: Drive notification arrived and the debounce window has not completed yet
- `externalChange.debounceUntil`: when the queued automatic reindex is due
- `externalChange.lastAutoReindexAt`: when the last Drive-triggered automatic reindex completed

For critical tables, automate this check:

```powershell
$env:SHEETFLARE_CACHE_HEALTH_TABLES_JSON = '[{"project":"demo","table":"users"}]'
npm run ops:cache:health
```

This exits non-zero when a critical table is not healthy.

## Retire Projects Or Tables

Use the admin UI for routine cleanup. The `Delete table` and `Delete project` actions remove Sheetflare configuration and clear local Durable Object cache state, but they do not delete the upstream Google Sheets tab or spreadsheet.

Direct API equivalents:

```powershell
$headers = @{ Authorization = "Bearer $env:SHEETFLARE_ADMIN_CREDENTIAL" }
Invoke-RestMethod -Method Delete -Headers $headers -Uri "$env:SHEETFLARE_BASE_URL/v1/admin/projects/$env:SHEETFLARE_PROJECT/tables/$env:SHEETFLARE_TABLE"
Invoke-RestMethod -Method Delete -Headers $headers -Uri "$env:SHEETFLARE_BASE_URL/v1/admin/projects/$env:SHEETFLARE_PROJECT"
```

After deleting a table or project, rerun `npm run ops:cache:health` for the remaining critical tables so monitoring configuration does not still point at retired resources.

## Register Drive Watches

Automatic debounced reindexing requires one Drive watch per spreadsheet.

Prerequisites:

- `GOOGLE_DRIVE_WEBHOOK_SECRET` is configured on the API Worker
- the Google Drive API is enabled for the same Google Cloud project as the service account
- the deployed Worker URL is reachable from Google

Register or renew all spreadsheet watches currently known to Sheetflare:

```powershell
npm run ops:watch:drive
```

Inspect current watch status:

```powershell
npm run ops:watch:drive:status
```

Get retry timing guidance derived from the current watch state and the last known stopped watch:

```powershell
npm run ops:watch:drive:retry-advice
```

Stop all known spreadsheet watches or one known spreadsheet watch before re-registering:

```powershell
npm run ops:watch:drive:stop
```

```powershell
$env:SHEETFLARE_DRIVE_WATCH_SPREADSHEET_ID = "your-spreadsheet-id"
npm run ops:watch:drive:stop
```

Optional overrides:

```powershell
$env:SHEETFLARE_DRIVE_WATCH_DEBOUNCE_SECONDS = "45"
$env:SHEETFLARE_DRIVE_WATCH_EXPIRATION_HOURS = "168"
npm run ops:watch:drive
```

Re-run this after:

- rotating `GOOGLE_DRIVE_WEBHOOK_SECRET`
- changing the deployed API base URL
- onboarding new spreadsheets

Operational notes:

- Sheetflare renews existing Drive watches before they expire when the control-plane alarm is healthy
- manual re-registration now retries once after stopping the currently known watch when Google rejects replacement with a file-subscription quota error
- `expirationAt` and `lastWatchError` from `npm run ops:watch:drive:status` are the primary signals for renewal health
- if a watch has expired or `lastWatchError` remains non-null, rerun `npm run ops:watch:drive` and investigate Worker logs
- if Google returns `Rate limit exceeded for creating file subscriptions.`, stop known watches with `npm run ops:watch:drive:stop`, wait for Google to release stale subscriptions, then retry registration
- `npm run ops:watch:drive:retry-advice` shows the current helper view of whether a spreadsheet is still cooling down and the earliest conservative retry time
- Google Drive watch behavior is documented at:
  - https://developers.google.com/workspace/drive/api/guides/push
  - https://developers.google.com/workspace/drive/api/reference/rest/v3/files/watch
  - https://developers.google.com/workspace/drive/api/reference/rest/v3/channels/stop

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
npm run smoke
```

The smoke script verifies:

- readiness endpoint internal checks
- admin route access
- private-table anonymous rejection
- private-table keyed reads
- cache status `staleReason`
- create/get/update/delete on a smoke row
- admin reindex

When `SHEETFLARE_PUBLIC_PROJECT` and `SHEETFLARE_PUBLIC_TABLE` are set, it also verifies:

- public-read anonymous access
- public-read anonymous write rejection

If you are validating for broader external use, also run:

```powershell
npm run load
```

Use [benchmarking.md](./benchmarking.md) and [observability.md](./observability.md) for the reporting and alerting workflow around those runs.

## When To Escalate

Escalate to code investigation when:

- sync repeatedly returns `error` after the sheet is visibly corrected
- row counts drift unexpectedly after healthy reindex
- point reads or mutations start failing while IDs remain unique and non-blank
- rate-limit behavior looks wrong across principals or route families
