# Sheetflare

![Sheetflare](./docs/assets/sheetflare.jpg)

Sheetflare turns Google Sheets tabs into a REST API. It runs on Cloudflare Workers, caches rows in Durable Objects so reads don't hit Google's API on every request, and ships a lightweight admin UI for managing projects and API keys. It is suited for controlled self-hosted deployments and has not yet been validated for broad public-facing traffic.

## Documentation

| | |
| --- | --- |
| **[Quickstart](./docs/quickstart.md)** | First deployment - start here |
| [Deploy Guide](./docs/deploy.md) | CI setup, Cloudflare token scopes, manual fallbacks |
| [Operator Runbook](./docs/operator-runbook.md) | Day-2 ops: cache inspection, reindex, credentials, failure handling |
| [Google Service Accounts](./docs/google-service-accounts.md) | Credential setup, secret layout, key rotation |
| [Observability](./docs/observability.md) | Structured log events, alert plan |
| [Benchmarking](./docs/benchmarking.md) | Load testing and production evidence |
| [Contributing](./CONTRIBUTING.md) | Development workflow, repo standards |
| [Contributor Staging](./docs/contributor-staging.md) | Shared staging environment (maintainers) |

Project policies: [LICENSE](./LICENSE) · [SECURITY.md](./SECURITY.md) · [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## Get Started

```powershell
npm install
npx wrangler login    # Cloudflare (Workers + Pages)
gcloud auth login     # lets setup create Google credentials automatically; skip if you have a service-account JSON
npm run setup
```

`npm run setup` prompts for your Sheet URL and tab name, deploys the Worker and admin UI, and bootstraps the first project and API keys. Full walkthrough: [docs/quickstart.md](./docs/quickstart.md).

Run `npm run setup -- --help` for all setup flags and rerun patterns.

## How It Works

Each Google Sheet tab you connect becomes a **table** inside a **project**. Sheetflare syncs rows from the sheet into a local SQLite cache inside a Cloudflare Durable Object. Reads and queries serve from that cache; writes go to the sheet first and then update the cache immediately. Google Drive watches trigger automatic cache refreshes when the source sheet changes.

The `setup` command manages the full first-run lifecycle: Google credential provisioning, Worker secrets, deploy, project bootstrap, and smoke validation. For reruns, use targeted flags: `--deploy`, `--bootstrap`, `--smoke`, `--verify`.

## Workspaces

| Workspace | Role |
| --- | --- |
| `apps/api` | Cloudflare Worker, Durable Object entrypoints |
| `apps/admin` | React admin UI (Cloudflare Pages) |
| `packages/contracts` | Shared request/response/RPC/error types |
| `packages/domain` | Row, pagination, and schema utilities |
| `packages/google-sheets` | Google Sheets service-account client |
| `packages/cloudflare` | Durable Object implementations |

## Commands

```powershell
npm install        # install all workspace dependencies
npm run check      # lint + typecheck + test + build
npm run setup      # guided first-time deploy and configuration
npm run dev:api    # local API Worker dev server
npm run dev:admin  # local admin UI dev server
npm run deploy     # deploy API Worker and admin Pages
npm run smoke      # smoke test against a live deployment
npm run load       # load harness against a live deployment
npm run e2e:local  # local end-to-end: API smoke + admin browser automation
```

## Operator Scripts

These target a live deployment. Most require `SHEETFLARE_BASE_URL` and `SHEETFLARE_ADMIN_CREDENTIAL`.

**Setup reruns**

```powershell
npm run setup -- --apply-secrets  # re-apply Worker secrets
npm run setup -- --deploy         # redeploy Worker and admin UI
npm run setup -- --bootstrap      # re-run project and key bootstrap
npm run setup -- --smoke          # re-run smoke validation
npm run setup -- --verify         # re-run post-deploy verification
npm run doctor                    # alias for --verify; quickest health check
```

**Keys and bootstrap**

```powershell
npm run ops:create-admin-key  # create a scoped admin API key
npm run ops:bootstrap         # bootstrap projects/tables/keys from JSON config
```

**Cache and reindex**

```powershell
npm run ops:cache              # inspect cache status for one table
npm run ops:cache:health       # batch health check (exits non-zero if unhealthy)
npm run ops:reindex            # force full reindex on a table
```

**Drive watches**

```powershell
npm run ops:watch:drive               # register or renew all spreadsheet Drive watches
npm run ops:watch:drive:status        # current watch state
npm run ops:watch:drive:retry-advice  # timing guidance for re-registration
npm run ops:watch:drive:stop          # stop known watches
```

## Concepts

**Auth** - Every project is private by default. Admin routes accept the bootstrap bearer token or a scoped admin API key. Data routes accept scoped API keys unless the project is configured as `public-read`. Available scopes: `admin:projects`, `admin:keys`, `table:read`, `table:create`, `table:update`, `table:delete`. Use the bootstrap token as break-glass only - create a scoped admin key after first deploy and use that for routine work. Project-scoped keys with `admin:keys` can create keys only for their own project and only with scopes the creator already holds.

**Row identity** - Every table requires a stable ID column (default: `_id`). Row numbers in the sheet are cache metadata, not identity - Sheetflare re-resolves rows by ID before every write, so manually reordering rows in the sheet is safe. All managed IDs must be unique and non-blank; duplicate or missing IDs block syncs.

**Caching** - Reads (`list`, `get`, `schema`) serve from the local cache. Freshness is controlled by `cacheTtlSeconds`. Full syncs are bounded to the declared header width. Config changes that affect cache shape automatically trigger a resync on the next read or write.

**Field rules** - Declare `readOnlyFields` to prevent API writes from touching formula-derived or operator-managed columns. Declare `fieldRules` to enforce required fields, unique values, enum constraints, normalization (trim/lowercase), and explicit type coercion (number, boolean, date) on writes. Sheet reads are string-first by default; use `fieldRules.type` when a field needs typed indexed filtering.

**Queries** - Filters are AND-only. Sort is single-field with keyset pagination cursors. Indexed fields (declared in `indexedFields`) use fast cache lookups. The `contains` operator is scan-heavy and is blocked above `TABLE_MAX_FULL_SCAN_ROWS`. Passing a filter or sort on a non-indexed field is rejected rather than silently doing a full scan. The interactive API reference at `/docs` documents all filter operators and query parameters.

**CORS** - The admin UI calls the API through its same-origin Pages proxy, so no CORS setup is needed for normal admin use. If you intentionally call the Worker API from another browser origin, set `SHEETFLARE_ALLOWED_ORIGINS` to a comma-separated list of allowed origins.

**Starting envelope** - Conservative defaults before you have staging data: `TABLE_MAX_FULL_SCAN_ROWS` defaults to 10,000; keep `cacheTtlSeconds` between 15–60 seconds; keep `indexedFields` lean (hard limit: 32 including the ID column). Replace these with measured limits from [docs/benchmarking.md](./docs/benchmarking.md).

## API Reference

With the Worker running:

- `GET /docs` - interactive OpenAPI UI
- `GET /doc` - raw OpenAPI document

The docs reflect the full HTTP surface: auth requirements, path and query parameters, request/response shapes. Admin POST routes create by default; add `?upsert=true` to replace an existing config. Admin DELETE routes remove Sheetflare configuration and clear cached state - they do not delete the upstream spreadsheet or tab.

## Admin UI

The admin UI covers the full control-plane: create and delete projects and tables, create and revoke API keys, inspect cache status, and trigger reindex. Drafts are validated before submitting. Credentials are not stored in the browser - paste a scoped admin key or bootstrap token when you need access. Prefer scoped keys for routine use.

Deleting a table clears its local cache before removing table metadata. Deleting a project clears table caches, revokes that project's API keys, and stops Drive watches for spreadsheets no remaining project uses. Delete operations are idempotent.
