# Workers Cache Rollout

## Contract

Sheetflare caches eligible table reads in the `CachedTableReads` Worker entrypoint. Every external request still enters the default API gateway, which performs authentication, authorization, rate limiting, project/table resolution, and cache-key construction before dispatch.

Cached operations:

- list rows
- get one row
- get schema

The default entrypoint remains uncached. Admin, system, mutation, readiness, and documentation routes remain on that entrypoint.

## Safety invariants

- The gateway authenticates and authorizes every request before cached dispatch.
- `Authorization` is not forwarded to the cached entrypoint.
- Cache keys contain the canonical query, project auth mode, and resolved table configuration signature; they contain no credential material.
- The inner entrypoint uses `Cloudflare-CDN-Cache-Control` for edge-only caching and `Cache-Tag` for invalidation.
- The outer gateway removes edge-only directives and tags and enforces client-visible `no-store`.
- Errors, unsupported methods, stale/not-ready table state, disabled TTLs, and unsafe tags are not cached.
- External-change debounce bounds the edge TTL.
- Purge failures after committed changes preserve the successful mutation response, set `X-Sheetflare-Cache-Invalidation: failed`, and emit a structured internal error event.
- `X-Sheetflare-Cache-Status` exposes the inner cache result without forwarding Cloudflare cache metadata directly.

## Cache keys

List-row keys normalize these semantic inputs in fixed order:

- `limit`
- `cursor`
- `sort`
- `fields`
- `filter`, serialized with deterministic UTF-16 code-unit key ordering

Absent optional values stay absent. Project auth mode and a SHA-256 signature of resolved project/table configuration partition otherwise identical requests.

Worker-version identity remains part of Cloudflare's default key. Do not enable `cross_version_cache` without a separate compatibility and rollback design.

## Invalidation

Every cached response carries project and table tags. Point reads also carry a row tag when that tag satisfies Cloudflare's printable-ASCII and length limits.

Invalidate:

- project tag after project replacement/deletion and Drive notifications
- table tag after table replacement/deletion, row creation, refresh, and reindex
- table plus row tag after row update/delete

An invalid row tag falls back to table-only invalidation. Unsuccessful purge results and thrown purge failures are recorded as `cache.invalidation.failed`; Cloudflare error details remain internal.

## Automated verification

The API suite covers:

- authentication, project boundaries, and rate limiting before cached dispatch
- public/private access behavior
- canonical query and configuration key partitioning
- credential exclusion from requests, keys, and tags
- cacheable and uncacheable response headers
- namespaced cache-status propagation
- default-gateway cache-metadata stripping and `no-store` enforcement
- method/path/error handling
- tag encoding and limits
- project/table/row invalidation arguments
- post-commit purge failure behavior
- CORS exposure of Sheetflare cache health headers

Run:

```powershell
npm --workspace @sheetflare/api test -- test/index.test.ts
npm run check
```

The local harness invokes the entrypoint directly and records purge requests; it does not emulate Cloudflare cache storage. Staging validation is therefore required before production rollout.

## Staging gate

Deploy through the setup orchestrator:

```powershell
npm run setup:staging -- --deploy
npm run setup:staging -- --verify
```

The staging Wrangler configuration must keep the default entrypoint cache disabled and enable cache only for `CachedTableReads`.

Validate with a configured public-read table and a private API key:

1. Request the same public list URL twice; `X-Sheetflare-Cache-Status` must move from a miss-equivalent status to `HIT`.
2. Repeat with the private API key; auth and rate-limit headers must remain present while the inner response reaches `HIT`.
3. Verify anonymous private reads remain `401`/`403` with `Cache-Control: no-store`.
4. Populate a cached row/list response, mutate the row, and verify the next matching read is fresh.
5. Repeat invalidation checks for table configuration replacement, refresh, reindex, deletion, and a Drive notification.
6. Confirm every outer response receives a fresh `x-request-id` and contains neither `Cache-Tag` nor `Cloudflare-CDN-Cache-Control`.
7. Exercise a response near and above the current Workers Cache response-size limit and record Cloudflare's bypass/rejection behavior.
8. Confirm `cache.invalidation.failed` is absent during the run.

Do not begin production rollout until every staging check passes.

## Production rollout

1. Deploy with the default entrypoint disabled and `CachedTableReads` enabled.
2. Run the staging gate against production smoke tables.
3. Monitor cache status, TableDO request volume, Worker CPU, response size, purge failures, and stale-response reports.
4. Keep `cacheTtlSeconds` within the operator-configured freshness envelope; `0` disables edge caching.
5. Treat any auth bypass, client-cacheable private response, stale post-mutation response, or sustained purge failure as a rollback condition.

## Rollback

Disable cache for `CachedTableReads` in the active Wrangler configuration and redeploy. The gateway and TableDO query path remain authoritative, so rollback changes performance rather than table semantics.

After rollback, verify:

- private and public reads
- mutation freshness
- cache status and reindex operations
- Drive notification handling
- default-gateway `Cache-Control: no-store`

## References

- https://blog.cloudflare.com/workers-cache/
- https://developers.cloudflare.com/workers/cache/
- https://developers.cloudflare.com/workers/cache/cache-keys/
- https://developers.cloudflare.com/workers/cache/purge/
- https://developers.cloudflare.com/workers/cache/debugging/
- https://developers.cloudflare.com/workers/cache/configuration/
