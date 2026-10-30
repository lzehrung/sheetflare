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
npx wrangler deploy --dry-run --config apps/api/wrangler.staging.jsonc
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

## Cache freshness contract

Cached reads are keyed by the table's data generation, so a committed mutation, sync, cache clear, configuration change, or recorded Drive change makes older edge entries unreachable. Freshness does not depend on Workers Cache purge, whose rate limit is far below the write rate of a busy table (Free-tier limits: a 25-request burst, then 5 a minute).

The gateway still purges superseded entries after a committed change as best-effort cleanup: one `purge()` call per request or Drive notification with all tags batched, run through `waitUntil` after the response is sent. A mutation response never reports purge status, and clients have nothing to retry or check. Superseded entries expire with their TTL, which is never more than the table's remaining freshness. When Cloudflare rejects a purge, the Worker logs the warning event `cache.invalidation.failed`. Watch its rate to see cleanup pressure, and treat any stale read as a bug whatever the purge state.

Inner cache behavior is exposed as:

```http
X-Sheetflare-Cache-Status: HIT
```

The gateway never forwards `Cache-Tag` or `Cloudflare-CDN-Cache-Control` to clients.

## Local admin track

Implement the local-only admin cutover on a fresh branch from `main`, not on this cache branch. The implementation plan is [docs/local-admin-cutover-plan.md](./docs/local-admin-cutover-plan.md). Keep the Worker API authorization boundary unchanged and remove the Pages control plane as a clean cutover.
