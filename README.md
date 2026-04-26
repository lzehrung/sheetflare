# Sheetflare

Sheetflare is a Cloudflare-first starter for exposing Google Sheets tabs through a small Hono API backed by Durable Objects.

## Workspaces

- `apps/api`: Cloudflare Worker API and Durable Object entrypoints
- `apps/admin`: lightweight React admin UI
- `packages/contracts`: shared request, response, RPC, and error contracts
- `packages/domain`: pure row, pagination, and schema utilities
- `packages/google-sheets`: Google Sheets service-account client
- `packages/cloudflare`: Durable Object implementations and RPC helpers

## Commands

```powershell
npm install
npm run check
npm run dev:api
npm run dev:admin
```

## API Docs

When the API worker is running:

- `GET /doc` returns the generated OpenAPI document.
- `GET /docs` serves the interactive API reference UI.

The docs reflect the actual HTTP surface, including auth requirements, path params, query params, and request/response bodies for the supported endpoints.

## Required API environment

Set these in `apps/api/wrangler.jsonc` for local development or through Cloudflare secrets and variables for deployed environments:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_CREDENTIALS_JSON` (optional)
- `ADMIN_BEARER_TOKEN`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_WINDOW_SECONDS`

`ADMIN_BEARER_TOKEN` is the bootstrap admin credential for self-hosted setups. Use it to create scoped API keys, then prefer those keys for normal operation.
`RATE_LIMIT_MAX_REQUESTS` and `RATE_LIMIT_WINDOW_SECONDS` control the DO-backed edge request budget for `/v1/*` routes.

Credential model:

- By default, projects use the shared gateway credential ref: `default`.
- `default` resolves to `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`.
- `GOOGLE_CREDENTIALS_JSON` is optional and allows named per-project refs without changing the API shape.
- Project creation validates the referenced credential immediately, so bad named refs fail in the control plane instead of later on the data plane.
- Example:
  `{"analytics":{"clientEmail":"svc@example.com","privateKey":"-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"}}`

## Admin UI

- The admin UI expects an operator credential and stores it locally in the browser.
- Paste either the bootstrap admin token or a scoped admin API key into the auth panel, then the UI will call the protected admin routes with `Authorization: Bearer ...`.
- This keeps the self-host default secure without requiring a separate proxy layer just to browse the control plane.

## Auth Model

- Admin routes use either the bootstrap bearer token or an API key with the relevant admin scope.
- Data routes use scoped API keys unless the project is configured with `defaultAuthMode: "public-read"`.
- API keys are stored in the control-plane durable object with hashed secrets, revocation timestamps, and last-used timestamps.

Example bootstrap flow:

```powershell
$headers = @{
  Authorization = "Bearer <ADMIN_BEARER_TOKEN>"
  "Content-Type" = "application/json"
}

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/v1/admin/keys `
  -Headers $headers `
  -Body '{"name":"local-admin","scopes":["admin:projects","admin:keys","table:read","table:create","table:update","table:delete"]}'
```

The response includes the full API key exactly once.

## Row Identity

- Managed tables require a stable ID column.
- The gateway treats row numbers as a cache only.
- Row creation rejects duplicate managed IDs.
- Updates and deletes re-resolve rows by ID before mutating the sheet, which keeps the system correct when rows are re-ordered manually in Google Sheets.
- Mutation lookup uses a narrow scan of the managed ID column plus targeted row reads instead of rescanning full row payloads, which reduces write-path cost on larger sheets while preserving correctness.

## Cache And Sync

- Each table durable object maintains a materialized row cache in Durable Object SQLite.
- Normal reads (`list`, `get`, `schema`) use cached rows instead of rescanning Google Sheets.
- Cache freshness is controlled by `cacheTtlSeconds` on the table config.
- When the cache is cold or stale, the table durable object performs a sync from Google Sheets and refreshes:
  - cached rows
  - row ID to row number index
  - cached headers
  - sync metadata
- Writes update the cache immediately after successful upstream mutation.
- Deletes force a full sync afterward so row numbers stay consistent.
- Table config changes that affect cache shape, indexing, or sheet layout automatically mark the cache stale and force a resync on the next read or write.

Operator endpoints:

- `POST /v1/admin/projects/:project/tables/:table/reindex`
  Forces a full sync and returns cache status metadata.
- `GET /v1/admin/projects/:project/tables/:table/cache`
  Returns current cache status, row count, staleness, and last sync timestamps.

## Query Semantics

- Filters are AND-only across fields.
- Sort supports one field at a time, plus stable keyset pagination cursors.
- Efficient queries are expected to use indexed fields.
- Every table automatically indexes its ID column.
- Additional indexed fields are declared in table config with `indexedFields`.

Supported filter operators:

- `eq`
- `neq`
- `gt`
- `gte`
- `lt`
- `lte`
- `in`
- `startsWith`
- `contains`
- `isNull`

HTTP note:

- `GET /v1/projects/:project/tables/:table/rows` accepts `filter` as a JSON-encoded query parameter.
- Example:
  `?filter={"status":{"eq":"active"},"score":{"gte":80}}`

Performance notes:

- Equality, range, `in`, and indexed sort retrieval use SQLite-backed cached cell indexes.
- `contains` is supported, but it is scan-heavy. For safety, scan-heavy queries are rejected once a cached table grows beyond the built-in full-scan threshold.
- If a filter or sort targets a non-indexed field, the API rejects it instead of silently doing an expensive query on large caches.
- Mutation note: the write path is optimized separately from list/query execution. Update/delete/create-duplicate checks resolve IDs through the managed ID column, not through the cached query indexes.

## Notes

- Project listing and API keys are handled by a dedicated `ControlPlaneDO`.
- The Google Sheets adapter uses service-account JWT exchange and the Sheets REST API directly, so the worker does not depend on Node-only Google SDKs.
- Google Sheets read paths use bounded retry/backoff for transient upstream failures, while mutation paths avoid automatic replay to reduce duplicate-write risk.
- Non-timeout transport failures are reported distinctly from actual request timeouts.
- Rate limits are bucketed by route family (`admin` vs `data`) so normal data traffic does not consume the same budget as control-plane reads from the same principal.
- Rate-limit principals are derived only from verified credentials; unverified API-key-shaped strings fall back to the anonymous/IP bucket.
- `npm run build`, `npm run typecheck`, and `npm test` all pass from the repo root.
