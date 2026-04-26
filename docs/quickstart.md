# Quickstart

This is the fastest safe path to get Sheetflare running in staging and prove it works.

Use this document if you are:

- a human operator deploying the system
- an agent automating setup and verification

If you need deeper operational detail, use [deploy.md](./deploy.md) and [operator-runbook.md](./operator-runbook.md).

## 1. Prepare a staging sheet

Create two Google Sheets projects:

- one private project
- one public-read project

In each sheet, create a tab such as `Users` with a header row like:

```text
_id | name | status
```

Rules:

- `_id` must be present
- every `_id` value must be unique
- no `_id` cell may be blank
- header names must be unique

## 2. Prepare Google access

Create or choose a Google service account.

Share both staging spreadsheets with the service-account email as an editor.

You will need:

- service-account client email
- service-account private key

## 3. Configure the Worker

Set these for staging:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `ADMIN_BEARER_TOKEN`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_WINDOW_SECONDS`

Optional:

- `GOOGLE_CREDENTIALS_JSON`

Set secrets:

```powershell
npx wrangler secret put GOOGLE_PRIVATE_KEY --config apps/api/wrangler.jsonc
npx wrangler secret put ADMIN_BEARER_TOKEN --config apps/api/wrangler.jsonc
```

Set non-secret variables in `apps/api/wrangler.jsonc` or your deploy system.

## 4. Verify the repo before deploy

From repo root:

```powershell
npm install
npm run lint
npm test
npm run typecheck
npm run build
```

## 5. Deploy staging

```powershell
npx wrangler deploy --config apps/api/wrangler.jsonc
```

Save the deployed base URL, for example:

```powershell
$env:SHEETFLARE_BASE_URL = "https://your-staging-worker.workers.dev"
```

## 6. Bootstrap admin access

Set the bootstrap token locally:

```powershell
$env:SHEETFLARE_ADMIN_BEARER = "<ADMIN_BEARER_TOKEN>"
```

Create a scoped admin key:

```powershell
npm run ops:create-admin-key
```

Keep the returned API key. Prefer it for routine admin use. Treat the bootstrap token as break-glass only.

## 7. Create staging projects and tables

Use the admin UI or admin API to create:

- one private project
- one public-read project

For each project, add a table config such as:

- `tableSlug`: `users`
- `sheetTabName`: `Users`
- `idColumn`: `_id`
- `indexedFields`: `["name","status"]`
- `cacheTtlSeconds`: `15` or `60` for staging

Set `defaultAuthMode`:

- private project: `"private"`
- public project: `"public-read"`

## 8. Create the keys needed for smoke testing

You need:

- a private read key with `table:read`
- a mutation key with `table:create`, `table:update`, and `table:delete`

They may be the same key if that is simpler for staging.

## 9. Run the staging smoke suite

Set the smoke-test environment:

```powershell
$env:SHEETFLARE_PRIVATE_PROJECT = "demo-private"
$env:SHEETFLARE_PRIVATE_TABLE = "users"
$env:SHEETFLARE_PRIVATE_READ_KEY = "sfk_private-read.secret"
$env:SHEETFLARE_MUTATION_KEY = "sfk_mutation.secret"
$env:SHEETFLARE_PUBLIC_PROJECT = "demo-public"
$env:SHEETFLARE_PUBLIC_TABLE = "users"
$env:SHEETFLARE_SMOKE_CREATE_VALUES_JSON = '{"name":"Smoke Row","status":"active"}'
$env:SHEETFLARE_SMOKE_UPDATE_VALUES_JSON = '{"name":"Smoke Row Updated"}'
```

Run:

```powershell
npm run smoke:staging
```

The smoke suite checks:

- health endpoint
- admin access
- private-table anonymous rejection
- private-table keyed reads
- public-read anonymous access
- cache status with `staleReason`
- create/get/update/delete on a smoke row
- admin reindex

## 10. Inspect cache health

```powershell
$env:SHEETFLARE_PROJECT = "demo-private"
$env:SHEETFLARE_TABLE = "users"
npm run ops:cache
```

Healthy output should show:

- `status: "ready"`
- `staleReason: "fresh"` after healthy activity or reindex
- `lastSyncError: null`

## 11. Useful operator commands

Create admin key:

```powershell
npm run ops:create-admin-key
```

Get cache status:

```powershell
npm run ops:cache
```

Force reindex:

```powershell
npm run ops:reindex
```

## 12. If setup fails

Check these first:

- spreadsheet is shared with the service account
- `_id` column exists
- `_id` cells are unique and non-blank
- headers are unique
- project points at the correct spreadsheet
- table points at the correct tab
- auth keys have the expected scopes

For deeper troubleshooting, use [operator-runbook.md](./operator-runbook.md).
