# Workers Cache Continuation

Branch: `workers-cache-plan-phase1`

## Current boundary

The branch contains the Workers Cache implementation, setup-profile isolation, staging configuration, focused regressions, and the local-admin cutover plan.

External requests enter the default API gateway. Only authenticated and authorized list, row, and schema reads dispatch to `CachedTableReads`. The gateway remains uncached and owns request IDs, CORS, rate-limit headers, client cache safety, and public error handling.

Implementation and rollout contracts are in [docs/workers-cache-plan.md](./docs/workers-cache-plan.md).

## Required checks before merge

```powershell
npm install
npm run check
npx wrangler@4.107.0 deploy --dry-run --config apps/api/wrangler.staging.jsonc
```

The Wrangler dry-run must accept the per-entrypoint `exports` configuration without an unknown-field warning.

## Staging acceptance

Use the standard orchestrator rather than the raw workflows:

```powershell
npx wrangler login
gcloud auth login
npm run setup:staging -- --deploy
npm run setup:staging -- --verify
```

Required external inputs:

- staging Google Sheet and writable smoke column
- staging Google service-account credential
- staging admin bearer credential
- Cloudflare authentication for the staging account

After deployment, run the complete staging gate in `docs/workers-cache-plan.md`. Preserve the resulting URLs, cache-status observations, mutation freshness checks, response-size result, and purge-error check as rollout evidence.

## Cache degradation contract

A committed mutation remains successful if Workers Cache invalidation fails. The response carries:

```http
X-Sheetflare-Cache-Invalidation: failed
```

The Worker emits `cache.invalidation.failed` with request context and the internal purge error. Clients must not retry a successful mutation solely because cache invalidation degraded. Operators should investigate immediately because cached reads may remain stale until TTL expiry or a later successful purge.

Inner cache behavior is exposed as:

```http
X-Sheetflare-Cache-Status: HIT
```

The gateway never forwards `Cache-Tag` or `Cloudflare-CDN-Cache-Control` to clients.

## Local admin track

Implement the local-only admin cutover on a fresh branch from `main`, not on this cache branch. The implementation plan is [docs/local-admin-cutover-plan.md](./docs/local-admin-cutover-plan.md). Keep the Worker API authorization boundary unchanged and remove the Pages control plane as a clean cutover.
