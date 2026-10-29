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
- Cache keys contain the canonical query, project auth mode, resolved table configuration signature, and the table's data generation; they contain no credential material.
- The inner entrypoint uses `Cloudflare-CDN-Cache-Control` for edge-only caching and `Cache-Tag` for invalidation.
- The outer gateway removes edge-only directives and tags and enforces client-visible `no-store`.
- Errors, unsupported methods, stale/not-ready table state, disabled TTLs, and unsafe tags are not cached.
- A pending external change marks the table stale, so nothing is stored at the edge until the reindex completes.
- Freshness never depends on a purge. The gateway reads the table's data generation before every cached read and keys the read by it, so a committed change makes older entries unreachable. Purge only frees superseded entries early; a rejected or failed purge changes nothing a client can observe.
- `X-Sheetflare-Cache-Status` exposes the inner cache result without forwarding Cloudflare cache metadata directly.

## Cache keys

List-row keys normalize these semantic inputs in fixed order:

- `limit`
- `cursor`
- `sort`
- `fields`
- `filter`, serialized with deterministic UTF-16 code-unit key ordering

Absent optional values stay absent. Project auth mode and a SHA-256 signature of resolved project/table configuration partition otherwise identical requests.

The key and the entrypoint props also carry the table's `dataGeneration`. `TableDO` advances it on every sync promotion, committed create/update/delete, cache clear, change of cached-read configuration, and recorded external change, so any of those moves later reads to a new key. The gateway gets it from `table.generation.get`, which answers from the table's metadata without syncing or calling Google. It starts that call together with the table lookup, so it overlaps the per-key rate limit, and only a caller that may read the table causes it. If the call fails, the read fails; it is never served unkeyed.

Worker-version identity remains part of Cloudflare's default key. Do not enable `cross_version_cache` without a separate compatibility and rollback design.

## Freshness and invalidation

Edge TTL is the table's remaining freshness: `max-age = max(0, cacheTtlSeconds - (now - lastSyncCompletedAt))`, never more than `cacheTtlSeconds` (at most 3600). The cached entrypoint stores nothing when that is zero, when the table is stale or not ready (a pending external change counts as stale), or when the table is no longer at the generation the key was built for because a write or sync overtook the read. An entry therefore cannot outlive the table's own freshness, and a read that was in flight during a write cannot pin older data.

Every cached response still carries project and table tags, and point reads also carry a row tag when it satisfies Cloudflare's printable-ASCII and length limits. The gateway purges them as best-effort cleanup after:

- project replacement/deletion, and Drive notifications that recorded a change (every project on the notified spreadsheet, named in the notify result)
- table replacement/deletion, row creation, refresh, and reindex
- row update/delete (table plus row tag)

Each request or notification sends one `purge()` call with all its tags, split only beyond Cloudflare's 100 tags per call, and runs it through `waitUntil` after the response. Workers Cache purge always uses Cloudflare's Free-tier limits (a burst of 25 requests, then 5 a minute), so on a busy table many purges are rejected. That only leaves superseded entries to expire at their TTL. A rejected or thrown purge is logged as the warning event `cache.invalidation.failed`; Cloudflare error details stay internal, and no response header reports purge status.

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
- batched project/table/row purge targets, the 100-tag split, and purge failures that never change a mutation response
- generation-keyed cache keys, and a generation lookup that overlaps the rate limit and is never made for denied callers
- edge TTL bounded by the table's remaining freshness, and no store when the generation moved during a read
- Drive notifications: no purge for replayed or out-of-order messages, one purge for every project on the spreadsheet, no registry scan
- read-after-write through an emulated Workers Cache: 40 row updates in one minute with the purge budget exhausted, a read in flight during a write, a write overtaking a read, and a Drive change whose purge is rejected
- CORS exposure of Sheetflare cache health headers

Run:

```powershell
npm --workspace @sheetflare/api test
npm run check
```

The local harness emulates Workers Cache storage and purge limits from Cloudflare's documentation (entries keyed by `cf.cacheKey` and props, tag purge, a 25-token bucket refilled at 5 per minute, at most 100 tags per call) and drives the gateway against a stateful table double. It proves the gateway does not depend on purge and fills the cache consistently. It does not prove how production behaves, so staging validation is still required before production rollout.

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
4. Populate a cached row/list response, mutate the row more than 25 times within a few minutes so the purge budget runs out, and verify every next matching read is fresh.
5. Repeat the freshness checks for table configuration replacement, refresh, reindex, deletion, and a Drive notification.
6. Confirm every outer response receives a fresh `x-request-id` and contains neither `Cache-Tag` nor `Cloudflare-CDN-Cache-Control`.
7. Exercise a response near and above the current Workers Cache response-size limit and record Cloudflare's bypass/rejection behavior.
8. Review `cache.invalidation.failed` warnings. They are expected once the purge budget is exhausted and must never coincide with a stale read.

Do not begin production rollout until every staging check passes.

## Production rollout

1. Deploy with the default entrypoint disabled and `CachedTableReads` enabled.
2. Run the staging gate against production smoke tables.
3. Monitor cache status, TableDO request volume (every cached read adds one `table.generation.get`), Worker CPU, response size, the `cache.invalidation.failed` rate, and stale-response reports.
4. Keep `cacheTtlSeconds` within the operator-configured freshness envelope (at most 3600); `0` disables edge caching.
5. Treat any auth bypass, client-cacheable private response, or stale post-mutation response as a rollback condition. A sustained purge failure is not one: it only delays cleanup of superseded entries.

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
