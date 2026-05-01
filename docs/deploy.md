# Deploy Guide

This guide defines the expected deployment and verification flow for Sheetflare.

Use [google-service-accounts.md](./google-service-accounts.md) for the exact recommended Google credential model, secret layout, and rotation workflow.

If you are maintaining this repository's shared staging workflows, use [contributor-staging.md](./contributor-staging.md) for the exact GitHub secret names and project-specific staging asset names.

## Preferred Path

For a normal first deployment, start with:

```powershell
npm install
npm run setup
```

The setup command can:

- write `sheetflare.setup.json`
- keep local reusable secret state in `.sheetflare.setup.local.json`
- apply Worker secrets
- provision a Google Cloud project and service account when `--provision-google` is used with a working `gcloud` login
- ensure the target Cloudflare Pages project exists for admin deploys
- apply the admin Pages runtime binding to the deployed API base URL
- deploy the API Worker
- deploy the admin UI
- verify the protected admin site root and proxied `/docs`
- bootstrap the first project and keys
- run smoke validation

For reruns from an existing setup config:

```powershell
npm run setup -- --apply-secrets
npm run setup -- --deploy
npm run setup -- --bootstrap
npm run setup -- --smoke
npm run setup -- --verify
```

Rerun notes:

- `npm run setup -- --deploy` requires admin-site auth secrets for the admin Pages deploy. Setup reuses `.sheetflare.setup.local.json` when available, or falls back to `ADMIN_UI_USERNAME` and `ADMIN_UI_PASSWORD`. It also ensures the Pages project exists and applies `SHEETFLARE_API_BASE_URL` at the Pages project level before the deploy.
- `npm run setup -- --smoke` accepts either a scoped admin API key or the bootstrap admin credential through local setup state or `SHEETFLARE_ADMIN_CREDENTIAL`.
- `npm run setup -- --apply-secrets --provision-google` can create the Google project, enable Sheets and Drive APIs, create the service account, and mint a key JSON before applying Worker secrets. Use `--google-project` and `--google-service-account` when the default names derived from the setup profile are not what you want.
- `npm run setup -- --verify` is the post-deploy confidence pass. It checks Worker readiness, protected admin proxy health, and Drive watch coverage using the same operator-facing surfaces documented elsewhere. It exits non-zero on warnings as well as blocking failures, so a clean pass means the full verification surface succeeded.

`.sheetflare.setup.local.json` is secret material. It is gitignored and intended to stay local to the operator machine.

Use the rest of this document when:

- you want the manual fallback path
- you are wiring CI
- you need exact Cloudflare token scopes
- you are debugging a failed deploy outside the setup flow

## Google Provisioning Through Setup

When you want setup to create the Google credential instead of pointing at an existing JSON file, start with:

```powershell
gcloud auth login
npx wrangler login
npm run setup -- --apply-secrets --provision-google
```

Profile-derived defaults:

- `production` or `prod` -> `sheetflare-prod`
- `staging` -> `sheetflare-staging`
- any other profile -> `sheetflare-<profile>`

Explicit override example:

```powershell
npm run setup -- --apply-secrets --provision-google --google-project my-prod-project --google-service-account sheetflare-prod
```

Setup keeps the generated private key ephemeral, writes only the service-account email into local setup state, and still expects you to share the spreadsheet with that email afterward.

## Required Environment

Set these on the Worker:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_DRIVE_WEBHOOK_SECRET`
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

Preferred local deploy command from repo root:

```powershell
npm run deploy
```

That path is authoritative because it provisions the Pages project when missing, applies the project-level runtime binding for `SHEETFLARE_API_BASE_URL`, and verifies the live admin site afterward.

Run deploys from a clean checked-out commit. Do not rely on dirty-worktree Pages deploys for release or rollback workflows.

For first-time or routine admin deploys, prefer:

```powershell
npm run setup -- --deploy
```

Treat the raw deploy commands below as lower-level fallbacks for an already-provisioned environment.

Lower-level raw deploy entrypoints from repo root:

```powershell
npm run deploy:api:raw
npm run deploy:admin:raw
```

Equivalent explicit command for the API Worker if you need to run it manually outside setup:

```powershell
npm --workspace @sheetflare/api run build
npx wrangler deploy --config apps/api/wrangler.jsonc
```

If you need to manage secrets through Wrangler manually instead of `npm run setup -- --apply-secrets`, set them before deploy:

```powershell
npx wrangler secret put ADMIN_BEARER_TOKEN --config apps/api/wrangler.jsonc
npx wrangler secret put GOOGLE_DRIVE_WEBHOOK_SECRET --config apps/api/wrangler.jsonc
npx wrangler secret put GOOGLE_PRIVATE_KEY --config apps/api/wrangler.jsonc
```

Manual admin Pages fallback:

```powershell
npx wrangler pages project create sheetflare-admin --production-branch main
"<ADMIN_UI_USERNAME>" | npx wrangler pages secret put ADMIN_UI_USERNAME --project-name sheetflare-admin
"<ADMIN_UI_PASSWORD>" | npx wrangler pages secret put ADMIN_UI_PASSWORD --project-name sheetflare-admin
"https://your-worker.example.workers.dev" | npx wrangler pages secret put SHEETFLARE_API_BASE_URL --project-name sheetflare-admin
npm --workspace @sheetflare/admin run build
npx wrangler pages deploy apps/admin/dist --project-name sheetflare-admin --branch main
```

`apps/admin/wrangler.jsonc` no longer carries a checked runtime API target. The deployed Pages project must supply `SHEETFLARE_API_BASE_URL` itself.

Prefer your deployment system or setup flow for non-secret vars. Editing the checked repo defaults is only the manual fallback path.

Google credential notes:

- `GOOGLE_PRIVATE_KEY` is secret material and should be stored as a Worker secret
- `GOOGLE_DRIVE_WEBHOOK_SECRET` is secret material and must be stored as a Worker secret
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

Also verify the admin Pages project through its protected site URL:

```powershell
$pair = "<ADMIN_UI_USERNAME>:<ADMIN_UI_PASSWORD>"
$encoded = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
Invoke-WebRequest -Uri "https://sheetflare-admin.pages.dev/" -Headers @{ Authorization = "Basic $encoded" } | Select-Object StatusCode
Invoke-WebRequest -Uri "https://sheetflare-admin.pages.dev/docs" -Headers @{ Authorization = "Basic $encoded" } | Select-Object StatusCode
```

Both should return `200`. If `/docs` fails while the raw Worker `/docs` succeeds, the Pages project runtime binding for `SHEETFLARE_API_BASE_URL` is the first thing to inspect.

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

## Required Smoke Variables

The smoke suite expects:

- `SHEETFLARE_BASE_URL`
- `SHEETFLARE_ADMIN_CREDENTIAL`
- `SHEETFLARE_PRIVATE_PROJECT`
- `SHEETFLARE_PRIVATE_TABLE`
- `SHEETFLARE_PRIVATE_READ_KEY`
- `SHEETFLARE_MUTATION_KEY`
- `SHEETFLARE_SMOKE_CREATE_VALUES_JSON`
- `SHEETFLARE_SMOKE_UPDATE_VALUES_JSON`

Optional:

- `SHEETFLARE_SMOKE_ID_COLUMN`
- `SHEETFLARE_PUBLIC_PROJECT`
- `SHEETFLARE_PUBLIC_TABLE`

Example:

```powershell
$env:SHEETFLARE_PRIVATE_PROJECT = "demo-private"
$env:SHEETFLARE_PRIVATE_TABLE = "users"
$env:SHEETFLARE_PRIVATE_READ_KEY = "sfk_read-key.secret"
$env:SHEETFLARE_MUTATION_KEY = "sfk_mutation-key.secret"
$env:SHEETFLARE_SMOKE_CREATE_VALUES_JSON = '{"name":"Smoke Row","status":"active"}'
$env:SHEETFLARE_SMOKE_UPDATE_VALUES_JSON = '{"name":"Smoke Row Updated"}'
```

The smoke row will be created with a generated ID and deleted automatically.

If you also want anonymous `public-read` coverage, add:

```powershell
$env:SHEETFLARE_PUBLIC_PROJECT = "demo-public"
$env:SHEETFLARE_PUBLIC_TABLE = "users"
```

The smoke suite proves route-level behavior on top of `/ready`. It always checks private-table auth rejection, keyed reads, smoke-row CRUD, cache status visibility, and admin reindex. When `SHEETFLARE_PUBLIC_PROJECT` and `SHEETFLARE_PUBLIC_TABLE` are set, it also checks anonymous `public-read` access and anonymous write rejection.

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
