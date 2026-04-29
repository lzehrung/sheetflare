# Quickstart

This is the fastest safe path to get Sheetflare running and prove the core loop works.

Use this document if you are:

- a human operator deploying the system
- an agent automating setup and verification

If you need deeper operational detail, use [deploy.md](./deploy.md), [operator-runbook.md](./operator-runbook.md), and [google-service-accounts.md](./google-service-accounts.md).

## 1. Prepare a sheet

Create one Google Sheet with one tab such as `Users` and a header row like:

```text
_id | name | status
```

Rules:

- `_id` must be present
- every `_id` value must be unique
- no `_id` cell may be blank
- header names must be unique

## 2. Prepare Google access

Create a dedicated Google service account for this environment.

Recommended shape:

- one user-managed service account per environment
- Google Sheets API enabled in that GCP project
- spreadsheet-level `Editor` sharing only on the exact spreadsheets Sheetflare will manage

Share the sheet with the service-account email as an editor.

Use [google-service-accounts.md](./google-service-accounts.md) for the exact setup, secret-handling model, `GOOGLE_CREDENTIALS_JSON` format, and key-rotation guidance.

You will need:

- service-account client email
- service-account private key

## 3. Install and run setup

From repo root:

```powershell
npm install
npm run setup
```

The setup flow will:

- check repo prerequisites and, when needed, Wrangler auth for secret or deploy steps
- prompt for the spreadsheet URL or ID
- prompt for the first private project and table mapping
- write `sheetflare.setup.json`
- optionally apply Worker secrets
- optionally deploy the API Worker
- optionally deploy the admin UI
- optionally bootstrap the first project, tables, and keys
- optionally run the smoke suite

The simplest happy path is:

- share the sheet with the Google service-account email first
- point setup at the service-account JSON file when prompted
- let setup generate the bootstrap admin token
- let setup create the initial admin, read, and mutation keys

Setup writes a checked non-secret config file at repo root:

```powershell
sheetflare.setup.json
```

Setup also writes `.sheetflare.setup.local.json` beside it. That local state file stores deployment URLs and generated credentials so reruns can stay noninteractive. It is secret material, it is gitignored, and it should stay on the operator machine only.

The generated config is reusable. Common reruns:

```powershell
npm run setup -- --apply-secrets
npm run setup -- --deploy
npm run setup -- --bootstrap
npm run setup -- --smoke
```

Notes for reruns:

- `npm run setup -- --deploy` will redeploy the admin UI only when `ADMIN_UI_USERNAME` and `ADMIN_UI_PASSWORD` are available from local setup state or the environment.
- `npm run setup -- --smoke` can use either a scoped admin API key or the bootstrap admin credential from local setup state or `SHEETFLARE_ADMIN_CREDENTIAL`.

## 4. What setup still expects from you

Setup does not automate:

- creating the Google service account itself
- enabling the Google Sheets API in GCP
- sharing the spreadsheet with the service-account email
- creating new sheet tabs for you
- custom Worker or Pages naming beyond the checked public defaults
- advanced multi-credential topologies using `GOOGLE_CREDENTIALS_JSON`

For those details, use:

- [google-service-accounts.md](./google-service-accounts.md)
- [deploy.md](./deploy.md)
- [operator-runbook.md](./operator-runbook.md)

## 5. The first table shape setup expects

Add a table config such as:

- `tableSlug`: `users`
- `sheetTabName`: `Users`
- `idColumn`: `_id`
- `indexedFields`: `["name","status"]`
- `readOnlyFields`: optional, for formula-derived or operator-managed columns
- `fieldRules`: optional, for required, unique, enum, normalize, and type validation
- `cacheTtlSeconds`: `15` or `60`

In `sheetflare.setup.json`, `privateProject` is always bootstrapped as a private project.
If you also want anonymous reads, add `publicReadProject` instead of trying to set `defaultAuthMode` inside the setup config.

Set `googleCredentialRef`:

- leave it blank or use `default` if the Worker uses one shared Google credential
- set it explicitly if the project should use a named credential from `GOOGLE_CREDENTIALS_JSON`

If a sheet contains formula-derived columns that the API must never overwrite, configure them in `readOnlyFields`.
Those columns remain readable through the API, but create/update requests cannot target them.

If a table needs basic write-time validation, add `fieldRules`.
Typical uses:

- required fields such as `email`
- finite string options such as `status`
- unique values such as `email`
- normalized fields such as trimmed/lowercased email addresses
- typed fields such as numeric scores or ISO dates

## 6. Manual fallback paths

If you do not want setup to perform one or more actions immediately, it is safe to stop after `sheetflare.setup.json` has been written.

You can then rerun only the needed step:

```powershell
npm run setup -- --apply-secrets
npm run setup -- --deploy
npm run setup -- --bootstrap
npm run setup -- --smoke
```

If you want a completely manual bootstrap path instead of using setup, set `SHEETFLARE_BOOTSTRAP_CONFIG_JSON` and run `npm run ops:bootstrap`.

Template:

```powershell
$env:SHEETFLARE_BOOTSTRAP_CONFIG_JSON = @'
{
  "projects": [
    {
      "slug": "demo",
      "name": "Demo",
      "spreadsheetId": "<SPREADSHEET_ID>",
      "googleCredentialRef": "default",
      "defaultAuthMode": "private",
      "tables": [
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
          "cacheTtlSeconds": 15
        }
      ]
    }
  ],
  "apiKeys": [
    {
      "name": "read",
      "projectSlug": "demo",
      "scopes": ["table:read"]
    },
    {
      "name": "mutation",
      "projectSlug": "demo",
      "scopes": ["table:create", "table:update", "table:delete"]
    },
    {
      "name": "ops-admin",
      "projectSlug": null,
      "scopes": ["admin:projects", "admin:keys"]
    }
  ]
}
'@

npm run ops:bootstrap
```

## 7. Optional public-read coverage

If you also want to exercise anonymous `public-read` behavior, create a second project with:

- `defaultAuthMode: "public-read"`
- its own spreadsheet or tab mapping
- a table such as `users`

The bundled smoke suite always checks the private path. It adds anonymous `public-read` coverage only when `SHEETFLARE_PUBLIC_PROJECT` and `SHEETFLARE_PUBLIC_TABLE` are set.

## 8. Manual smoke inputs

Set the smoke-test environment:

```powershell
$env:SHEETFLARE_PRIVATE_PROJECT = "demo"
$env:SHEETFLARE_PRIVATE_TABLE = "users"
$env:SHEETFLARE_PRIVATE_READ_KEY = "sfk_private-read.secret"
$env:SHEETFLARE_MUTATION_KEY = "sfk_mutation.secret"
$env:SHEETFLARE_SMOKE_CREATE_VALUES_JSON = '{"name":"Smoke Row","status":"active"}'
$env:SHEETFLARE_SMOKE_UPDATE_VALUES_JSON = '{"name":"Smoke Row Updated"}'
```

Optional for anonymous `public-read` coverage:

```powershell
$env:SHEETFLARE_PUBLIC_PROJECT = "demo-public"
$env:SHEETFLARE_PUBLIC_TABLE = "users"
```

Run:

```powershell
npm run smoke
```

Optional artifact:

```powershell
$env:SHEETFLARE_SMOKE_REPORT_PATH = "reports/smoke-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run smoke
```

The smoke suite checks:

- readiness endpoint internal checks
- admin access
- private-table anonymous rejection
- private-table keyed reads
- cache status with `staleReason`
- create/get/update/delete on a smoke row
- admin reindex

When `SHEETFLARE_PUBLIC_PROJECT` and `SHEETFLARE_PUBLIC_TABLE` are set, it also checks:

- public-read anonymous access
- public-read anonymous write rejection

## 9. Inspect cache health

```powershell
$env:SHEETFLARE_PROJECT = "demo"
$env:SHEETFLARE_TABLE = "users"
npm run ops:cache
```

Healthy output should show:

- `status: "ready"`
- `staleReason: "fresh"` after healthy activity or reindex
- `lastSyncError: null`

## 10. Useful operator commands

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
$env:SHEETFLARE_LOAD_REPORT_PATH = "reports/load-$(Get-Date -Format yyyyMMdd-HHmmss).md"
npm run load
```

## 11. If setup fails

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
- `SHEETFLARE_SMOKE_CREATE_VALUES_JSON`
- `SHEETFLARE_SMOKE_UPDATE_VALUES_JSON`

Optional for anonymous `public-read` coverage:

- `SHEETFLARE_PUBLIC_PROJECT`
- `SHEETFLARE_PUBLIC_TABLE`

```powershell
npx playwright install chromium
npm run e2e:local
```

This starts the local API and admin UI, runs the API smoke suite against the local Worker, and then runs browser automation against the admin UI.
