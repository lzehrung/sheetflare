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

`ADMIN_BEARER_TOKEN` is optional. When set, `/v1/admin/*` routes require `Authorization: Bearer <token>`.

## Notes

- Project listing is handled by a dedicated `RegistryDO`, not an arbitrary project durable object.
- The Google Sheets adapter uses service-account JWT exchange and the Sheets REST API directly, so the worker does not depend on Node-only Google SDKs.
- `npm run build`, `npm run typecheck`, and `npm test` all pass from the repo root.
