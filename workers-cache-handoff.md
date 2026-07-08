# Workers Cache Rollout Handoff

## Current state

Branch: `workers-cache-plan-phase1`

Latest pushed commit: `0d187fc Enable staging cached read entrypoint`

Tracked working tree status at handoff: clean.

Untracked files intentionally left untouched:

- `.codegraph-cache/`
- `contributor-staging.md`

## What has been implemented

### Cached read entrypoint

`apps/api/src/index.ts` now contains the `CachedTableReads` Worker entrypoint for internal table reads.

External API requests still enter the default gateway. The gateway performs auth, authorization, rate limiting, table resolution, and canonical cache-key construction before dispatching eligible reads to `ctx.exports.CachedTableReads.fetch(...)`.

Cached read routes are internal only:

- `/internal/cache/v1/projects/{project}/tables/{table}/rows`
- `/internal/cache/v1/projects/{project}/tables/{table}/rows/{id}`
- `/internal/cache/v1/projects/{project}/tables/{table}/schema`

The internal cached entrypoint rejects non-GET requests. `HEAD` returns `405` with `allow: GET` and `cache-control: no-store` so `HEAD` cannot populate GET cache entries.

### Cache key policy

Gateway-created internal cached-read requests:

- strip `Authorization`
- use `cf.cacheKey`
- canonicalize list-row query parameters
- partition by project auth mode via `__sf_auth`
- partition by resolved table config signature via `__sf_config`
- keep credentials/secrets out of the URL and cache key

### Cached response headers

Successful cached read responses from `CachedTableReads` use:

- client-visible `cache-control: private, no-store`
- edge-only `cloudflare-cdn-cache-control`
- `cache-tag`

Tags:

- list rows: `project:{project}`, `table:{project}:{table}`
- schema: `project:{project}`, `table:{project}:{table}`
- point read: `project:{project}`, `table:{project}:{table}`, `row:{project}:{table}:{encodedRowId}`

If required tags exceed Cloudflare purge/header constraints, the response bypasses Workers Cache with edge `no-store` and no `cache-tag`.

### Default gateway safety

Default gateway responses now default to:

- `cache-control: no-store`

The default gateway strips these edge-only headers before client return:

- `cloudflare-cdn-cache-control`
- `cache-tag`

Cached data-read routes preserve client-visible `private, no-store` while still receiving fresh outer gateway headers:

- `x-request-id`
- CORS headers when configured
- rate-limit headers

### Mutation and config invalidation

Purge methods were added to `CachedTableReads`:

- `invalidateProject(projectSlug)`
- `invalidateTable(projectSlug, tableSlug)`
- `invalidateRow(projectSlug, tableSlug, rowId)`

Route-layer invalidation now covers:

- project upsert replacement
- project delete
- table upsert replacement
- table delete
- row create
- row update
- row delete
- admin refresh
- admin reindex
- Drive external-change notifications

Purge failures surface as errors rather than silent success.

### Docs cache decision

`/doc` and `/docs` are intentionally not cached in this rollout. They stay on the default gateway and receive `cache-control: no-store`.

### Staging config

`apps/api/wrangler.staging.jsonc` now has:

```jsonc
"cache": {
  "enabled": false
},
"exports": {
  "CachedTableReads": { "type": "worker", "cache": { "enabled": true } }
}
```

This keeps the default entrypoint out of Workers Cache and enables Workers Cache only for `CachedTableReads`.

## Commits pushed in this session

- `ef3b1cd Purge cached reads after table changes`
- `f3d3d23 Default gateway responses are no-store`
- `3c13097 Keep docs uncached in cache rollout`
- `d6514d9 Cover cached read gateway headers`
- `0d187fc Enable staging cached read entrypoint`

## Verification already run

Full local verification passed after Phase 9:

```powershell
npm run build
npm run typecheck
npm run lint
npm run test
```

Observed results:

- build: passed; includes Wrangler dry-run
- typecheck: passed
- lint: passed
- test: passed
  - admin: `56 passed`
  - api: `85 passed`
  - cloudflare: `97 passed`
  - contracts: `5 passed`
  - domain: `32 passed`
  - google-sheets: `22 passed`
  - root tests: `191 passed`

Staging config dry-run passed after enabling the cached entrypoint:

```powershell
npx wrangler@4.107.0 deploy --config apps/api/wrangler.staging.jsonc --dry-run
```

## Why staging deploy stopped

The Linux/non-interactive harness could not deploy because `CLOUDFLARE_API_TOKEN` was missing.

Failed command:

```powershell
npm --workspace @sheetflare/api run deploy:staging
```

Wrangler error:

```text
In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.
```

Do not use `--temporary` for this handoff. It deploys to a temporary account and does not verify the configured staging Worker.

## Resume from Windows: deploy staging

Staging target details are also in `contributor-staging.md`.

API Worker:

- Worker name: `sheetflare-staging-api`
- Expected URL: `https://sheetflare-staging-api.lzehrung.workers.dev`
- Config: `apps/api/wrangler.staging.jsonc`

Deploy with the same Windows-side secrets flow used before:

```powershell
$keyJson = Get-Content "$env:TEMP\sheetflare-staging-key.json" -Raw | ConvertFrom-Json
$adminBearerToken = "<STAGING_ADMIN_BEARER_TOKEN>"
$secretsPath = Join-Path $env:TEMP "sheetflare-staging-secrets.json"

@{
  GOOGLE_PRIVATE_KEY = $keyJson.private_key
  ADMIN_BEARER_TOKEN = $adminBearerToken
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $secretsPath

npx wrangler deploy --config apps/api/wrangler.staging.jsonc --secrets-file $secretsPath

Remove-Item -LiteralPath $secretsPath
```

If using API-token auth instead of an already logged-in Wrangler session, set:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<CLOUDFLARE_API_TOKEN>"
```

Then deploy:

```powershell
npx wrangler deploy --config apps/api/wrangler.staging.jsonc --secrets-file $secretsPath
```

## Resume from Windows: Phase 10 smoke checks

Update `docs/workers-cache-plan.md` Phase 10 only after the checks are actually observed against staging.

Required smoke env for the existing smoke runner:

```powershell
$env:SHEETFLARE_BASE_URL = "https://sheetflare-staging-api.lzehrung.workers.dev"
$env:SHEETFLARE_ADMIN_BEARER_TOKEN = "<STAGING_ADMIN_BEARER_TOKEN>"
$env:SHEETFLARE_PRIVATE_PROJECT = "<private-project-slug>"
$env:SHEETFLARE_PRIVATE_TABLE = "<private-table-slug>"
$env:SHEETFLARE_PRIVATE_READ_KEY = "<read-scoped-api-key>"
$env:SHEETFLARE_MUTATION_KEY = "<mutation-capable-api-key>"
$env:SHEETFLARE_SMOKE_CREATE_VALUES_JSON = '{"_id":"placeholder"}'
$env:SHEETFLARE_SMOKE_UPDATE_VALUES_JSON = '{"status":"updated"}'
```

Optional public-read coverage:

```powershell
$env:SHEETFLARE_PUBLIC_PROJECT = "<public-read-project-slug>"
$env:SHEETFLARE_PUBLIC_TABLE = "<public-read-table-slug>"
```

Run:

```powershell
npm run smoke:staging
```

The smoke runner verifies:

- `/ready` works
- admin project listing works
- private anonymous reads are rejected
- private API-key reads succeed
- optional public-read anonymous reads succeed
- cache status reports stale reason
- row create/read/update/delete path works
- admin reindex works

## Manual Workers Cache checks still needed

The existing smoke runner does not fully prove `Cf-Cache-Status` transitions. Perform these manually after staging deploy.

Use unique query parameters when checking cache transitions so old staging entries cannot affect the observation.

### Public-read cache transition

```powershell
$base = "https://sheetflare-staging-api.lzehrung.workers.dev"
$publicProject = "<public-read-project-slug>"
$publicTable = "<public-read-table-slug>"
$cacheProbe = [guid]::NewGuid().ToString("N")
$path = "/v1/projects/$publicProject/tables/$publicTable/rows?limit=1&cacheProbe=$cacheProbe"

$r1 = Invoke-WebRequest -Uri "$base$path" -Method GET
$r1.Headers["Cf-Cache-Status"]
$r1.Headers["Cache-Control"]
$r1.Headers["X-Request-Id"]

$r2 = Invoke-WebRequest -Uri "$base$path" -Method GET
$r2.Headers["Cf-Cache-Status"]
$r2.Headers["Cache-Control"]
$r2.Headers["X-Request-Id"]
```

Expected:

- first response: `Cf-Cache-Status` is `MISS` or Cloudflare's documented equivalent for the first fill
- second response: `Cf-Cache-Status` is `HIT` or documented equivalent
- client-visible `Cache-Control` remains `private, no-store`
- `X-Request-Id` is present and fresh per gateway response

### Private/API-key cache transition with gateway auth still running

```powershell
$base = "https://sheetflare-staging-api.lzehrung.workers.dev"
$privateProject = "<private-project-slug>"
$privateTable = "<private-table-slug>"
$readKey = "<read-scoped-api-key>"
$cacheProbe = [guid]::NewGuid().ToString("N")
$path = "/v1/projects/$privateProject/tables/$privateTable/rows?limit=1&cacheProbe=$cacheProbe"
$headers = @{ Authorization = "Bearer $readKey" }

$r1 = Invoke-WebRequest -Uri "$base$path" -Method GET -Headers $headers
$r1.Headers["Cf-Cache-Status"]
$r1.Headers["Cache-Control"]
$r1.Headers["X-RateLimit-Limit"]
$r1.Headers["X-Request-Id"]

$r2 = Invoke-WebRequest -Uri "$base$path" -Method GET -Headers $headers
$r2.Headers["Cf-Cache-Status"]
$r2.Headers["Cache-Control"]
$r2.Headers["X-RateLimit-Limit"]
$r2.Headers["X-Request-Id"]
```

Expected:

- inner cached response can transition from miss to hit
- gateway auth still runs because request requires `Authorization`
- rate-limit headers are present
- client-visible `Cache-Control` remains `private, no-store`
- `X-Request-Id` is present and fresh per gateway response

### Private anonymous read remains blocked

```powershell
$base = "https://sheetflare-staging-api.lzehrung.workers.dev"
$privateProject = "<private-project-slug>"
$privateTable = "<private-table-slug>"

$r = Invoke-WebRequest -Uri "$base/v1/projects/$privateProject/tables/$privateTable/rows?limit=1" -Method GET -SkipHttpErrorCheck
$r.StatusCode
$r.Headers["Cf-Cache-Status"]
$r.Headers["Cache-Control"]
```

Expected:

- status is `401` or `403` according to the current route contract
- response is not served as cached table data
- `Cache-Control` is `no-store`

### Mutation invalidation

After a successful row mutation through the staging API, repeat the exact cached read and verify stale data is not served beyond the documented purge behavior.

Use the existing smoke runner for create/update/delete, then manually repeat a matching read if needed.

### Reindex invalidation

```powershell
$base = "https://sheetflare-staging-api.lzehrung.workers.dev"
$adminBearerToken = "<STAGING_ADMIN_BEARER_TOKEN>"
$privateProject = "<private-project-slug>"
$privateTable = "<private-table-slug>"

Invoke-WebRequest `
  -Uri "$base/v1/admin/projects/$privateProject/tables/$privateTable/reindex" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $adminBearerToken" }
```

Then repeat list/schema reads and verify they are not stale.

## Phase 10 checklist status

In `docs/workers-cache-plan.md`:

- checked: staging config is deployable with default cache disabled and `CachedTableReads` cache enabled
- unchecked: actual staging deploy and live smoke checks
- note added: deploy was blocked by missing `CLOUDFLARE_API_TOKEN`

## Phase 11 status

Production rollout has not started. Do not mark Phase 11 items until staging verification passes.

Keep these production constraints:

- roll out with default Worker-version cache keying
- do not enable `cross_version_cache`
- monitor `Cf-Cache-Status`, hit ratio, misses, bypasses, updating responses
- monitor TableDO volume and API Worker CPU
- monitor purge failures/rate limits
- keep rollback path: disable `CachedTableReads` entrypoint cache without changing table semantics

## Acceptance criteria status

Most local acceptance criteria are covered by tests and code. Do not mark the full acceptance section complete until staging verifies real `Cf-Cache-Status` behavior.

Already covered locally:

- default API entrypoint runs for external requests
- auth/rate limiting happen before cached reads
- only internal GET cached read paths are cacheable; `HEAD` is rejected
- cached table responses have explicit edge directives/tags when safe
- private/API-key responses are not client-cacheable
- mutations/config changes purge or key-partition affected cached read responses
- public/private behavior is covered by route tests
- `cacheTtlSeconds = 0` bypass is covered
- external-change debounce TTL cap is covered
- non-2xx cached read responses are `no-store`
- `npm run build`, `typecheck`, `lint`, and `test` passed

Still requires staging:

- `Cf-Cache-Status` transition observation
- live stale-response checks after mutation/reindex/config changes
- live response-size confirmation for cached list pages
