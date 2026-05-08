# Quickstart

This is the shortest safe path from one Google Sheet tab to a deployed API.

By the end of this guide, you will have a live Cloudflare Worker API serving rows from your sheet, an admin UI for managing projects and API keys, and a smoke-tested deployment.

Use this guide when you want Sheetflare to make the setup decisions for you. For CI deploy details, manual fallback commands, or deeper operations, see [deploy.md](./deploy.md), [operator-runbook.md](./operator-runbook.md), and [google-service-accounts.md](./google-service-accounts.md).

## 1. Prepare One Sheet

Create one Google Sheet with one tab such as `Users`.

Add a header row:

```text
_id | name | status
```

Rules:

- `_id` must be present.
- Every `_id` value must be unique.
- No `_id` cell may be blank.
- Header names must be unique.
- The smoke-test column you give setup, such as `name`, must exist and be writable.

Setup cannot share the spreadsheet for you. You will share it with the service-account email after setup prints that email.

## 2. Log In

From the repository root:

```powershell
npm install
npx wrangler login
gcloud auth login
```

`wrangler` deploys the Cloudflare Worker and admin Pages site. `gcloud` is only needed if you want setup to create the Google Cloud project and service account for you.

If you already have a service-account JSON file, you can skip `gcloud auth login`. When setup asks whether to provision Google Cloud credentials, choose `No`; setup will then ask for the file path.

If setup provisions Google Cloud credentials, it will ask for the Google Cloud project ID to use. Project IDs are globally unique; setup defaults to your active `gcloud` project when one is configured.

## 3. Run Setup

```powershell
npm run setup
```

For a first run with no `sheetflare.setup.json`, setup asks only for:

- Google Sheet URL or spreadsheet ID
- existing tab name
- writable column to use for setup validation
- whether to provision Google Cloud credentials, when no credential is already available
- Google Cloud project ID, when setup provisions Google Cloud credentials

Beginner setup then uses safe defaults:

- deployment profile: `production`
- project slug/name: `main` / `Main`
- table slug: derived from the tab name
- ID column: `_id`
- cache TTL: `60` seconds
- admin UI: enabled
- public-read API: disabled
- setup actions: apply secrets, deploy, bootstrap, smoke-test, verify

When setup prints the service-account email, share your Google Sheet with that email as `Editor`. If setup pauses or fails before bootstrap because the sheet is not shared yet, share the sheet and rerun bootstrap, smoke, and verification together:

```powershell
npm run setup -- --bootstrap --smoke --verify
```

## 4. What Setup Creates

Setup writes `sheetflare.setup.json` at the repo root. This checked, non-secret file describes the Sheetflare project, table, and smoke-test shape.

When setup applies secrets, deploys, or bootstraps, it also creates or updates `.sheetflare.setup.local.json`. That file is gitignored local operator state. It can contain deployment URLs and admin-site Basic Auth material, so keep it on your machine.

Setup can create or update:

- Worker secrets
- Google Cloud project and service account, when you choose provisioning
- API Worker deployment
- admin Pages project and deployment
- first Sheetflare project and table
- initial admin, read, and mutation API keys
- Google Drive watches for automatic reindexing

Setup still expects you to:

- create the Google Sheet and tab
- share the sheet with the service-account email
- keep service-account keys and local setup state private

## 5. Check The Deployment

Beginner setup runs verification by default. You can rerun it any time:

```powershell
npm run doctor
```

`npm run doctor` checks the local config, resolved Google credential source, API `/ready`, protected admin root, proxied `/docs`, proxied admin API surface, and Drive watch coverage.

Use these when you only want one step:

```powershell
npm run setup -- --apply-secrets
npm run setup -- --deploy
npm run setup -- --bootstrap
npm run setup -- --smoke
npm run setup -- --verify
```

## Advanced Configuration

Run the full prompt flow on a first run with no `sheetflare.setup.json` when you want setup to ask for all configurable fields:

```powershell
npm run setup -- --advanced
```

Or write a starter config and edit it:

```powershell
npm run setup -- --write-default-config
```

Customization stays in `sheetflare.setup.json` unless noted below.

| Customization | Where to configure | Rerun after changing |
| --- | --- | --- |
| Project slug/name | `privateProject.slug`, `privateProject.name` | `npm run setup -- --bootstrap --verify` |
| Table slug/tab name | `privateProject.tables[]` | `npm run setup -- --bootstrap --smoke --verify` |
| Indexed fields | `privateProject.tables[].indexedFields` | `npm run setup -- --bootstrap --verify`, then reindex affected tables |
| Read-only fields | `privateProject.tables[].readOnlyFields` | `npm run setup -- --bootstrap --smoke --verify` |
| Field rules | `privateProject.tables[].fieldRules` | `npm run setup -- --bootstrap --smoke --verify` |
| Cache TTL | `privateProject.tables[].cacheTtlSeconds` | `npm run setup -- --bootstrap --verify` |
| Public-read API | `publicReadProject` | `npm run setup -- --bootstrap --smoke --verify` |
| Named Google credentials | Worker `GOOGLE_CREDENTIALS_JSON` plus `googleCredentialRef` | Apply `GOOGLE_CREDENTIALS_JSON` manually with Wrangler or CI, then `npm run setup -- --deploy --verify` |
| Separate deploy/bootstrap/smoke steps | CLI flags | Run only the matching flag |

### Table Shape

Example table config:

```json
{
  "tableSlug": "users",
  "sheetTabName": "Users",
  "idColumn": "_id",
  "indexedFields": ["name", "status"],
  "readOnlyFields": ["status_label"],
  "fieldRules": {
    "email": {
      "required": true,
      "unique": true,
      "normalize": ["trim", "lowercase"]
    },
    "status": {
      "enum": ["pending", "active"]
    },
    "score": {
      "type": "number"
    }
  },
  "cacheTtlSeconds": 60
}
```

Use `readOnlyFields` for formula-derived or operator-managed columns that API writes must never overwrite.

Use `fieldRules` for write-time validation such as required fields, unique values, finite options, normalization, and explicit number/boolean/date/datetime typing. Sheetflare reads raw cell text as strings unless a field rule gives it a stronger type.

### Public-Read API

`privateProject` is always private. If you also want anonymous reads, add `publicReadProject`; do not add `defaultAuthMode` inside setup config.

The smoke suite always checks private access. It adds anonymous `public-read` coverage when `publicReadProject` is configured.

### Manual Bootstrap Fallback

Prefer setup for normal use. If you need the lower-level bootstrap path, set `SHEETFLARE_BOOTSTRAP_CONFIG_JSON` and run:

```powershell
npm run ops:bootstrap
```

Use [deploy.md](./deploy.md) for raw deploy commands and [operator-runbook.md](./operator-runbook.md) for day-2 operations.

## Common Operations

Create admin key:

```powershell
npm run ops:create-admin-key
```

Inspect cache status:

```powershell
$env:SHEETFLARE_PROJECT = "main"
$env:SHEETFLARE_TABLE = "users"
npm run ops:cache
```

Force reindex:

```powershell
npm run ops:reindex
```

Inspect Drive watch state:

```powershell
npm run ops:watch:drive:status
```

Run a local end-to-end check after local Worker/admin setup:

```powershell
npx playwright install chromium
npm run e2e:local
```

## If Setup Fails

Check these first:

- `npx wrangler whoami` succeeds and shows the right account.
- `gcloud auth list` shows an active account (only needed if you chose Google provisioning).
- The spreadsheet is shared with the service-account email as `Editor`.
- The configured tab exists and matches the name you gave setup exactly.
- `_id` column exists, every value is unique, and no cell is blank.
- The smoke-test column exists and is writable (not formula-derived).

For deeper troubleshooting, see [operator-runbook.md](./operator-runbook.md). To re-run only the failed steps after fixing an issue:

```powershell
npm run setup -- --bootstrap --smoke --verify
```
