# Deploy Guide

This guide defines the expected deployment and verification flow for Sheetflare.

Use [google-service-accounts.md](./google-service-accounts.md) for the exact recommended Google credential model, secret layout, and rotation workflow.

If you are maintaining this repository's shared staging workflows, use [contributor-staging.md](./contributor-staging.md) for the exact GitHub secret names and project-specific staging asset names.

## Required Environment

Set these on the Worker:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_CREDENTIALS_JSON` optional
- `ADMIN_BEARER_TOKEN`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_WINDOW_SECONDS`
- `TABLE_MAX_FULL_SCAN_ROWS`

Recommendations:

- keep `ADMIN_BEARER_TOKEN` long and random
- use `GOOGLE_CREDENTIALS_JSON` only when you need named per-project refs
- use one dedicated Google service account per environment unless you have a real reason to isolate further
- start with conservative rate limits and raise only after observing real traffic
- keep `TABLE_MAX_FULL_SCAN_ROWS` at the safe default until you have benchmark evidence for a higher value

## GitHub Actions Deployment

If you deploy through GitHub Actions with Wrangler, the workflow needs:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

For this repo's current deploy flows, the smallest useful Cloudflare account token is:

- `Workers Scripts Write` for `wrangler deploy` and `wrangler secret put`
- `Pages Write` for `wrangler pages deploy` and `wrangler pages secret put`

Keep that token scoped to the single target Cloudflare account.

`CLOUDFLARE_ACCOUNT_ID` is an account identifier rather than secret material, but many teams still store it as a GitHub secret for workflow simplicity. A repository variable also works if you update the workflow to read from `vars` instead of `secrets`.

In this repository's staging workflows, the additional repo-specific secrets are:

- Worker staging deploy: `SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY`, `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN`
- Admin staging deploy: `SHEETFLARE_STAGING_ADMIN_UI_USERNAME`, `SHEETFLARE_STAGING_ADMIN_UI_PASSWORD`

## Pre-Deploy Checklist

Run from repo root:

```powershell
npm run lint
npm test
npm run typecheck
npm run build
```

Do not deploy if any of these fail.

## Deploy

Preferred local deploy commands from repo root:

```powershell
npm run deploy:api
npm run deploy:admin
```

Or deploy both in sequence:

```powershell
npm run deploy
```

Equivalent explicit command for the API Worker if you need to run it manually:

```powershell
npm --workspace @sheetflare/api run build
npx wrangler deploy --config apps/api/wrangler.jsonc
```

If you manage secrets through Wrangler, set them before deploy:

```powershell
npx wrangler secret put ADMIN_BEARER_TOKEN --config apps/api/wrangler.jsonc
npx wrangler secret put GOOGLE_PRIVATE_KEY --config apps/api/wrangler.jsonc
```

Set non-secret vars in `apps/api/wrangler.jsonc` or via your deployment system.

Google credential notes:

- `GOOGLE_PRIVATE_KEY` is secret material and should be stored as a Worker secret
- `GOOGLE_CREDENTIALS_JSON` is also secret material because it contains private keys
- `GOOGLE_CLIENT_EMAIL` can be stored as a normal variable
- if you use named credentials, project config must point at the intended `googleCredentialRef`

## Post-Deploy Verification

1. Set the base URL and admin bearer token:

```powershell
$env:SHEETFLARE_BASE_URL = "https://your-worker.example.workers.dev"
$env:SHEETFLARE_ADMIN_CREDENTIAL = "<ADMIN_BEARER_TOKEN>"
```

2. Run the smoke suite:

```powershell
npm run smoke
```

Optional: persist a smoke report artifact:

```powershell
$env:SHEETFLARE_SMOKE_REPORT_PATH = "reports/smoke-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run smoke
```

3. Run the load harness and persist its report:

```powershell
$env:SHEETFLARE_LOAD_REPORT_PATH = "reports/load-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run load
```

4. For each critical table, verify cache status:

```powershell
$env:SHEETFLARE_PROJECT = "demo"
$env:SHEETFLARE_TABLE = "users"
npm run ops:cache
```

5. For critical tables, run the synthetic cache health check:

```powershell
$env:SHEETFLARE_CACHE_HEALTH_TABLES_JSON = '[{"project":"demo","table":"users"}]'
npm run ops:cache:health
```

## Required Staging Smoke Variables

The smoke suite expects:

- `SHEETFLARE_BASE_URL`
- `SHEETFLARE_ADMIN_CREDENTIAL`
- `SHEETFLARE_PRIVATE_PROJECT`
- `SHEETFLARE_PRIVATE_TABLE`
- `SHEETFLARE_PRIVATE_READ_KEY`
- `SHEETFLARE_MUTATION_KEY`
- `SHEETFLARE_PUBLIC_PROJECT`
- `SHEETFLARE_PUBLIC_TABLE`
- `SHEETFLARE_SMOKE_CREATE_VALUES_JSON`
- `SHEETFLARE_SMOKE_UPDATE_VALUES_JSON`

Optional:

- `SHEETFLARE_SMOKE_ID_COLUMN`

Example:

```powershell
$env:SHEETFLARE_PRIVATE_PROJECT = "demo-private"
$env:SHEETFLARE_PRIVATE_TABLE = "users"
$env:SHEETFLARE_PRIVATE_READ_KEY = "sfk_read-key.secret"
$env:SHEETFLARE_MUTATION_KEY = "sfk_mutation-key.secret"
$env:SHEETFLARE_PUBLIC_PROJECT = "demo-public"
$env:SHEETFLARE_PUBLIC_TABLE = "users"
$env:SHEETFLARE_SMOKE_CREATE_VALUES_JSON = '{"name":"Smoke Row","status":"active"}'
$env:SHEETFLARE_SMOKE_UPDATE_VALUES_JSON = '{"name":"Smoke Row Updated"}'
```

The smoke row will be created with a generated ID and deleted automatically.

The smoke suite proves route-level behavior on top of `/ready`. It checks private-table auth rejection, public-read anonymous access, public-read anonymous write rejection, smoke-row CRUD, cache status visibility, and admin reindex.

## Rollback

At minimum, rollback means restoring the previous Worker deployment and then verifying the critical tables again.

Procedure:

1. Redeploy the last known good version.
2. Run `npm run smoke`.
3. Re-check cache status on critical tables.
4. If a rollout changed table config or sheet structure assumptions, run `npm run ops:reindex` on affected tables.

## Durable Object Notes

- `ControlPlaneDO`, `ProjectDO`, `TableDO`, and `RateLimitDO` use SQLite-backed storage.
- Any migration that changes DO schema or behavior must be followed by a fresh deploy and smoke pass.
- Do not merge schema-affecting changes without confirming reindex still succeeds on representative tables.

## Release Gate

A release is acceptable only when:

- repo checks are green
- deploy succeeds
- smoke suite passes
- load harness report is captured
- cache status on critical tables is healthy
- no repeated sync failures appear in logs after deploy
