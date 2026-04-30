# Google Service Accounts

This guide defines the recommended Google credential setup for Sheetflare.

The current runtime expects a Google service-account client email plus private key. It does not use a browser OAuth flow or Google-managed workload identity.

Use this guide when you are:

- creating staging or production credentials
- deciding whether to use one shared credential or named per-project credentials
- rotating Google credentials after initial deploy

## Recommended Setup

Use this model unless you have a strong reason to do something else:

- create one dedicated user-managed service account per environment
- use names such as `sheetflare-staging` and `sheetflare-prod`
- enable the Google Sheets API and Google Drive API in that GCP project
- share only the exact spreadsheets Sheetflare should manage with the service-account email
- grant spreadsheet-level `Editor` access through Google Sheets sharing

Avoid these patterns:

- default Compute Engine or App Engine service accounts
- domain-wide delegation
- broad project roles such as `Editor`
- reusing the same service account across staging and production
- committing the JSON key into the repo or pasting it into project docs

## Why This Setup Fits Sheetflare

The Worker calls Google Sheets through a direct service-account JWT adapter.

That means:

- the service account needs access to the spreadsheets themselves
- the private key must be available to the Worker as a secret
- spreadsheet sharing is the main authorization boundary, not broad GCP IAM

## Create a Dedicated Service Account

1. Choose or create a GCP project for the environment.
2. Enable the Google Sheets API and Google Drive API.
3. Create a user-managed service account.
4. Create a key only if your org policy allows service-account keys.

Example `gcloud` flow:

```powershell
$projectId = "YOUR_GCP_PROJECT_ID"
$serviceAccountName = "sheetflare-staging"

gcloud config set project $projectId
gcloud services enable sheets.googleapis.com

gcloud iam service-accounts create $serviceAccountName `
  --description="Dedicated service account for Sheetflare staging" `
  --display-name="Sheetflare Staging"

gcloud iam service-accounts keys create "$env:TEMP\$serviceAccountName-key.json" `
  --iam-account="$serviceAccountName@$projectId.iam.gserviceaccount.com"
```

Useful verification commands:

```powershell
$projectId = "YOUR_GCP_PROJECT_ID"
$serviceAccountEmail = "sheetflare-staging@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com"

gcloud iam service-accounts describe `
  $serviceAccountEmail `
  --project $projectId

gcloud iam service-accounts keys list `
  --iam-account=$serviceAccountEmail `
  --project $projectId
```

If key creation is blocked, that is usually an org-policy restriction. Sheetflare currently needs a service-account private key, so resolve that restriction before continuing.

## Share the Spreadsheets

Open each spreadsheet that Sheetflare should manage and add the service-account email through the normal Google Sheets `Share` flow.

Grant:

- `Editor`

Do not grant broader Drive access than needed. The service account should see only the spreadsheets it actually manages.

## Worker Secret Layout

If you are using one credential for the whole deployment:

- set `GOOGLE_CLIENT_EMAIL` to the service-account email
- set `GOOGLE_PRIVATE_KEY` to the private key

`GOOGLE_CLIENT_EMAIL` is not a secret, but it is still environment-specific and should be managed with the rest of the deploy config. `GOOGLE_PRIVATE_KEY` is a secret and should be stored as one.

If you need multiple credentials in one deployment, use `GOOGLE_CREDENTIALS_JSON` as a secret instead of scattering additional env vars.

Expected shape:

```json
{
  "staging": {
    "clientEmail": "sheetflare-staging@your-project.iam.gserviceaccount.com",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  },
  "prod": {
    "clientEmail": "sheetflare-prod@your-project.iam.gserviceaccount.com",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  }
}
```

Then set each Sheetflare project's `googleCredentialRef` to the matching key, for example:

- `staging`
- `prod`

If you use only one shared credential, leave `googleCredentialRef` unset during project creation or set it to `default`.

## Wrangler Secret Examples

Before setting Worker secrets, verify Wrangler is authenticated:

```powershell
npx wrangler whoami
```

If it reports that you are not authenticated, run:

```powershell
npx wrangler login
```

One shared credential manual fallback:

```powershell
npx wrangler secret put GOOGLE_PRIVATE_KEY --config apps/api/wrangler.jsonc
npx wrangler secret put GOOGLE_DRIVE_WEBHOOK_SECRET --config apps/api/wrangler.jsonc
```

Then set `GOOGLE_CLIENT_EMAIL` as a normal Worker variable through your deploy system. `GOOGLE_DRIVE_WEBHOOK_SECRET` is required when you enable automatic Drive-watch reindexing and should be treated as Worker secret material. If you are using the standard onboarding flow, prefer `npm run setup` or `npm run setup -- --apply-secrets` instead of editing checked repo defaults directly.

Multiple named credentials manual fallback:

```powershell
npx wrangler secret put GOOGLE_CREDENTIALS_JSON --config apps/api/wrangler.jsonc
```

Treat `GOOGLE_CREDENTIALS_JSON` as secret material because it contains private keys.

## Rotation Guidance

When rotating Google credentials:

1. Create a new key for the same service account, or provision a replacement service account.
2. Update the deployed secret backing `GOOGLE_PRIVATE_KEY` or `GOOGLE_CREDENTIALS_JSON`.
3. Keep the old key active until the new deployment is verified.
4. Reindex one table on each affected Sheetflare project.
5. Verify cache status returns to `fresh`.
6. Revoke the old key.

For production, keep staging and production rotations separate. Do not share the same key across both environments.

## Operational Recommendations

- use separate spreadsheets for staging and production
- keep a small inventory of which Sheetflare project maps to which Google credential ref
- prefer one credential per environment unless you have a real need for per-project isolation
- use `GOOGLE_CREDENTIALS_JSON` only when multiple named refs are operationally justified

## Official References

- [Create service accounts](https://cloud.google.com/iam/docs/service-accounts-create)
- [Best practices for service accounts](https://cloud.google.com/iam/docs/best-practices-service-accounts)
- [Best practices for managing service account keys](https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)
- [Google Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes)
