# Deploy Guide

This guide defines the expected deployment and verification flow for Sheetflare.

## Required Environment

Set these on the Worker:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_CREDENTIALS_JSON` optional
- `ADMIN_BEARER_TOKEN`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_WINDOW_SECONDS`

Recommendations:

- keep `ADMIN_BEARER_TOKEN` long and random
- use `GOOGLE_CREDENTIALS_JSON` only when you need named per-project refs
- start with conservative rate limits and raise only after observing real traffic

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

From the API workspace:

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

## Post-Deploy Verification

1. Set the base URL and admin bearer token:

```powershell
$env:SHEETFLARE_BASE_URL = "https://your-worker.example.workers.dev"
$env:SHEETFLARE_ADMIN_BEARER = "<ADMIN_BEARER_TOKEN>"
```

2. Run the staging smoke suite:

```powershell
npm run smoke:staging
```

3. For each critical table, verify cache status:

```powershell
$env:SHEETFLARE_PROJECT = "demo"
$env:SHEETFLARE_TABLE = "users"
npm run ops:cache
```

## Required Staging Smoke Variables

The smoke suite expects:

- `SHEETFLARE_BASE_URL`
- `SHEETFLARE_ADMIN_BEARER`
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

## Rollback

At minimum, rollback means restoring the previous Worker deployment and then verifying the critical tables again.

Procedure:

1. Redeploy the last known good version.
2. Run `npm run smoke:staging`.
3. Re-check cache status on critical tables.
4. If a rollout changed table config or sheet structure assumptions, run `npm run ops:reindex` on affected tables.

## Durable Object Notes

- `ControlPlaneDO`, `ProjectDO`, `TableDO`, and `RateLimitDO` use SQLite-backed storage.
- Any migration that changes DO schema or behavior must be followed by a staging deploy and smoke pass.
- Do not merge schema-affecting changes without confirming reindex still succeeds on staging tables.

## Release Gate

A release is acceptable only when:

- repo checks are green
- deploy succeeds
- smoke suite passes
- cache status on critical tables is healthy
- no repeated sync failures appear in logs after deploy
