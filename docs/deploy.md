# Deploy Guide

This guide covers the full deployment reference: CI token scopes, manual fallback commands, post-deploy verification, and rollback. It assumes you have already completed a first deployment.

If this is your first deployment, start with [quickstart.md](./quickstart.md) instead - it walks through the full first-run flow.

Use [google-service-accounts.md](./google-service-accounts.md) for the exact recommended Google credential model, secret layout, and rotation workflow.

If you are maintaining this repository's shared staging environment, use [contributor-staging.md](../contributor-staging.md) for its asset names and setup command.

## Setup Flow

For any deployment, start with:

```powershell
npm install
npx wrangler login
gcloud auth login
npm run setup
```

`npx wrangler login` is suitable for interactive use. For CI or unattended deployments, use `CLOUDFLARE_API_TOKEN`. `gcloud` is needed only when setup provisions Google credentials.

Setup can write `sheetflare.setup.json`, keep non-credential deployment state in `.sheetflare.setup.local.json`, provision Google credentials, apply Worker secrets, deploy the API Worker, bootstrap projects and keys, run smoke validation, and verify Google credentials, Worker readiness, and Drive watch coverage.

The normal operator journey is one command: `npm run setup`. It collects credentials, applies Worker secrets, deploys the API Worker, pauses while you share the sheet with its service account, bootstraps the table and API keys, smoke-tests real reads and writes, and verifies the finished deployment.

Repository staging uses the exact same orchestrator with isolated config and local state:

```powershell
npm run setup:staging
```

Use `npm run setup -- --advanced` only when the safe defaults do not fit. Use the rest of this guide for CI, recovery, and manual fallback—not for a normal first deployment.

For reruns from an existing setup config:

```powershell
npm run setup -- --apply-secrets
npm run setup -- --deploy
npm run setup -- --bootstrap
npm run setup -- --smoke
npm run setup -- --verify
```

- `--apply-secrets` applies Worker secrets only. It mints a new bootstrap admin token and Drive webhook secret unless you export `ADMIN_BEARER_TOKEN` or `GOOGLE_DRIVE_WEBHOOK_SECRET`. A minted token is printed once. Because a new webhook secret orphans existing Drive watches, the run then re-registers them when it knows the API URL (`.sheetflare.setup.local.json` or `SHEETFLARE_BASE_URL`) and an admin credential (`SHEETFLARE_ADMIN_CREDENTIAL`, or the token it just applied). If it cannot, it warns and tells you to run `npm run ops:watch:drive`.
- `--deploy` deploys the API Worker, including the hosted admin UI unless `adminUi` is `disabled`.
- `--bootstrap` upserts projects and tables, then creates the configured API keys. A key whose name already has an active key is skipped with a warning, so reruns never stack duplicate privileged keys. `--bootstrap --rotate-keys` deliberately replaces them: it creates all replacements first, then revokes every prior active key with those names through `DELETE /v1/admin/keys/{id}`. `--rotate-keys` requires `--bootstrap`. Running `npm run ops:bootstrap` directly rotates with `SHEETFLARE_BOOTSTRAP_ROTATE_KEYS=true`, and refuses unless `SHEETFLARE_SHOW_SECRETS=true`, because the new keys would otherwise be redacted after the old ones are revoked.
- `--smoke` accepts a scoped admin API key or bootstrap credential through `SHEETFLARE_ADMIN_CREDENTIAL` or an interactive prompt; setup does not persist either credential. When bootstrap skipped existing keys, supply their values through `SHEETFLARE_PRIVATE_READ_KEY` and `SHEETFLARE_MUTATION_KEY` too (or rotate).
- `--verify` and `npm run doctor` check the resolved Google credential, Worker `/ready`, the hosted admin UI state, and Drive watches. Verify-only runs do not require Wrangler authentication. Anonymous `/ready` returns only `{ ok, service }`; `checks` and `notes` need an admin credential (the bootstrap token or a global key with `admin:projects`, supplied as `SHEETFLARE_ADMIN_CREDENTIAL`). Without one the doctor warns that readiness details are unavailable, and a key without global scope gets a 403 with the same guidance.
- `.sheetflare.setup.local.json` stores the deployed `apiUrl` and resolved Google service-account email, not admin credentials.

### Credential Handoff

Setup prints every credential it minted once, in a block headed `SAVE THESE CREDENTIALS NOW`: the bootstrap admin token (only when setup generated it) and each API key bootstrap created. The block appears at the end of the run, including a failed run, so credentials minted before a failure are not lost. Setup never writes them to `sheetflare.setup.json` or `.sheetflare.setup.local.json` and cannot show them again. Credentials you supplied through the environment are not echoed. Output from a non-interactive run (CI logs, redirected files) contains this block, so treat it as secret. There is no flag to hide or reveal it.

Use the rest of this document for CI, token scopes, Worker deployment, and post-deploy verification.

## Google Provisioning Through Setup

When you want setup to create the Google credential instead of pointing at an existing JSON file, start with:

```powershell
gcloud auth login
npx wrangler login
npm run setup
```

On first-run beginner setup, choose Google provisioning when prompted. For noninteractive reruns or existing configs, use:

```powershell
npm run setup -- --apply-secrets --provision-google
```

Profile-derived defaults:

- `production` -> `sheetflare-prod`
- `staging` -> `sheetflare-staging`

Explicit override example:

```powershell
npm run setup -- --apply-secrets --provision-google --google-project my-prod-project --google-service-account sheetflare-prod
```

Setup keeps the generated private key ephemeral, writes only the service-account email into local setup state, and still expects you to share the spreadsheet with that email afterward. Interactive provisioning asks for the Google Cloud project ID and defaults to your active `gcloud` project when one is configured.

Setup cannot share the spreadsheet automatically. Share each managed spreadsheet with the printed service-account email as `Editor` before bootstrap and smoke validation can succeed.

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

Wrangler-based CI needs:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Scope the token to the target Cloudflare account and grant `Workers Scripts Write` for `wrangler deploy` and `wrangler secret put`. `CLOUDFLARE_ACCOUNT_ID` is an identifier rather than secret material, but it may remain a repository secret for workflow simplicity.

This repository's staging Worker deployment also uses `SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY` and `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN`. The `Deploy Staging` workflow checks all four secrets right after installing dependencies, before it validates or deploys anything, and names each missing one in its failure; see [contributor-staging.md](../contributor-staging.md) for where the values come from.

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

The authoritative setup-driven command is:

```powershell
npm run deploy
```

Equivalent targeted rerun:

```powershell
npm run setup -- --deploy
```

Both deploy the API Worker only. The lower-level production and staging fallbacks are:

```powershell
npm run deploy:api:raw
npm run deploy:staging:api:raw
```

To invoke Wrangler directly outside setup:

```powershell
npm --workspace @sheetflare/api run build
npx wrangler deploy --config apps/api/wrangler.jsonc
```

If you manage Worker secrets manually, set them before deployment:

```powershell
npx wrangler secret put ADMIN_BEARER_TOKEN --config apps/api/wrangler.jsonc
npx wrangler secret put GOOGLE_DRIVE_WEBHOOK_SECRET --config apps/api/wrangler.jsonc
npx wrangler secret put GOOGLE_PRIVATE_KEY --config apps/api/wrangler.jsonc
```

Set `GOOGLE_CLIENT_EMAIL` as a normal Worker variable. `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_WEBHOOK_SECRET`, and `GOOGLE_CREDENTIALS_JSON` are secret material. Named Google credentials require the matching `googleCredentialRef` in project config.

## Post-Deploy Verification

1. Set the deployed Worker URL and a scoped admin credential:

```powershell
$env:SHEETFLARE_BASE_URL = "https://your-worker.example.workers.dev"
$env:SHEETFLARE_ADMIN_CREDENTIAL = "sfk_admin-key.secret"
```

2. Verify Worker-only setup health and API behavior:

```powershell
npm run doctor
npm run smoke
```

3. Open `https://<your-worker>/admin/`, sign in with the scoped admin key, and confirm projects load.

4. Optionally persist smoke and load reports:

```powershell
$env:SHEETFLARE_SMOKE_REPORT_PATH = "reports/smoke-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run smoke
$env:SHEETFLARE_LOAD_REPORT_PATH = "reports/load-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run load
```

5. Check each critical table:

```powershell
$env:SHEETFLARE_PROJECT = "demo"
$env:SHEETFLARE_TABLE = "users"
npm run ops:cache
$env:SHEETFLARE_CACHE_HEALTH_TABLES_JSON = '[{"project":"demo","table":"users"}]'
npm run ops:cache:health
```

## Admin UI

The API Worker serves the admin UI at `https://<your-worker>/admin/` from its own static assets. There is no separate deployment: every Worker deploy ships the matching admin build.

- **Sign-in**: paste a scoped admin API key. It stays in browser memory for the session; password managers can save it for the Worker's origin. Use the bootstrap token only as break-glass.
- **Authorization**: the admin pages are static files. Every action calls the same authenticated `/v1/admin/*` routes as the CLI, with the same scopes and rate limits.
- **Headers**: admin responses carry a strict CSP (`connect-src 'self'`), frame denial, `nosniff`, `no-referrer`, `noindex`, and `Cache-Control: no-store`.
- **Switch**: `"adminUi": "enabled" | "disabled"` in `sheetflare.setup.json` (default `enabled`). `disabled` deploys no admin assets, and `/admin/` returns `404`. Setup configs that set the legacy `deploy.admin` to `false` default to `disabled`.
- **Status**: `/ready` reports `checks.adminUi` as `enabled`, `disabled`, `invalid`, or `assets-missing` to admin-credentialed callers only; anonymous `/ready` returns `{ ok, service }`. `npm run doctor` compares it with setup config. `invalid` and `assets-missing` make `/admin/` return `503`; rerun `npm run setup -- --deploy` to fix them.

Optional hardening: serve the Worker on a custom domain and add a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) for the `/admin` path, so only your identity provider's users can load the pages. Do not protect `/v1/*`, because API clients need it. Access for [`workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) protects the whole Worker URL, API included, so set `workers_dev` to `false` once the custom domain serves traffic.

## Local Admin UI

The loopback admin UI is optional. Use it for UI development, to manage a deployment with the hosted admin disabled, or to keep the admin credential out of the browser.

`npm run dev:admin` binds exactly to `127.0.0.1:4173` with strict port selection. The proxy target resolves in this order:

1. non-blank `SHEETFLARE_API_BASE_URL`
2. `apiUrl` in repo-root `.sheetflare.setup.local.json`
3. `http://127.0.0.1:8787`

Remote targets must use HTTPS because the proxy forwards the admin credential as bearer authorization. HTTP is accepted only for loopback Worker development. The browser and Vite proxy are same-origin, so normal admin use needs no Worker CORS configuration.

Explicit local Worker override:

```powershell
$env:SHEETFLARE_API_BASE_URL = "http://127.0.0.1:8787"
npm run dev:admin
```

Explicit staging override:

```powershell
$env:SHEETFLARE_API_BASE_URL = "https://your-staging-worker.example.workers.dev"
npm run dev:admin
```

Never pass `--host 0.0.0.0`, use a LAN hostname, or expose port `4173` through a public tunnel.

### Admin Credential

The UI uses the first available credential source:

1. A credential entered in the UI for the current session. It stays in browser memory only and overrides the server credential until **Clear**.
2. `SHEETFLARE_ADMIN_CREDENTIAL` (or legacy `SHEETFLARE_ADMIN_BEARER`) in the environment that starts `npm run dev:admin`. The Vite server reads it once at startup and attaches it upstream; the browser never receives it.
3. Neither: the UI asks for a credential.

```powershell
$env:SHEETFLARE_ADMIN_CREDENTIAL = "sfk_admin-key.secret"
npm run dev:admin
```

Use a scoped admin API key for routine work; use the bootstrap token only as break-glass. The startup log states whether a server-side credential is in use, never its value. Restart the server after changing the variable.

The proxy attaches a credential only to requests that carry the admin UI's `x-sheetflare-admin-request` marker and come from `http://127.0.0.1:4173`. Requests from other browser origins, including other localhost ports, reach the Worker unauthenticated. Local processes that can reach port `4173` act with the server credential, the same trust boundary as the environment variable itself.

Sheetflare never writes credentials to browser storage, setup state, or the URL. The credential field supports password managers. Any local process can bind `127.0.0.1:4173` while Sheetflare is stopped, so fill a saved credential only on a page you opened after starting `npm run dev:admin` yourself.

## Legacy Configuration And State

- Existing `sheetflare.setup.json` files may retain the legacy `deploy` section through the 14-day rollback window. Setup reads only `deploy.admin: false`, as the default for `adminUi`; new configs omit the section.
- Legacy `adminUrl`, `adminUiUsername`, and `adminUiPassword` keys in `.sheetflare.setup.local.json` or `.sheetflare.staging.setup.local.json` are ignored on read and removed on the next state write.
- Legacy UI username/password environment variables are not read.

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

For a Worker release rollback, restore the previous Worker revision, run `npm run smoke`, check critical table cache status, and reindex any table affected by configuration or sheet-shape changes.

## Retired Pages Resource Window

The former Pages projects are not a supported admin path. Keep `sheetflare-admin` and `sheetflare-staging-admin` untouched for exactly 14 days after the local-admin cutover merge as a rollback safety window.

During that window only, rollback the cutover by reverting its commit. If the setup config no longer contains the legacy section, restore `"deploy": { "api": true, "admin": true }`, then run the reverted `npm run setup -- --deploy`. Do not direct operators to the retained site or redeploy it except as part of this rollback.

After day 14, decommission the retained resources:

```powershell
npx wrangler pages project delete sheetflare-admin
npx wrangler pages project delete sheetflare-staging-admin
```

Then delete GitHub repository secrets `SHEETFLARE_STAGING_ADMIN_UI_USERNAME` and `SHEETFLARE_STAGING_ADMIN_UI_PASSWORD`. Replace or narrow `CLOUDFLARE_API_TOKEN` so it no longer grants Pages Write while retaining the Worker permissions required for deployment. Project deletion removes the project secrets. No Worker secret or admin API-key rotation is needed unless incident evidence indicates credential exposure.

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
