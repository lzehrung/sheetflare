# System Review — October 2026

Full-system review of `main` at `68da2a1` covering performance, security, logic, test coverage, usability, and documentation. Each item names its evidence level: **proven** (test, probe, or vendor documentation) or **inference** (code reading). Check an item only when the fix and its regression test are merged. Fixes land on branch `review-fixes`; `npm run check` passes with 871 tests (517 before).

Severity: **P1** likely wrong behavior or significant risk; **P2** real but bounded; **P3** minor.

## Batch 1 — Security and setup

- [x] **P1 · security** Project delete removes local state before revoking keys; a failed control-plane step leaves keys valid, and a re-created slug inherits them. Revoke and mark deleting first, then delete local rows. *(proven: real-stack probe)* — `project-do.ts:451-453`, `control-plane-do.ts:333-359`
- [x] **P1 · tests** Auth verification is not under real test: removing the hash comparison in `verifyApiKey` or changing what the gateway hashes leaves all tests green. Add real-stack create → authenticate → wrong secret → revoke → reject tests. *(proven: mutation runs)* — `control-plane-do.ts:458`, `apps/api/src/index.ts:432`
- [x] **P1 · usability** Default `npm run setup` redacts the generated bootstrap token and all API keys and persists none, so a first-time operator cannot sign in. Provide an explicit one-time credential handoff. *(proven)* — `scripts/lib/setup-runtime.ts:75-87`, `docs/quickstart.md:71`
- [x] **P1 · security** Rerunning `--bootstrap` mints a new set of privileged keys each time without revoking old ones. *(proven: code)* — `scripts/bootstrap-run.ts:77-90`
- [x] **P1 · logic** `--apply-secrets` regenerates the Drive webhook secret without re-registering watches; notifications then fail with 401. *(proven: code)* — `scripts/lib/setup-secrets.ts:158-165`, `scripts/setup.ts:456-460`
- [x] **P1 · security** `/ready` is unauthenticated and unthrottled, scans the registry and writes a rate-limit row per call, and discloses secret configuration state. *(proven: probe)* — `apps/api/src/index.ts:2252-2308`
- [x] **P2 · security** Upstream Google error text, transport errors, and credential-parser snippets reach public error bodies. *(proven: probe)* — `packages/google-sheets/src/service.ts:933-1000`, `packages/cloudflare/src/google-credentials.ts:42-47`, `packages/cloudflare/src/rpc.ts:38-59`
- [x] **P2 · security** Anonymous callers create never-deleted Durable Objects (ProjectDO per slug, RateLimitDO per IPv6 address); expired rate-limit rows have no cleanup alarm. *(fixed: lazy schema creation, cleanup alarm; IPv6 /64 bucketing tracked below)* *(proven: probe)* — `apps/api/src/index.ts:465-468,913-930`, `rate-limit-do.ts:126-136`
- [x] **P2 · logic** Project delete and watch cleanup return 5xx indefinitely when Google fails or two projects share a spreadsheet with different credential refs. *(proven: probe)* — `control-plane-do.ts:354-357,702-735,813-824`
- [x] **P2 · security** Local admin proxy grants the server credential to marked requests without `Sec-Fetch-Site`. *(proven: test)* — `apps/admin/vite-proxy.ts:99-142`
- [x] **P3 · security** Bootstrap and webhook secrets use `===`; the webhook route has no failure throttle; no minimum secret strength. *(fixed: constant-time compare, webhook failure throttle; strength warning tracked below)* — `apps/api/src/index.ts:588,810,2680`

## Batch 2 — Cache freshness

- [x] **P1 · logic** Edge freshness depends on one `purge()` per change, but Workers Cache purge always uses Free-tier limits (5/min, burst 25). Key cached reads by a per-table data generation so committed changes never depend on purge; keep purge as best-effort cleanup, batched per request. *(proven: Cloudflare docs)* — `apps/api/src/index.ts:1004-1035,2079-2091`
- [x] **P2 · logic** A read in flight during a write can store pre-write data for a full TTL; edge TTL ignores elapsed freshness (up to 2× TTL); `cacheTtlSeconds` is unbounded. *(proven: emulator probe)* — `apps/api/src/index.ts:1781-1839`, `packages/contracts/src/api.ts:29`
- [x] **P2 · tests** An API test feeds a cache state the real TableDO cannot produce (`stale:false` with pending external change); the debounce-capped TTL branch is unreachable. *(proven)* — `apps/api/test/index.test.ts:1242-1264`, `apps/api/src/index.ts:1768-1791`
- [x] **P2 · docs** Observability lists no cache-invalidation or reindex-failure alerts; Wrangler configs do not enable Workers Logs. — `docs/observability.md`, `apps/api/wrangler*.jsonc`

## Batch 3 — Data-plane correctness

- [x] **P1 · logic** Unique fields with `trim`/`lowercase` compare normalized candidates with raw cached values, allowing duplicates. *(proven: probe)* — `table-do.ts:576-585,1424-1443,1806-1825`
- [x] **P1 · logic** A Drive notification arriving during sync or alarm reindex is cleared; the table is marked fresh with old data. *(proven: probe)* — `table-do.ts:867-896,1239-1246`, `control-plane-do.ts:984-998`
- [x] **P1 · logic** Create patches the append-returned row number without verifying the row ID; manual inserts between steps can modify the wrong row. *(inference)* — `table-do.ts:589-605`
- [x] **P1 · logic** A committed Google write with a lost response leaves an orphan skeleton row and a cache marked fresh. *(inference)* — `table-do.ts:586-600,648-654,678-685`
- [x] **P1 · logic** A request using a new table configuration can be satisfied by an in-flight sync for the old configuration. *(inference)* — `table-do.ts:760-773,818-840`
- [x] **P1 · performance** `startsWith` bypasses the full-scan threshold and matches case-insensitively via SQLite `LIKE`. *(proven: query plan)* — `packages/domain/src/query.ts:306-316`
- [x] **P2 · performance** Every update and delete downloads the full managed-ID column (O(n) per point write). — `packages/google-sheets/src/service.ts:437-494`
- [x] **P2 · logic** A persistent reindex failure retries every 30 s forever, blocks sibling tables on the same spreadsheet, and logs nothing. *(proven: probe)* — `control-plane-do.ts:972-1013`
- [x] **P2 · logic** Header and data reads are separate requests; a column change between them caches values under wrong field names. *(inference)* — `packages/google-sheets/src/service.ts:358-424`
- [x] **P2 · logic** `rowNumber` filters behave differently on indexed and scan paths. *(proven: probe)* — `packages/domain/src/query.ts:210-220`
- [x] **P2 · logic** Pagination cursors skip or repeat rows when sort values change between pages. — `packages/domain/src/pagination.ts:64-71,143-148`
- [x] **P2 · logic** `date` field rules accept impossible dates such as `2026-02-30`. *(proven)* — `packages/domain/src/constraints.ts:29-35,136-148`

## Batch 4 — Gateway performance and HTTP semantics

- [x] **P2 · performance** 4–7 Durable Object round trips per request, mostly to the singleton control plane; no positive/negative key-verification cache; DO overload errors become generic 500s. — `apps/api/src/index.ts:417-453,596-714,913-930`
- [x] **P3 · performance** Cache hits are parsed, Zod-validated, and re-serialized in the gateway. — `apps/api/src/index.ts:1955-1977`
- [x] **P2 · performance** Hashed admin assets are served `no-store`. — `packages/contracts/src/admin-ui.ts`, `apps/api/src/index.ts` (`serveAdminUi`)
- [x] **P3 · usability** Scope failures return 401 instead of 403; lowercase `bearer` rejected; malformed keys return DO validation details; 429 lacks `Retry-After`; keys without read scope can probe table existence. — `apps/api/src/index.ts:800,834-890,401-415`
- [x] **P3 · logic** Key lifecycle: failed last-used touch returns 500; revoking twice overwrites `revokedAt`; revoking an unknown ID returns 200. — `apps/api/src/index.ts:645-659`, `control-plane-do.ts:478-484`

## Batch 5 — Admin UI

- [x] **P1 · usability** Project-scoped admin keys cannot use the UI because its first request requires a global key. — `apps/admin/src/app.tsx:288-306`
- [x] **P1 · logic** A slow manual refresh can show one project's tables under another selected project. *(inference)* — `apps/admin/src/app.tsx:680-695`
- [x] **P1 · performance** Opening a project starts one cache-status request per table concurrently. — `apps/admin/src/app.tsx:597-655`
- [x] **P2 · logic** Response shapes are not validated; malformed success bodies can blank the UI (no error boundary). — `apps/admin/src/api.ts:77-113`
- [x] **P2 · usability** The Worker's standard JSON 401 is not classified as a rejected credential. — `apps/admin/src/api.ts:94-99`
- [x] **P2 · logic** A committed mutation is reported as failed when only the follow-up refresh fails. — `apps/admin/src/app.tsx:728-748`
- [x] **P2 · usability** API-key revocation has no confirmation. — `apps/admin/src/components/api-key-sections.tsx:47-55`
- [x] **P2 · usability** New keys default to admin scopes without explaining their impact. — `apps/admin/src/admin-drafts.ts:84-88`
- [x] **P2 · usability** Accent color fails WCAG contrast (3.3:1 and 3.5:1). — `apps/admin/src/styles.css`

## Batch 6 — Operations, documentation, and test coverage

- [x] **P1 · usability** On Windows, `npm run e2e:local` hangs during cleanup spawning nonexistent `taskkill.cmd`. *(proven)* — `scripts/lib/process.ts:14-16,141-145`
- [x] **P2 · docs** `contributor-staging.md` describes Pages; the staging workflow does not name missing secrets. — `contributor-staging.md`, `.github/workflows/deploy-staging.yml`
- [x] **P2 · security** Manual Google steps leave a private key in `%TEMP%` and omit the Drive API. — `docs/google-service-accounts.md:64-73`
- [x] **P2 · tests** Smoke never verifies that PATCH changed the row. — `scripts/smoke-run.ts:411-459`
- [x] **P2 · tests** Load harness claims principal separation via `x-forwarded-for`, which the Worker ignores. — `scripts/load-run.ts:521-535`
- [x] **P2 · tests** `npm run -ws` is deprecated. — `package.json:28`
- [x] **P2 · docs** `local-admin-cutover-plan.md` is not marked superseded. — `docs/local-admin-cutover-plan.md`
- [x] **P2 · security** GitHub Actions use mutable major tags instead of commit SHAs. — `.github/workflows/*.yml`

## Coverage gaps to close

- [x] Real-stack auth lifecycle tests (create, authenticate, wrong secret, revoke).
- [x] Emulated Workers Cache tests for read-after-write and purge budget.
- [x] Sync/notification race tests and lost-write-response tests.
- [x] Setup entry point tests across apply-secrets, deploy, bootstrap, and watch registration. *(`runSetup(options, deps)` with fakes only at process, HTTP, and prompt boundaries)*
- [x] Admin UI tests for project-scoped keys, refresh races, and large projects.
- [x] Windows `killProcessTree` path.

## Found during fixes

- [x] **P1 · security** After a project delete, the deleting isolate kept honoring the project's keys from its principal cache; a re-created slug served data to the old key. *(proven: real-stack test; fixed)*
- [x] **P2 · logic** Concurrent project creates could both pass the shared-spreadsheet credential-ref check; the pairing is now reserved atomically in the control plane, with release on failure and a 5-minute expiry. *(Copilot review; proven: interleaved real-DO test)*
- [x] **P2 · logic** A bootstrap failure after some keys were minted lost those keys' secrets; bootstrap now emits partial results and setup hands them off. *(Copilot review)*
- [x] **P2 · logic** Key rotation revoked the authenticating admin key before the others, so later revocations failed with 401; it is now revoked last. *(Copilot review)*
- [x] **P2 · logic** An inherited `SHEETFLARE_BOOTSTRAP_ROTATE_KEYS=true` could rotate keys without `--rotate-keys`; setup now sets the child flag explicitly. *(Copilot review)*
- [x] **P2 · tests** Smoke read-back compared raw configured values, failing on normalized fields and arrays; it now applies the table's field rules and Sheets serialization. *(Copilot review)*
- [x] **P2 · logic** ProjectDO lifecycle operations interleaved while awaiting the control plane: a losing same-slug create could revoke the winner's new keys, an unregistered write could outlive its reservation, and a table request could restore a deleted project's registry entry. Create and delete now run through a per-project queue, and an unregistered write is taken back. *(Copilot review; proven: interleaved real-DO tests)*
- [x] **P3 · logic** RateLimitDO windows persisted before the cleanup alarm existed never scheduled cleanup. *(Copilot review)*
- [x] **P2 · logic** `--apply-secrets` kept using the superseded bootstrap token from `SHEETFLARE_ADMIN_CREDENTIAL` for watch registration, smoke, and verify. *(Copilot review)*
- [x] **P3 · docs** The local admin server credential is delegated to every local process that can reach `127.0.0.1:4173`; Fetch Metadata only blocks cross-origin pages. Documented as the trust boundary. *(Copilot review)*
- [x] **P2 · tests** `apps/api/tsconfig.json` type-checks only `src`, so test files are never type-checked (`test/support/harness.ts` already carries a hidden type error). *(fixed: `tsconfig.test.json`; 23 errors fixed; gate proven)*
- [x] **P2 · logic** A sync in flight while a write commits can promote the older snapshot, briefly serving pre-write data. *(fixed: a sync whose snapshot a write overlapped keeps the live rows and stays stale, so in-flight unique checks keep earlier writes; late reads cannot join an older sync)*
- [x] **P2 · logic** `id` filters have the same numeric-operand mismatch between indexed and scan paths that `rowNumber` had. *(fixed: operands canonicalized to ID strings)*
- [x] **P2 · security** Rate-limit principals use the full IPv6 address; bucket by /64.
- [x] **P3 · logic** A missing default Google credential returns 400 instead of a 5xx configuration error.
- [x] **P3 · logic** Deployments with existing projects sharing a spreadsheet under different credential refs still fail watch registration until an operator aligns the refs (new conflicts are rejected at create). *(fixed: only the conflicting spreadsheet is skipped, with an explicit `lastWatchError`)*
- [x] **P3 · logic** After delete, row identity is verified only at rows R−1..R+1; larger concurrent shifts are not detected. *(fixed: neighbour-closure check detects shifts of any size; row writes serialized per table; accepted trade-off: Sheets has no conditional delete, so a wrong-row delete is detected after the fact, fails closed with 409, and marks the cache stale)*
- [x] **P3 · logic** Point writes against a fresh cache no longer detect an ID duplicated upstream within the TTL; the next sync rejects it. *(fixed for adjacent duplicates; accepted trade-off: duplicates farther than one row are caught by the next sync, documented in README)*
- [x] **P3 · usability** A valid key scoped to another project gets 403 on a public-read project that anonymous callers can read. *(fixed: reads allowed; writes and private projects keep 403)*
- [x] **P3 · security** No warning for bootstrap or webhook secrets shorter than 32 characters. *(fixed: admin-only `/ready` note)*
- [x] **P2 · security** A key scoped to another project could tell existing private tables (403) from missing ones (404) after public-read reads were allowed; cross-project not-found now returns the same 403. *(Copilot review on #20)*
- [x] **P3 · logic** Credential-conflict placeholder rows were treated as active Drive watches by retry advice, notifications, and cleanup. *(Copilot review on #20)*
- [x] **P3 · logic** Duplicate configured bootstrap key names could revoke the authenticating key twice during rotation; names are now unique and revocations deduplicated. *(Copilot review on #19)*
- [x] **P2 · logic** A delete verifying after a sync promoted the post-delete snapshot shifted cached row numbers a second time and marked the corrupted cache fresh. A content revision that moved during the delete now means rebuild instead of shift. *(Copilot review on #20; proven: gated real-TableDO test)*
- [x] **P2 · logic** Setup subprocesses inherited the host `process.env` instead of the injected setup environment, so an injected `CLOUDFLARE_API_TOKEN` was ignored. *(Copilot review on #20)*
- [x] **P2 · logic** `--apply-secrets` and webhook rotation: Drive watches are re-registered even when a later step fails, and an operator-selected `sfk_` API key is never replaced by the bootstrap token. *(Copilot review on #19)*
- [ ] **P2 · tests** `packages/cloudflare/test` is not type-checked (its `tsconfig.json` includes only `src`), and existing test files already carry type errors.
- [x] **P2 · logic** A delete whose rebuild path ran (revision moved, expired cache, or layout change) left lowered row numbers inconsistent while the cache reported fresh; it now marks an undebounced external change before releasing the write queue, so reads and the next write join one rebuild. *(Copilot review on #20; proven: gated real-DO tests)*
- [x] **P2 · logic** Lists, point reads and unique-field writes that waited on a sync a write superseded were answered from the unverified cache; they now sync again until a sync is promoted, and a failed rebuild fails every waiter. *(Copilot review on #20; proven: gated real-DO tests)*
- [x] **P2 · logic** A row lookup in flight across a delete could write its pre-delete row number back into the rebuilt cache; `lookupRowById` now skips the repair when the content revision moved or a resync is pending. *(Copilot review on #20; proven: gated real-DO tests)*
- [x] **P3 · usability** Setup counted credential-conflict watch placeholders as registered watches; it now counts only watches without `lastWatchError` and warns per skipped spreadsheet. *(Copilot review on #20)*
- [x] **P3 · security** Add Dependabot or Renovate to keep SHA-pinned GitHub Actions current. *(fixed: `.github/dependabot.yml`)*
- [ ] **Validation** Verify generation-keyed caching, `cf.cacheKey` format, and purge behavior against real Workers Cache in staging (blocked: GitHub staging secrets unset, Wrangler login expired).

## Verified correct

- Cached data never crosses principals or projects.
- Key creation cannot escalate scope. Revocation is immediate on the isolate that revokes or deletes; other isolates may honor a revoked key for up to 10 seconds (per-isolate verified-principal cache).
- SQL identifiers and parameter order are injection-safe.
- Durable Object RPC inputs are validated.
- Hosted CSP and admin delivery behave as designed; no XSS sinks; browser credentials are never stored.
