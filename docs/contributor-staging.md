# Contributor Staging Guide

This guide is for contributors maintaining the repo-owned staging environment for this project.

It is intentionally separate from the operator-facing docs. Consumer docs should describe how to run a Sheetflare deployment, not the specific staging assets owned by this repository.

## Current Staging Assets

- Cloudflare Worker name: `sheetflare-staging-api`
- Cloudflare Pages project: `sheetflare-staging-admin`
- Wrangler config: `apps/api/wrangler.jsonc`
- Pages config: `apps/admin/wrangler.jsonc`
- deploy target: `*.workers.dev`
- admin target: `https://sheetflare-staging-admin.pages.dev`
- Google project: `sheetflare-staging`
- Google service account: `sheetflare-staging@sheetflare-staging.iam.gserviceaccount.com`

## Local Staging Deploy

Prerequisites:

- `wrangler` logged in
- access to the `sheetflare-staging` Google project
- the staging Google private key available locally
- a staging `ADMIN_BEARER_TOKEN`

The checked-in Worker config already carries the non-secret staging values:

- `GOOGLE_CLIENT_EMAIL`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_WINDOW_SECONDS`
- `TABLE_MAX_FULL_SCAN_ROWS`

Deploy by providing the secrets at deploy time:

```powershell
$keyJson = Get-Content "$env:TEMP\sheetflare-staging-key.json" -Raw | ConvertFrom-Json
$adminBearerToken = "<STAGING_ADMIN_BEARER_TOKEN>"
$secretsPath = Join-Path $env:TEMP "sheetflare-staging-secrets.json"

@{
  GOOGLE_PRIVATE_KEY = $keyJson.private_key
  ADMIN_BEARER_TOKEN = $adminBearerToken
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $secretsPath

npx wrangler deploy --config apps/api/wrangler.jsonc --secrets-file $secretsPath
```

Remove the temporary secrets file after deploy.

## Local Staging Admin Deploy

The admin UI is deployed separately from the API Worker. The staging Pages project is:

- project: `sheetflare-staging-admin`
- config: `apps/admin/wrangler.jsonc`
- upstream API origin: `https://sheetflare-staging-api.lzehrung.workers.dev`

The deployed site uses two distinct auth layers:

- site access: HTTP Basic Auth enforced at the Pages edge
- control-plane access: bootstrap bearer token or scoped admin API key entered into the UI

That split matters. The site gate prevents anonymous browsing, and the in-app credential continues to protect actual admin mutations.

Required Pages secrets:

- `ADMIN_UI_USERNAME`
- `ADMIN_UI_PASSWORD`

Deploy locally:

```powershell
npx wrangler pages project create sheetflare-staging-admin --production-branch main
"<ADMIN_UI_USERNAME>" | npx wrangler pages secret put ADMIN_UI_USERNAME --project-name sheetflare-staging-admin
"<ADMIN_UI_PASSWORD>" | npx wrangler pages secret put ADMIN_UI_PASSWORD --project-name sheetflare-staging-admin
npm --workspace @sheetflare/admin run build
npx wrangler pages deploy apps/admin/dist --project-name sheetflare-staging-admin --branch main
```

The root `functions/_middleware.ts` file protects the entire Pages site, including static assets and proxied `/v1` requests. The admin UI sends its control-plane credential over `x-sheetflare-admin-credential`, and the Pages proxy translates that to the upstream `Authorization: Bearer ...` header. This avoids collisions between browser-managed Basic Auth and the API credential.

## GitHub Workflow

The repo includes an on-demand staging deploy workflow:

- workflow: `.github/workflows/deploy-staging.yml`
- trigger: `workflow_dispatch`
- optional full gate before deploy: lint, test, typecheck, build

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY`
- `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN`

The worker workflow writes a temporary `.wrangler-staging-secrets.json`, deploys the Worker, and deletes the file at the end of the run.

The repo includes a separate on-demand admin deploy workflow:

- workflow: `.github/workflows/deploy-admin-staging.yml`
- trigger: `workflow_dispatch`
- optional full gate before deploy: lint, test, typecheck, build

Required GitHub repository secrets for the admin workflow:

- `SHEETFLARE_STAGING_ADMIN_UI_USERNAME`
- `SHEETFLARE_STAGING_ADMIN_UI_PASSWORD`

## What Does Not Belong In Consumer Docs

Keep these details out of `quickstart.md`, `operator-runbook.md`, and similar operator-facing docs:

- our specific GCP project ID
- our staging service-account email
- our Worker name
- our repo-specific GitHub Actions workflow
