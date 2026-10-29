# Contributor Staging Guide

This guide is for contributors maintaining the repo-owned staging environment for this project.

It is intentionally separate from the operator-facing docs. Consumer docs should describe how to run a Sheetflare deployment, not the specific staging assets owned by this repository.

## Current Staging Assets

- Cloudflare Worker name: `sheetflare-staging-api`
- Wrangler config: `apps/api/wrangler.staging.jsonc`
- API target: `https://sheetflare-staging-api.<your-account-subdomain>.workers.dev`
- admin UI: the same Worker serves it at `/admin/` from static assets built from `apps/admin`. There is no Pages project and no separate admin deployment.
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
2. saves the Worker secrets
3. deploys `sheetflare-staging-api`, which serves the API and the hosted admin UI at `/admin/`
4. prints the Google service-account email and waits while you share the sheet with it as **Editor**
5. creates the project, table, and API keys
6. performs a real read/write smoke test and verifies the deployment

Setup prints every credential it minted once, in a block headed `SAVE THESE CREDENTIALS NOW`: the bootstrap admin token and the admin, read, and mutation API keys. Copy them into the team password manager then. Setup does not persist them and cannot display them again. Sign in to `https://<staging-worker>/admin/` with the admin API key.

Local staging files are gitignored and separate from production:

- `sheetflare.staging.setup.json` — non-secret project/table choices
- `.sheetflare.staging.setup.local.json` — deployed API URL and Google service-account email

Rerun an individual recovery step only when setup tells you to:

```powershell
npm run setup:staging -- --apply-secrets
npm run setup:staging -- --deploy
npm run setup:staging -- --bootstrap
npm run setup:staging -- --smoke
npm run setup:staging -- --verify
```

Two reruns have side effects worth knowing:

- `--apply-secrets` mints a new bootstrap admin token (printed once) unless you export `ADMIN_BEARER_TOKEN`, and a new Drive webhook secret unless you export `GOOGLE_DRIVE_WEBHOOK_SECRET`. Because the new webhook secret orphans existing Drive watches, setup re-registers them when it knows the API URL and an admin credential, and otherwise warns and tells you to run `npm run ops:watch:drive`. Then put the new token in `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN`, because each Deploy Staging run puts the GitHub value back on the Worker ([keep them in sync](#keep-the-github-secrets-and-the-worker-in-sync)).
- `--bootstrap` never mints a second set of keys. Existing keys with the same names are left alone, so setup cannot show them again. If they are lost, run `npm run setup:staging -- --bootstrap --rotate-keys`: it issues replacements (printed once) and revokes the old keys. If you export `SHEETFLARE_ADMIN_CREDENTIAL`, replace it in your shell with the new admin key before the next setup run, because setup uses that value for admin calls.

## Deployment authority

`npm run setup:staging` is the supported staging deployment path. It owns Google credentials, Worker secrets, bootstrap, smoke validation, Drive watches, and deployment verification. The admin UI is part of the Worker deployment, so there is nothing else to deploy.

The `Deploy Staging` GitHub workflow (`.github/workflows/deploy-staging.yml`, manual dispatch) only redeploys the staging Worker, which ships the admin UI assets with it. It is not a substitute for the setup orchestrator: it does not create credentials, bootstrap keys, or register Drive watches. Any CI-owned staging deployment that needs those must supply the standard setup inputs and invoke the same setup contract rather than duplicating lifecycle commands.

### Repository secrets for the workflow

Set these under **Settings > Secrets and variables > Actions > Repository secrets**. The workflow checks all four right after installing dependencies and fails naming each one that is missing, with a link back to this page:

| Secret | What to put there |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token scoped to the Cloudflare account with `Workers Scripts Write` ([deploy.md](./docs/deploy.md#github-actions-deployment)). |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns `sheetflare-staging-api`. |
| `SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY` | The `private_key` value of a key for the staging service account. Create one with the manual flow in [google-service-accounts.md](./docs/google-service-accounts.md#create-a-dedicated-service-account), paste the PEM, and let the flow delete the local key file. Each Deploy Staging run writes it to the Worker as `GOOGLE_PRIVATE_KEY`. A key that `--apply-secrets --provision-google` creates is not in this secret, so the next Deploy Staging run replaces it. |
| `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN` | The staging `ADMIN_BEARER_TOKEN`: the bootstrap token from the `SAVE THESE CREDENTIALS NOW` block, or any long random string you also keep in the password manager. Each Deploy Staging run writes it to the Worker as `ADMIN_BEARER_TOKEN`, replacing the current value, so replace it whenever `--apply-secrets` mints a new token. |

The workflow writes these two Worker secrets to a temporary secrets file that an `always()` step removes. The Cloudflare token and account ID are used only by Wrangler.

### Keep the GitHub secrets and the Worker in sync

Each manual Deploy Staging run puts `SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY` and `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN` on the Worker, replacing `GOOGLE_PRIVATE_KEY` and `ADMIN_BEARER_TOKEN` there. The workflow passes them to `wrangler deploy --secrets-file`, which replaces same-named secrets. Other Worker secrets, including `GOOGLE_DRIVE_WEBHOOK_SECRET`, are not in that file and keep their values.

Setup changes Worker secrets but never GitHub secrets:

- `--apply-secrets` mints a new `ADMIN_BEARER_TOKEN` unless you export it.
- `--apply-secrets` creates a new Google key only when no Google credential is set in the environment and you pass `--provision-google` or accept the gcloud prompt (the default answer is yes). Setup never deletes keys.

If GitHub is not updated, the next Deploy Staging run puts the GitHub values back on the Worker:

- The token that setup last printed stops working. Requests that present it get 401, including admin UI sign-in. Setup commands such as `--smoke`, `--verify`, and `--bootstrap` fail the same way when `ADMIN_BEARER_TOKEN` in your shell is the stale value and `SHEETFLARE_ADMIN_CREDENTIAL` is not set. Scoped keys are not checked against `ADMIN_BEARER_TOKEN`, so a revert does not affect them.
- The Worker's Google key becomes the key in GitHub. That key keeps working unless someone deleted or disabled it in Google Cloud. If it was deleted, Google Sheets calls made with the Worker's `GOOGLE_PRIVATE_KEY` fail.

To recover:

- If the printed token is still saved, put it in `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN` and rerun Deploy Staging.
- If it is lost, put a new long random value in `SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN`, rerun Deploy Staging, and export the same value as `ADMIN_BEARER_TOKEN` before later setup runs.
- If the key in GitHub was deleted, create a new key with the manual flow in [google-service-accounts.md](./docs/google-service-accounts.md#create-a-dedicated-service-account), put its `private_key` in `SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY`, and rerun Deploy Staging.

Do not rerun `--apply-secrets` to restore a lost token. Without `ADMIN_BEARER_TOKEN` exported, it mints another token. It also mints a new Drive webhook secret unless `GOOGLE_DRIVE_WEBHOOK_SECRET` is exported.

## What Does Not Belong In Consumer Docs

Keep these details out of `quickstart.md`, `operator-runbook.md`, and similar operator-facing docs:

- our specific GCP project ID
- our staging service-account email
- our Worker name
- our repo-specific GitHub Actions workflow
