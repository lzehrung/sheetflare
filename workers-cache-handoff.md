# Workers Cache Rollout Handoff

## Resume here

Branch: `workers-cache-plan-phase1`

The local Workers Cache implementation is complete and verified. Staging deployment is the next live step.

Use the normal Sheetflare setup orchestrator from Windows; do not hand-build a Wrangler secrets file:

```powershell
npm install
npx wrangler login
gcloud auth login
npm run setup:staging
```

Setup will ask for the staging sheet URL, existing tab, and a writable smoke-test column. It applies Worker and Pages secrets, deploys both surfaces, pauses while the sheet is shared with the staging service account, bootstraps projects/tables/API keys, runs a real read/write smoke test, and verifies the deployment.

When API keys are shown, copy them into the team password manager. They are shown once and are not persisted locally.

Staging state is isolated from production:

- `sheetflare.staging.setup.json`
- `.sheetflare.staging.setup.local.json`

Both are gitignored local operator files.

## Implemented cache architecture

External requests always enter the default API gateway. It performs auth, authorization, rate limiting, project/table resolution, and canonical key construction before dispatching eligible GET reads to the cached `CachedTableReads` Worker entrypoint.

Cached internal routes:

- list rows
- get one row
- get schema

Safety properties:

- `Authorization` is stripped before cached dispatch.
- Cache keys include canonical queries, project auth mode, and resolved table-config signature.
- Credentials never enter URLs, cache keys, tags, or props.
- Client responses remain `private, no-store`.
- Edge-only cache directives and tags are stripped by the outer gateway.
- Non-GET cached-entrypoint requests are rejected; `HEAD` cannot populate GET entries.
- Disabled/stale/not-ready/unsafe-tag responses bypass Workers Cache.
- External-change debounce caps cache TTL.
- Row, table, project, config, refresh, reindex, delete, and Drive-notification paths purge affected tags.
- Purge failures are visible failures, not best-effort success.
- Default gateway responses are `no-store`; `/doc` and `/docs` intentionally remain uncached.

## Staging configuration

`apps/api/wrangler.staging.jsonc` keeps the default Worker entrypoint cache disabled and enables cache only for `CachedTableReads`.

Expected assets:

- API Worker: `sheetflare-staging-api`
- Admin Pages: `sheetflare-staging-admin`
- API URL: `https://sheetflare-staging-api.lzehrung.workers.dev`
- Google project: `sheetflare-staging`
- Service account: `sheetflare-staging@sheetflare-staging.iam.gserviceaccount.com`

## Verification already passed

- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- staging Wrangler dry-run

Latest observed test totals before the setup UX follow-up:

- admin: 56
- api: 85
- cloudflare: 97
- contracts: 5
- domain: 32
- google-sheets: 22
- root: 191

## Staging verification after setup

After `npm run setup:staging` succeeds, complete Phase 10 in `docs/workers-cache-plan.md` using live evidence:

1. Request the same public-read list URL twice and observe `Cf-Cache-Status` move from `MISS` to `HIT` or Cloudflare's documented equivalent.
2. Repeat a private API-key read; confirm auth and rate-limit headers still appear while the inner response can hit cache.
3. Confirm anonymous private reads still return `401`/`403` and `Cache-Control: no-store`.
4. Mutate a row and confirm the next matching read is not stale.
5. Reindex and confirm list/schema entries are invalidated.
6. Confirm each outer response has a fresh `x-request-id`.
7. Confirm cached list response sizes remain within current Workers Cache limits.

Do not start Phase 11 production rollout until these live staging checks pass.

## GitHub Actions status

The checked-in staging deploy workflows have no configured repository secrets and have never deployed staging. They also bypass the complete setup lifecycle. Local `npm run setup:staging` is authoritative until CI is migrated to invoke the same setup orchestrator with a securely supplied staging config.

## Relevant commits

- `ef3b1cd` — purge cached reads after table changes
- `f3d3d23` — default gateway responses are no-store
- `3c13097` — keep docs uncached in cache rollout
- `d6514d9` — cover cached read gateway headers
- `0d187fc` — enable staging cached read entrypoint
- `f7c5bca` — original rollout handoff
