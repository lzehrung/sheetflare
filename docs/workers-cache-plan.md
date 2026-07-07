# Workers Cache Adoption Plan

## Goal

Adopt Cloudflare Workers Cache idiomatically and safely for Sheetflare read paths without weakening auth, rate limiting, table freshness, client cache safety, or operator observability.

Workers Cache must sit behind the API gateway logic, not in front of it. The default API entrypoint must continue to run on every external request so it can authenticate, authorize, rate limit, assign request IDs, apply CORS, and log request completion.

## Non-goals

- Do not enable Workers Cache globally on the current default API entrypoint.
- Do not cache admin/control-plane responses.
- Do not cache `/ready`.
- Do not add legacy `caches.default` cache-aside logic.
- Do not use Workers Cache as a replacement for `TableDO`'s SQLite cache.
- Do not cache mutation responses.
- Do not use client-visible `Cache-Control: public` for private/API-key table data.

## Reviewed Corrections

This plan was reviewed against the current Cloudflare Workers Cache documentation and the current Sheetflare API implementation. Important corrections from that review:

- Use `cloudflare-cdn-cache-control` or `cdn-cache-control` for edge-only caching of private/API-key read responses, not client-visible `Cache-Control: public`.
- Strip `Authorization` before forwarding to the cached entrypoint, or the inner cache will be `BYPASS` on authenticated requests.
- Do not cache errors by default; non-2xx responses from the cached entrypoint should carry `Cache-Control: no-store`.
- Include a table config version/signature in the cache key or `ctx.props`, so table/project config changes cannot be hidden by an old Workers Cache hit.
- Treat `cacheTtlSeconds = 0` as Workers Cache disabled for that table unless an explicit always-revalidate policy is designed.
- Cap or bypass Workers Cache while `TableDO` reports a pending external-change debounce, so an old edge response cannot outlive the debounce window.
- Do not cache request-specific headers from the inner entrypoint. The default gateway should add `x-request-id`, CORS, and rate-limit headers after the cached entrypoint returns.
- Account for purge rate limits before purging on every high-frequency mutation path.
- Confirm Hono access to the Cloudflare `ExecutionContext` through `c.executionCtx` and type access to `ctx.exports` before implementation.

## Expected Architecture

```mermaid
flowchart LR
  Client --> Default["default API entrypoint<br/>cache disabled<br/>auth/rate-limit/logging"]
  Default --> CachedReads["CachedTableReads entrypoint<br/>cache enabled<br/>GET/HEAD table reads only"]
  CachedReads --> TableDO["TableDO SQLite cache"]
  Mutations["writes / reindex / refresh / config / Drive webhook"] --> Purge["purge cached-read entrypoint"]
  Purge --> CachedReads
```

## Safety Rules

- The default API entrypoint stays uncached.
- Every cached response sets explicit edge cache directives.
- Private/API-key table data uses edge-only cache directives and client-visible `Cache-Control: private, no-store`.
- Public-read table data may use client-visible public caching only if that is an intentional API contract.
- Every cached table response has purgeable `Cache-Tag` values.
- Purges are called from the same entrypoint that owns cached responses.
- Private/authenticated external routes never return `Cache-Control: public` directly from the default entrypoint.
- The default gateway strips `Authorization` before forwarding requests to the cached entrypoint.
- If a cached response varies by caller, caller partitioning must move into `ctx.props` before caching.
- Query strings used for cache keys must be canonicalized before dispatch to the cached entrypoint.
- Config changes that can affect read behavior must change the cache key and purge affected entries.
- Worker cache TTL must align with operator-visible table freshness semantics.
- Error responses must be explicitly uncacheable unless a specific negative-cache contract is designed.
- Cached responses must not include request-specific headers such as stale `x-request-id` or rate-limit values.

## Phase 1 - Platform Prerequisites

- [x] Upgrade API deploy scripts from `npx wrangler@4.85.0` to a Wrangler version that supports per-entrypoint Workers Cache, currently documented as `4.107.0+`.
- [x] Update the API workspace `wrangler` dev dependency to the same supported range.
- [x] Update Cloudflare Workers types if needed for `WorkerEntrypoint`, `ctx.exports`, `ctx.cache.purge`, and `cloudflare:workers` imports.
- [x] Set the API Worker `compatibility_date` to a date compatible with Workers Cache usage.
- [x] Use top-level `cache.enabled = true` plus `exports.default.cache.enabled = false` when Phase 2 adds the cached entrypoint; keep cache config absent until then so staging and production stay uncached.
- [x] Keep staging uncached until the first end-to-end cache validation passes.
- [x] Document that default Workers Cache keying is versioned, so deploys cold-start cached responses unless `cross_version_cache` is later enabled.
- [x] Keep `cross_version_cache` disabled initially.

## Phase 2 - Entrypoint Boundary

- [x] Add a named `CachedTableReads` Worker entrypoint to the API Worker.
- [x] Configure `apps/api/wrangler.jsonc` so the default entrypoint cache is disabled.
- [x] Enable cache only for `CachedTableReads` in the `exports` map.
- [x] Keep the existing Hono app as the default exported API gateway.
- [x] Confirm current Workers types expose `cache` on `ExecutionContext` but do not expose `ctx.exports`; Phase 3 must use the typed `cloudflare:workers` exports surface or add an explicit wrapper before routing through the cached entrypoint.
- [x] Ensure `CachedTableReads` is invoked only through internal Worker-entrypoint calls, not as a new public unauthenticated route surface.
- [x] Ensure custom RPC invalidation methods on `CachedTableReads` call `this.ctx.cache.purge(...)` so purges apply to the cached-read entrypoint, not the default entrypoint.
- [x] Keep custom RPC methods for invalidation only; cacheable work itself must be exposed through `fetch()` because Workers Cache does not cache custom RPC method calls.

## Phase 3 - Cacheable Read Contract

- [ ] Define internal cached-read request paths for list rows, get row, and get schema.
- [ ] Route `GET /v1/projects/{project}/tables/{table}/rows` through `CachedTableReads` only after existing auth, project-boundary checks, public-read checks, and table access loading succeed.
- [ ] Route `GET /v1/projects/{project}/tables/{table}/rows/{id}` through `CachedTableReads` only after existing auth and authorization checks succeed.
- [ ] Route `GET /v1/projects/{project}/tables/{table}/schema` through `CachedTableReads` only after existing auth and authorization checks succeed.
- [ ] Decide and test explicit `HEAD` behavior; Workers Cache shares `GET` and `HEAD` entries and may populate a full `GET` response for a cold `HEAD` request.
- [ ] Preserve current error behavior for auth failures, disabled reads, missing projects, missing tables, unsupported queries, and missing rows.
- [ ] Preserve current response schemas for list rows, get row, and schema responses.
- [ ] Centralize JSON/error serialization so the cached entrypoint cannot drift from existing API error shape.
- [ ] Keep mutation routes on the default entrypoint only.
- [ ] Strip `Authorization` and any other automatic-bypass request headers before calling `ctx.exports.CachedTableReads.fetch(...)`.

## Phase 4 - Cache Key and Config Partitioning

- [ ] Canonicalize list-row query strings before calling `CachedTableReads`.
- [ ] Sort query parameters deterministically.
- [ ] Omit or normalize default query values consistently.
- [ ] Preserve every query component that changes semantics.
- [ ] Include project slug and table slug in the internal cached-read path.
- [ ] Include row ID in the point-read path.
- [ ] Include a table config version in the key, preferably derived from the loaded project/table config such as `project.updatedAt`, `table.updatedAt`, or a stable config signature.
- [ ] Include the public/private auth mode in the key or response policy decision so a project auth-mode change cannot reuse a response with the wrong client cache headers.
- [ ] Use `cf.cacheKey` on the `ctx.exports.CachedTableReads.fetch(...)` call when the internal request URL is not already canonical enough.
- [ ] Use `ctx.props` for unavoidable trusted partitions such as config version or future caller-specific data; remember `ctx.props` is part of the Workers Cache key.
- [ ] Do not rely on hostname for cache partitioning; Workers Cache does not include host in the cache key.
- [ ] Do not put credentials, bearer tokens, raw API keys, or secret material in the key, URL, tags, or props.
- [ ] Add tests proving semantically identical query parameter order maps to one cached key when canonicalized.
- [ ] Add tests proving table/project config changes produce a different key or trigger a purge before old entries can be reused.

## Phase 5 - Response Headers and Client Cache Safety

- [ ] Set explicit edge cache directives on every successful cached table-read response.
- [ ] For private/API-key reads, use `cloudflare-cdn-cache-control: public, max-age=<effectiveTtl>` or `cdn-cache-control` for Workers Cache, and send client-visible `Cache-Control: private, no-store`.
- [ ] For anonymous `public-read` reads, intentionally decide whether clients may cache; if yes, send client-visible `Cache-Control: public, max-age=<effectiveTtl>`, otherwise keep client-visible `Cache-Control: no-store` and use edge-only cache directives.
- [ ] Use `max-age=<effectiveTtl>` for the edge freshness window.
- [ ] Compute `effectiveTtl` from `table.cacheTtlSeconds`, current `TableDO` freshness state, and any external-change debounce deadline.
- [ ] Treat `cacheTtlSeconds = 0` as `no-store` for Workers Cache unless a separate always-revalidate design is approved.
- [ ] If `TableDO` reports an external-change pending with a future `debounceUntil`, cap `effectiveTtl` to the remaining debounce window or bypass Workers Cache for that response.
- [ ] If `TableDO` reports stale state that should trigger synchronous refresh, do not cache the stale response beyond the intended current request.
- [ ] Add a bounded `stale-while-revalidate` window only where serving stale reads is acceptable and documented.
- [ ] Do not combine `s-maxage`, `must-revalidate`, or `proxy-revalidate` with `stale-while-revalidate`; Cloudflare documents that those directives disable stale serving.
- [ ] Set `stale-if-error=0` unless a bounded stale-on-error policy is explicitly chosen and documented.
- [ ] Add `Cache-Tag: project:<project>,table:<project>:<table>` to list and schema responses.
- [ ] Add `Cache-Tag: project:<project>,table:<project>:<table>,row:<project>:<table>:<id>` to point-read responses.
- [ ] Ensure tag values are printable ASCII and short enough for Cloudflare tag limits.
- [ ] Validate tag construction because Cloudflare silently drops invalid tags at storage time.
- [ ] Do not emit `Set-Cookie` on cached read responses.
- [ ] Add `Vary` only for request headers that actually affect representation.
- [ ] If `Vary` is used, normalize the varied request headers in the gateway to avoid unbounded variant fan-out.
- [ ] Never use `Vary: *`; it disables caching.
- [ ] Do not cache inner-entrypoint responses with `x-request-id`, `x-ratelimit-*`, or per-request CORS values; those are default-gateway response concerns.
- [ ] Add explicit `Cache-Control: no-store` to every non-2xx response produced by the cached entrypoint.

## Phase 6 - Purge Contract

- [ ] Add `CachedTableReads.invalidateTable(projectSlug, tableSlug)`.
- [ ] Add `CachedTableReads.invalidateRow(projectSlug, tableSlug, rowId)` only as an optimization; table-level purge remains required for mutations.
- [ ] Purge table cache after successful row create.
- [ ] Purge table cache after successful row update.
- [ ] Purge table cache after successful row delete.
- [ ] Purge table cache after successful admin reindex.
- [ ] Purge table cache after admin refresh when it actually refreshes stale table state.
- [ ] Purge table cache before or after table deletion so stale reads cannot survive table removal.
- [ ] Purge every table cache affected by project deletion.
- [ ] Purge table cache after table config create/upsert when replacing an existing table.
- [ ] Purge table caches after project config changes that can affect auth mode, credential resolution, spreadsheet identity, or table resolution.
- [ ] Purge or cap TTL for affected table cache when Google Drive notification records an external change.
- [ ] Purge affected table cache after automatic reindex/sync completes for an external change.
- [ ] Treat purge failures as operationally visible errors; do not silently continue as if cached reads are invalidated.
- [ ] Check Cloudflare purge rate limits before introducing per-mutation purge calls on potentially high-write deployments.
- [ ] If write volume can exceed purge limits, prefer table-level short TTL, coalesced purges, or a documented degraded mode rather than silent best-effort invalidation.

## Phase 7 - Admin and System No-cache Policy

- [ ] Keep `/ready` uncached.
- [ ] Keep admin/control-plane routes uncached.
- [ ] Keep API-key listing and creation routes uncached.
- [ ] Keep Google Drive watch status, retry advice, registration, stop, and notification routes uncached.
- [ ] Keep spreadsheet tab listing and inspection uncached unless a separate explicit admin cache policy is designed later.
- [ ] Preserve `cache-control: no-store` in the admin Pages API proxy.
- [ ] Add explicit no-store headers to dynamic default-entrypoint responses if default-entrypoint cache lookup is ever enabled for other reasons.
- [ ] Do not cache 401/403 admin or data-route authorization failures.
- [ ] Do not cache 404 table/project/row failures until negative caching and purge behavior are explicitly designed.

## Phase 8 - Optional Docs Cache

- [ ] Decide whether `/doc` and `/docs` are worth caching.
- [ ] If yes, serve them through a separate cached entrypoint or add explicit cache headers only after the default-entrypoint cache hazard is resolved.
- [ ] Use a short or moderate TTL for `/doc` and `/docs`.
- [ ] Rely on default Worker-version cache keying so deploys naturally cold-start docs responses.
- [ ] Do not let docs caching change auth, readiness, or data-route caching behavior.
- [ ] Do not enable cache lookup on the default gateway just to cache docs; Cloudflare documents this as extra latency when most responses are `no-store`.

## Phase 9 - Tests

- [ ] Add route-level tests proving default API auth still runs before cached reads.
- [ ] Add route-level tests proving default API rate limiting still runs before cached reads.
- [ ] Add route-level tests proving private-table anonymous reads are rejected even when a cached entry exists internally.
- [ ] Add route-level tests proving public-read anonymous reads can use cached responses safely.
- [ ] Add tests proving API-key authorized reads do not expose cached private data to unauthorized callers.
- [ ] Add tests proving forwarded cached-entrypoint requests strip `Authorization`.
- [ ] Add tests for edge-only cache headers on private/API-key reads.
- [ ] Add tests for client-visible cache headers on private/API-key reads.
- [ ] Add tests for public-read cache headers.
- [ ] Add tests for cache tags on list, point-read, and schema responses.
- [ ] Add tests proving non-2xx cached-entrypoint responses are `no-store`.
- [ ] Add tests for purge calls after create, update, delete, reindex, refresh, table delete, project delete, and config replacement.
- [ ] Add tests for canonical query key generation.
- [ ] Add tests for config-version key partitioning.
- [ ] Add tests for `cacheTtlSeconds = 0` bypass behavior.
- [ ] Add tests for pending external-change debounce TTL capping or bypass behavior.
- [ ] Add tests for stale/config-change behavior so Workers Cache cannot bypass `TableDO` cache-signature correctness.
- [ ] Add tests for purge failure handling.
- [ ] Add tests confirming default gateway overwrites or appends fresh `x-request-id`, CORS, and rate-limit headers after a cached inner response.
- [ ] Add tests for explicit `HEAD` behavior or explicit rejection.

## Phase 10 - Staging Verification

- [ ] Deploy to staging with `CachedTableReads` enabled and default entrypoint disabled for cache.
- [ ] Request the same public-read list endpoint twice and verify `Cf-Cache-Status` changes from `MISS` to `HIT` or documented equivalent behavior.
- [ ] Request the same private/API-key list endpoint twice and verify gateway auth still runs while the inner response can hit Workers Cache.
- [ ] Verify private/API-key responses are not browser/proxy-cacheable through client-visible headers.
- [ ] Verify private anonymous reads still return `401` or `403` and are not served from cache.
- [ ] Verify an API-key private read still succeeds after gateway auth.
- [ ] Mutate a row and verify the next matching read is not stale beyond the documented purge behavior.
- [ ] Reindex a table and verify cached list/schema responses are invalidated.
- [ ] Change table config and verify stale Workers Cache entries do not survive the change.
- [ ] Trigger or simulate a Drive external-change notification and verify stale edge responses do not outlive the debounce policy.
- [ ] Confirm request logs still appear for default gateway hits, including cached-read hits.
- [ ] Confirm rate-limit headers still appear on default gateway responses when applicable.
- [ ] Confirm `x-request-id` is fresh on default gateway responses and not cached from an old inner response.
- [ ] Confirm errors from the cached entrypoint are not cached.
- [ ] Confirm response sizes for cached list pages are below current Workers Cache limits.

## Phase 11 - Production Rollout

- [ ] Roll out with default Worker-version cache keying; do not enable `cross_version_cache` initially.
- [ ] Monitor `Cf-Cache-Status` on smoke/load traffic.
- [ ] Monitor Workers cache hit ratio, misses, bypasses, and updating responses in Workers Observability.
- [ ] Monitor TableDO request volume and API Worker CPU time before and after rollout.
- [ ] Monitor purge failures and purge rate-limit responses.
- [ ] Monitor stale response reports around Drive external-change notifications and table mutations.
- [ ] Keep a rollback path that disables the `CachedTableReads` entrypoint cache without changing table semantics.
- [ ] Do not enable `cross_version_cache` until deployment invalidation and version-tag purging are explicitly designed.

## Acceptance Criteria

- [ ] Default API entrypoint still runs for every external API request.
- [ ] Auth and rate limiting cannot be bypassed by a Workers Cache hit.
- [ ] Only GET/HEAD table read responses are cacheable.
- [ ] All cached table responses have explicit edge cache directives and `Cache-Tag` headers.
- [ ] Private/API-key responses are not client-cacheable unless a future explicit contract says otherwise.
- [ ] Mutations and config changes purge affected cached read responses or change their cache key before reuse.
- [ ] Public-read behavior remains correct before and after cached entries exist.
- [ ] Private-table behavior remains correct before and after cached entries exist.
- [ ] `cacheTtlSeconds` remains the operator-facing freshness contract.
- [ ] `cacheTtlSeconds = 0` does not accidentally create stale edge responses.
- [ ] Pending external-change debounce state cannot be hidden by a longer Workers Cache TTL.
- [ ] Non-2xx responses from cached read paths are not cached.
- [ ] Staging verification observes expected `Cf-Cache-Status` transitions.
- [ ] `npm run check` passes after implementation.

## References

- Cloudflare announcement: https://blog.cloudflare.com/workers-cache/
- Workers Cache overview: https://developers.cloudflare.com/workers/cache/
- Workers Cache configuration: https://developers.cloudflare.com/workers/cache/configuration/
- Workers Cache keys: https://developers.cloudflare.com/workers/cache/cache-keys/
- Workers Cache purge API: https://developers.cloudflare.com/workers/cache/purge/
- Workers Cache debugging: https://developers.cloudflare.com/workers/cache/debugging/
- Workers Cache examples: https://developers.cloudflare.com/workers/cache/examples/
- Workers Cache limitations: https://developers.cloudflare.com/workers/cache/limitations/
