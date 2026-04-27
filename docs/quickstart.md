# Quickstart

This is the fastest safe path to get Sheetflare running in staging and prove it works.

Use this document if you are:

- a human operator deploying the system
- an agent automating setup and verification

If you need deeper operational detail, use [deploy.md](./deploy.md), [operator-runbook.md](./operator-runbook.md), and [google-service-accounts.md](./google-service-accounts.md).

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

Create a dedicated Google service account for staging.

Recommended shape:

- one user-managed service account per environment
- Google Sheets API enabled in that GCP project
- spreadsheet-level `Editor` sharing only on the exact spreadsheets Sheetflare will manage

Share both staging spreadsheets with the service-account email as an editor.

Use [google-service-accounts.md](./google-service-accounts.md) for the exact setup, secret-handling model, `GOOGLE_CREDENTIALS_JSON` format, and key-rotation guidance.

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
- `TABLE_MAX_FULL_SCAN_ROWS`

Optional:

- `GOOGLE_CREDENTIALS_JSON`

If you use one shared credential for the whole gateway, set `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`.

If you need multiple named credentials in one deployment, set `GOOGLE_CREDENTIALS_JSON` as a secret and then set each project's `googleCredentialRef` to the matching key.

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
$env:SHEETFLARE_ADMIN_CREDENTIAL = "<ADMIN_BEARER_TOKEN>"
```

Create a scoped admin key:

```powershell
npm run ops:create-admin-key
```

Keep the returned API key. Prefer it for routine admin use. Treat the bootstrap token as break-glass only.

Optional faster path:

- set `SHEETFLARE_BOOTSTRAP_CONFIG_JSON`
- run `npm run ops:bootstrap`

That script can create projects, tables, and initial API keys in one pass.

## 7. Create staging projects and tables

Use the admin UI, the admin API, or `npm run ops:bootstrap` to create:

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

Set `googleCredentialRef`:

- leave it blank or use `default` if the Worker uses one shared Google credential
- set it explicitly if the project should use a named credential from `GOOGLE_CREDENTIALS_JSON`

The admin UI can now:

- create projects
- create tables
- mint scoped API keys
- inspect cache status
- force reindex

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

Optional artifact:

```powershell
$env:SHEETFLARE_SMOKE_REPORT_PATH = "reports/staging/smoke-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run smoke:staging
```

The smoke suite checks:

- readiness endpoint internal checks
- admin access
- private-table anonymous rejection
- private-table keyed reads
- public-read anonymous access
- public-read anonymous write rejection
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

Bootstrap projects, tables, and keys:

```powershell
npm run ops:bootstrap
```

Get cache status:

```powershell
npm run ops:cache
```

Force reindex:

```powershell
npm run ops:reindex
```

Run the load and churn harness:

```powershell
$env:SHEETFLARE_LOAD_REPORT_PATH = "reports/staging/load-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run load:staging
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

## Local End-To-End Check

After you have the local Worker, the admin UI, Google credentials, and the smoke-test projects/tables configured, you can run the local end-to-end path:

Required smoke env vars:

- `SHEETFLARE_ADMIN_CREDENTIAL`
- `SHEETFLARE_PRIVATE_PROJECT`
- `SHEETFLARE_PRIVATE_TABLE`
- `SHEETFLARE_PRIVATE_READ_KEY`
- `SHEETFLARE_MUTATION_KEY`
- `SHEETFLARE_PUBLIC_PROJECT`
- `SHEETFLARE_PUBLIC_TABLE`
- `SHEETFLARE_SMOKE_CREATE_VALUES_JSON`
- `SHEETFLARE_SMOKE_UPDATE_VALUES_JSON`

```powershell
npx playwright install chromium
npm run e2e:local
```

This starts the local API and admin UI, runs the API smoke suite against the local Worker, and then runs browser automation against the admin UI.
