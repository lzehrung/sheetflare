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

## Required API environment

Set these in `apps/api/wrangler.jsonc` for local development or through Cloudflare secrets and variables for deployed environments:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `ADMIN_BEARER_TOKEN`

`ADMIN_BEARER_TOKEN` is the bootstrap admin credential for self-hosted setups. Use it to create scoped API keys, then prefer those keys for normal operation.

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
- Updates and deletes re-resolve rows by ID before mutating the sheet, which keeps the system correct when rows are re-ordered manually in Google Sheets.

## Notes

- Project listing and API keys are handled by a dedicated `ControlPlaneDO`.
- The Google Sheets adapter uses service-account JWT exchange and the Sheets REST API directly, so the worker does not depend on Node-only Google SDKs.
- `npm run build`, `npm run typecheck`, and `npm test` all pass from the repo root.
