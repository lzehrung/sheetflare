# Contributor Staging Guide

This guide is for contributors maintaining the repo-owned staging environment for this project.

It is intentionally separate from the operator-facing docs. Consumer docs should describe how to run a Sheetflare deployment, not the specific staging assets owned by this repository.

## Current Staging Assets

- Cloudflare Worker name: `sheetflare-staging-api`
- Cloudflare Pages project: `sheetflare-staging-admin`
- Wrangler config: `apps/api/wrangler.staging.jsonc`
- Pages config: `apps/admin/wrangler.staging.jsonc`
- deploy target: `*.workers.dev`
- admin target: `https://sheetflare-staging-admin.pages.dev`
- Google project: `sheetflare-staging`
- Google service account: `sheetflare-staging@sheetflare-staging.iam.gserviceaccount.com`

## Stand Up or Repair Staging

Staging uses the same setup flow as every Sheetflare deployment. Do not build Wrangler secret files or deploy the API and admin UI separately.

From the repository root on a machine with browser access:

```powershell
npm install
npx wrangler login
gcloud auth login
npm run setup:staging
```

Setup asks for the staging sheet URL, tab, and one writable column. It then:

1. creates or loads staging Google credentials
2. saves all Worker and Pages secrets
3. deploys `sheetflare-staging-api` and `sheetflare-staging-admin`
4. prints the Google service-account email and waits while you share the sheet with it as **Editor**
5. creates the project, table, and API keys
6. performs a real read/write smoke test and verifies the deployment

Copy generated API keys into the team password manager when shown. They are not persisted locally and cannot be displayed again.

Local staging files are gitignored and separate from production:

- `sheetflare.staging.setup.json` — non-secret project/table choices
- `.sheetflare.staging.setup.local.json` — deployment URLs and local admin-site state

Rerun an individual recovery step only when setup tells you to:

```powershell
npm run setup:staging -- --apply-secrets
npm run setup:staging -- --deploy
npm run setup:staging -- --bootstrap
npm run setup:staging -- --smoke
npm run setup:staging -- --verify
```

## GitHub Workflows

The checked-in staging workflows are not currently provisioned with repository secrets and have never deployed staging. Local `npm run setup:staging` is authoritative until CI is migrated to invoke the same setup orchestrator with a securely supplied staging setup config.

Do not use the raw workflows as a substitute for setup: they do not currently own the complete Google credential, Drive webhook, Pages API-origin, bootstrap, smoke, and verification lifecycle.

If unattended staging deployment is added later, it must map environment-specific secret storage into setup's standard inputs and invoke the same setup pipeline rather than duplicating Wrangler commands.

## What Does Not Belong In Consumer Docs

Keep these details out of `quickstart.md`, `operator-runbook.md`, and similar operator-facing docs:

- our specific GCP project ID
- our staging service-account email
- our Worker name
- our repo-specific GitHub Actions workflow
