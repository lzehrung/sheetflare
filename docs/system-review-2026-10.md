# System Review — October 2026

Full-system review of `main` at `68da2a1` covering performance, security, logic, test coverage, usability, and documentation. Each item names its evidence level: **proven** (test, probe, or vendor documentation) or **inference** (code reading). Check an item only when the fix and its regression test are merged.

Severity: **P1** likely wrong behavior or significant risk; **P2** real but bounded; **P3** minor.

## Batch 1 — Security and setup

- [ ] **P1 · security** Project delete removes local state before revoking keys; a failed control-plane step leaves keys valid, and a re-created slug inherits them. Revoke and mark deleting first, then delete local rows. *(proven: real-stack probe)* — `project-do.ts:451-453`, `control-plane-do.ts:333-359`
- [ ] **P1 · tests** Auth verification is not under real test: removing the hash comparison in `verifyApiKey` or changing what the gateway hashes leaves all tests green. Add real-stack create → authenticate → wrong secret → revoke → reject tests. *(proven: mutation runs)* — `control-plane-do.ts:458`, `apps/api/src/index.ts:432`
- [ ] **P1 · usability** Default `npm run setup` redacts the generated bootstrap token and all API keys and persists none, so a first-time operator cannot sign in. Provide an explicit one-time credential handoff. *(proven)* — `scripts/lib/setup-runtime.ts:75-87`, `docs/quickstart.md:71`
- [ ] **P1 · security** Rerunning `--bootstrap` mints a new set of privileged keys each time without revoking old ones. *(proven: code)* — `scripts/bootstrap-run.ts:77-90`
- [ ] **P1 · logic** `--apply-secrets` regenerates the Drive webhook secret without re-registering watches; notifications then fail with 401. *(proven: code)* — `scripts/lib/setup-secrets.ts:158-165`, `scripts/setup.ts:456-460`
- [ ] **P1 · security** `/ready` is unauthenticated and unthrottled, scans the registry and writes a rate-limit row per call, and discloses secret configuration state. *(proven: probe)* — `apps/api/src/index.ts:2252-2308`
- [ ] **P2 · security** Upstream Google error text, transport errors, and credential-parser snippets reach public error bodies. *(proven: probe)* — `packages/google-sheets/src/service.ts:933-1000`, `packages/cloudflare/src/google-credentials.ts:42-47`, `packages/cloudflare/src/rpc.ts:38-59`
- [ ] **P2 · security** Anonymous callers create never-deleted Durable Objects (ProjectDO per slug, RateLimitDO per IPv6 address); expired rate-limit rows have no cleanup alarm. *(proven: probe)* — `apps/api/src/index.ts:465-468,913-930`, `rate-limit-do.ts:126-136`
- [ ] **P2 · logic** Project delete and watch cleanup return 5xx indefinitely when Google fails or two projects share a spreadsheet with different credential refs. *(proven: probe)* — `control-plane-do.ts:354-357,702-735,813-824`
- [ ] **P2 · security** Local admin proxy grants the server credential to marked requests without `Sec-Fetch-Site`. *(proven: test)* — `apps/admin/vite-proxy.ts:99-142`
- [ ] **P3 · security** Bootstrap and webhook secrets use `===`; the webhook route has no failure throttle; no minimum secret strength. — `apps/api/src/index.ts:588,810,2680`

## Batch 2 — Cache freshness

- [ ] **P1 · logic** Edge freshness depends on one `purge()` per change, but Workers Cache purge always uses Free-tier limits (5/min, burst 25). Key cached reads by a per-table data generation so committed changes never depend on purge; keep purge as best-effort cleanup, batched per request. *(proven: Cloudflare docs)* — `apps/api/src/index.ts:1004-1035,2079-2091`
- [ ] **P2 · logic** A read in flight during a write can store pre-write data for a full TTL; edge TTL ignores elapsed freshness (up to 2× TTL); `cacheTtlSeconds` is unbounded. *(proven: emulator probe)* — `apps/api/src/index.ts:1781-1839`, `packages/contracts/src/api.ts:29`
- [ ] **P2 · tests** An API test feeds a cache state the real TableDO cannot produce (`stale:false` with pending external change); the debounce-capped TTL branch is unreachable. *(proven)* — `apps/api/test/index.test.ts:1242-1264`, `apps/api/src/index.ts:1768-1791`
- [ ] **P2 · docs** Observability lists no cache-invalidation or reindex-failure alerts; Wrangler configs do not enable Workers Logs. — `docs/observability.md`, `apps/api/wrangler*.jsonc`

## Batch 3 — Data-plane correctness

- [ ] **P1 · logic** Unique fields with `trim`/`lowercase` compare normalized candidates with raw cached values, allowing duplicates. *(proven: probe)* — `table-do.ts:576-585,1424-1443,1806-1825`
- [ ] **P1 · logic** A Drive notification arriving during sync or alarm reindex is cleared; the table is marked fresh with old data. *(proven: probe)* — `table-do.ts:867-896,1239-1246`, `control-plane-do.ts:984-998`
- [ ] **P1 · logic** Create patches the append-returned row number without verifying the row ID; manual inserts between steps can modify the wrong row. *(inference)* — `table-do.ts:589-605`
- [ ] **P1 · logic** A committed Google write with a lost response leaves an orphan skeleton row and a cache marked fresh. *(inference)* — `table-do.ts:586-600,648-654,678-685`
- [ ] **P1 · logic** A request using a new table configuration can be satisfied by an in-flight sync for the old configuration. *(inference)* — `table-do.ts:760-773,818-840`
- [ ] **P1 · performance** `startsWith` bypasses the full-scan threshold and matches case-insensitively via SQLite `LIKE`. *(proven: query plan)* — `packages/domain/src/query.ts:306-316`
- [ ] **P2 · performance** Every update and delete downloads the full managed-ID column (O(n) per point write). — `packages/google-sheets/src/service.ts:437-494`
- [ ] **P2 · logic** A persistent reindex failure retries every 30 s forever, blocks sibling tables on the same spreadsheet, and logs nothing. *(proven: probe)* — `control-plane-do.ts:972-1013`
- [ ] **P2 · logic** Header and data reads are separate requests; a column change between them caches values under wrong field names. *(inference)* — `packages/google-sheets/src/service.ts:358-424`
- [ ] **P2 · logic** `rowNumber` filters behave differently on indexed and scan paths. *(proven: probe)* — `packages/domain/src/query.ts:210-220`
- [ ] **P2 · logic** Pagination cursors skip or repeat rows when sort values change between pages. — `packages/domain/src/pagination.ts:64-71,143-148`
- [ ] **P2 · logic** `date` field rules accept impossible dates such as `2026-02-30`. *(proven)* — `packages/domain/src/constraints.ts:29-35,136-148`

## Batch 4 — Gateway performance and HTTP semantics

- [ ] **P2 · performance** 4–7 Durable Object round trips per request, mostly to the singleton control plane; no positive/negative key-verification cache; DO overload errors become generic 500s. — `apps/api/src/index.ts:417-453,596-714,913-930`
- [ ] **P3 · performance** Cache hits are parsed, Zod-validated, and re-serialized in the gateway. — `apps/api/src/index.ts:1955-1977`
- [ ] **P2 · performance** Hashed admin assets are served `no-store`. — `packages/contracts/src/admin-ui.ts`, `apps/api/src/index.ts` (`serveAdminUi`)
- [ ] **P3 · usability** Scope failures return 401 instead of 403; lowercase `bearer` rejected; malformed keys return DO validation details; 429 lacks `Retry-After`; keys without read scope can probe table existence. — `apps/api/src/index.ts:800,834-890,401-415`
- [ ] **P3 · logic** Key lifecycle: failed last-used touch returns 500; revoking twice overwrites `revokedAt`; revoking an unknown ID returns 200. — `apps/api/src/index.ts:645-659`, `control-plane-do.ts:478-484`

## Batch 5 — Admin UI

- [ ] **P1 · usability** Project-scoped admin keys cannot use the UI because its first request requires a global key. — `apps/admin/src/app.tsx:288-306`
- [ ] **P1 · logic** A slow manual refresh can show one project's tables under another selected project. *(inference)* — `apps/admin/src/app.tsx:680-695`
- [ ] **P1 · performance** Opening a project starts one cache-status request per table concurrently. — `apps/admin/src/app.tsx:597-655`
- [ ] **P2 · logic** Response shapes are not validated; malformed success bodies can blank the UI (no error boundary). — `apps/admin/src/api.ts:77-113`
- [ ] **P2 · usability** The Worker's standard JSON 401 is not classified as a rejected credential. — `apps/admin/src/api.ts:94-99`
- [ ] **P2 · logic** A committed mutation is reported as failed when only the follow-up refresh fails. — `apps/admin/src/app.tsx:728-748`
- [ ] **P2 · usability** API-key revocation has no confirmation. — `apps/admin/src/components/api-key-sections.tsx:47-55`
- [ ] **P2 · usability** New keys default to admin scopes without explaining their impact. — `apps/admin/src/admin-drafts.ts:84-88`
- [ ] **P2 · usability** Accent color fails WCAG contrast (3.3:1 and 3.5:1). — `apps/admin/src/styles.css`

## Batch 6 — Operations, documentation, and test coverage

- [ ] **P1 · usability** On Windows, `npm run e2e:local` hangs during cleanup spawning nonexistent `taskkill.cmd`. *(proven)* — `scripts/lib/process.ts:14-16,141-145`
- [ ] **P2 · docs** `contributor-staging.md` describes Pages; the staging workflow does not name missing secrets. — `contributor-staging.md`, `.github/workflows/deploy-staging.yml`
- [ ] **P2 · security** Manual Google steps leave a private key in `%TEMP%` and omit the Drive API. — `docs/google-service-accounts.md:64-73`
- [ ] **P2 · tests** Smoke never verifies that PATCH changed the row. — `scripts/smoke-run.ts:411-459`
- [ ] **P2 · tests** Load harness claims principal separation via `x-forwarded-for`, which the Worker ignores. — `scripts/load-run.ts:521-535`
- [ ] **P2 · tests** `npm run -ws` is deprecated. — `package.json:28`
- [ ] **P2 · docs** `local-admin-cutover-plan.md` is not marked superseded. — `docs/local-admin-cutover-plan.md`
- [ ] **P2 · security** GitHub Actions use mutable major tags instead of commit SHAs. — `.github/workflows/*.yml`

## Coverage gaps to close

- [ ] Real-stack auth lifecycle tests (create, authenticate, wrong secret, revoke).
- [ ] Emulated Workers Cache tests for read-after-write and purge budget.
- [ ] Sync/notification race tests and lost-write-response tests.
- [ ] Setup entry point tests across apply-secrets, deploy, bootstrap, and watch registration.
- [ ] Admin UI tests for project-scoped keys, refresh races, and large projects.
- [ ] Windows `killProcessTree` path.

## Verified correct

- Cached data never crosses principals or projects.
- Key creation cannot escalate scope; revocation is immediate.
- SQL identifiers and parameter order are injection-safe.
- Durable Object RPC inputs are validated.
- Hosted CSP and admin delivery behave as designed; no XSS sinks; browser credentials are never stored.
