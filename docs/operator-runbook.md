# Operator Runbook

This runbook is for operators running a deployed Sheetflare instance.

It assumes:

- the API Worker is already deployed
- you have a base URL
- you have the bootstrap admin bearer token or an admin API key

## Core Concepts

- **Google Sheets is the source of truth.** Sheetflare syncs from it; data is never migrated away from the sheet.
- **Reads go to a local cache, not directly to Google.** Each table's Durable Object maintains a SQLite row cache. API reads and queries serve from that cache, which keeps read latency independent of Google API response times.
- **Row numbers change; row IDs do not.** When someone reorders the sheet, row numbers shift. Sheetflare always re-resolves rows by the managed ID column before writing, so reordering is safe.
- **Every managed ID must be unique and non-blank.** Duplicate or missing IDs in the ID column block syncs and must be fixed in the sheet before reindexing will succeed.

## Bootstrap Setup

Preferred first-run path:

```powershell
npm run setup
```

That command can write `sheetflare.setup.json`, deploy, bootstrap, and smoke-check the first project.
It also keeps reusable API deployment state in `.sheetflare.setup.local.json`. The file is gitignored, contains no admin credential, and should remain on the operator machine.

Post-deploy verification path:

```powershell
npm run setup -- --verify
```

That re-checks the resolved Google credential source, Worker `/ready`, the hosted admin UI state, and Drive watch coverage for the spreadsheets declared in the setup config. Verification is Worker-only and does not require Wrangler authentication.

## Use The Admin UI

Open `https://<your-worker>/admin/` and sign in with a scoped admin API key. The hosted UI needs no local tooling and calls the same authenticated `/v1/admin/*` routes as the CLI. If `/admin/` returns `404`, the deployment has `adminUi` disabled; if it returns `503`, run `npm run doctor` and redeploy. Switch, headers, and optional Cloudflare Access hardening are in [deploy.md](./deploy.md#admin-ui).

### Run The Admin UI Locally

Optional, for UI development, a disabled hosted admin, or CLI-held credentials:

```powershell
npm run dev:admin
```

Open `http://127.0.0.1:4173`. The Vite server binds exactly to loopback on fixed port `4173`; do not pass `--host 0.0.0.0`, use a LAN hostname, or expose it through a public tunnel.

The proxy targets `SHEETFLARE_API_BASE_URL` when set, otherwise `apiUrl` from `.sheetflare.setup.local.json`, otherwise `http://127.0.0.1:8787`. Remote targets must use HTTPS because the proxy forwards the credential as bearer authorization. To target a local Worker explicitly:

```powershell
$env:SHEETFLARE_API_BASE_URL = "http://127.0.0.1:8787"
npm run dev:admin
```

Set `SHEETFLARE_ADMIN_CREDENTIAL` to a scoped admin API key before `npm run dev:admin` and the UI loads without a prompt; the local server attaches the key upstream and the browser never receives it. Without that variable, paste a scoped key; the UI keeps it in memory for the current session only. Use the bootstrap token only as break-glass. Credential precedence, request protections, and password-manager guidance are in [deploy.md](./deploy.md#admin-credential).

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
Project-scoped admin keys with `admin:keys` can create keys only for their own project and only with scopes the caller already has.

Project deletion is destructive for Sheetflare-managed control-plane state only. It clears configured table caches before removing project metadata, revokes API keys scoped to that project, and stops Google Drive watches for spreadsheets no remaining projects use. It does not delete the upstream Google spreadsheet. Delete requests are idempotent, so retrying an already-completed delete returns success.

Requests that create or delete a project, or create or delete one of its tables, run one at a time per project in arrival order. A table request sent while the project is being deleted waits for the delete to finish and cannot put the project back in the registry.

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

Projects and tables are upserted, so `npm run ops:bootstrap` is safe to rerun. API keys are not: a key whose `name` already has an active key is skipped (the output lists it under `skippedKeys`), so a rerun never stacks duplicate privileged keys. Give a new key a new name, or rotate as described in [Rotate API keys](#rotate-api-keys).

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

`lastSyncStartedAt` and `validation` change only on a full rebuild from Google Sheets. A successful create or update refreshes the cache in place and sets `lastSyncCompletedAt` to the mutation time, which also restarts the TTL clock. A delete does the same only when the cache was fresh and the header layout is unchanged; otherwise it triggers a full rebuild, which sets all of these normally. Point mutations do not recompute `validation`.

Interpretation:

- `fresh`: cache is usable and within TTL/config
- `never-synced`: table has not completed its first sync
- `ttl-expired`: cache is old but point reads and mutations can still use narrow repair behavior
- `config-changed`: table config changed in a way that requires resync
- `external-change`: Google Drive reported a spreadsheet update and a debounced auto-reindex is pending, or a write overlapped a sync so the synced snapshot may lack it. An overlapping write has no debounce, so the next read resyncs.
- `error`: last sync failed and needs investigation

Validation interpretation:

- `validation.status: "ok"`: the last full sync did not detect field-rule drift
- `validation.status: "warning"`: the last full sync found rows that violate configured `fieldRules`, for example duplicates after normalization or invalid enum/type values
- `validation.validatedAt`: when that validation snapshot was last recomputed during a full sync
- `validation.issues`: a capped sample for operator triage, not an exhaustive dump
- `externalChange.pending`: a Drive notification arrived and the debounce window has not completed yet, or a write overlapped a sync (`debounceUntil` is `null`, so the next read resyncs)
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
- Workers Logs are enabled in both Wrangler configs. When a watch or reindex misbehaves, filter for these structured events: `drive.reindex.failed`, `drive.watch.renew.failed`, `drive.watch.stop.failed`, `drive.watch.credential-conflict`, and `drive.notification.rejected`
- a Google quota rejection is stored in `lastWatchError` as `Google Drive rate limit exceeded for creating file subscriptions.`
- projects that share one spreadsheet must use the same Google credential ref. Creating a project returns 409 when the spreadsheet is registered, or is being created by another project, under a different ref. A create that fails leaves no project behind, and an upsert that fails leaves the project as it was, so either can be repeated. The failed request's claim on the spreadsheet can last up to 5 minutes, and ends at once when you delete that project slug. If the Durable Object restarts after writing a project but before registering it, repeat the create with `?upsert=true` to register it
- registries saved before that check can still share one spreadsheet under more than one credential ref. Registration and renewal skip that spreadsheet, continue with every other spreadsheet, and set its `lastWatchError` to `Spreadsheet <id> is registered with conflicting Google credential refs "<ref-a>", "<ref-b>". Projects that share a spreadsheet must use the same credential ref.` A channel id starting with `credential-conflict:` is that recorded status, not a Google channel. The same failure is logged as `drive.watch.credential-conflict`
- to repair it, pick one ref named in that `lastWatchError` and set `googleCredentialRef` to it on every project for the spreadsheet. `npm run ops:bootstrap` upserts those projects and accepts a ref already present on the spreadsheet; a different ref returns 409 until the projects already agree. You can also delete the projects that use the other ref. Then run `npm run ops:watch:drive` and confirm `npm run ops:watch:drive:status` shows `lastWatchError` null and a real channel id for that spreadsheet
- reindex failures back off exponentially per watch: 30 seconds minimum, 1 hour cap; failed watch stops are retried from the control-plane alarm
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

- the query uses a scan-heavy operator (`contains` or `startsWith`) on a large cached table

Fix:

1. Prefer indexed equality/range queries.
2. Add an index if the query pattern is legitimate and frequent.
3. If the query is inherently scan-heavy, narrow it or accept that the API will reject it.

### Delete returns 409 (row moved)

Symptoms:

- `DELETE` returns `409` with `Row <rowId> moved while it was being deleted, so a different row may have been deleted. Verify the sheet.`
- a `table.write.unconfirmed` event with `operation: "delete"` for the table

Cause:

- the row shifted in the sheet between Sheetflare finding it and deleting it, for example when rows were inserted or removed above it during the request. Sheetflare checks the rows next to the deleted row after the delete and fails closed, so the delete was already applied when the `409` is returned.

Fix:

1. Open the sheet and verify the row with managed ID `rowId`. Check that the rows next to where it was are the ones you expect, since a different row may have been deleted.
2. Retry the delete.

## Rotating Credentials

### Rotate Google credentials

1. Update the deployed secret or variable backing `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`, or update the named ref in `GOOGLE_CREDENTIALS_JSON`.
2. Confirm project config still references the correct credential ref.
3. Reindex one table on each affected project.
4. Verify cache status returns to `fresh`.

Use [google-service-accounts.md](./google-service-accounts.md) if you need the exact secret layout, named credential JSON shape, or key-rotation sequence.

### Rotate bootstrap admin token

1. Create or confirm a working admin API key first.
2. Replace `ADMIN_BEARER_TOKEN` in the deployed environment. `npm run setup -- --apply-secrets` does this for you: it mints a new token (printed once in the `SAVE THESE CREDENTIALS NOW` block) unless you export `ADMIN_BEARER_TOKEN`.
3. Verify bootstrap auth only if you intentionally keep it enabled.
4. Keep routine operations on the scoped admin API key.

`--apply-secrets` also replaces the Drive webhook secret, which orphans existing Drive watches (the Worker rejects their notifications until they are re-registered). Setup re-registers them itself when it knows the API URL and an admin credential; otherwise it warns, and you run `npm run ops:watch:drive`.

### Rotate API keys

Key names are not unique, and creating a key never revokes another, so bootstrap guards reruns: a configured key whose name already has an active key is skipped, and its secret cannot be shown again. To replace keys deliberately (for example after losing one), rotate:

```powershell
npm run setup -- --bootstrap --rotate-keys   # through setup; new keys are printed once

$env:SHEETFLARE_BOOTSTRAP_ROTATE_KEYS = "true"
$env:SHEETFLARE_SHOW_SECRETS = "true"        # required: the old keys are revoked, so the new ones must not be redacted
npm run ops:bootstrap                        # directly; refuses to rotate without SHEETFLARE_SHOW_SECRETS
```

Rotation first creates every replacement key, then revokes all active keys that share a configured name, using `DELETE /v1/admin/keys/{id}`. Anything still using an old key fails with `401` afterward, so update stored copies. To revoke a single key without replacing it, call that route with an admin credential.

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
- create, get, update, delete on a smoke row; after the update the row is read back (and again after the reindex) and every configured update value must have persisted, so a PATCH that returns `200` without changing the row fails the smoke
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
