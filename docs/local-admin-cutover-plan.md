# Local Admin Cutover Plan: Replace Cloudflare Pages Admin with a Loopback-Only Local Vite Admin Proxy

## Summary

Sheetflare currently ships the admin UI two ways: a local Vite dev server, and a deployed Cloudflare Pages site (`sheetflare-admin` / `sheetflare-staging-admin`) with Pages Functions that Basic-Auth-gate the site and proxy `/v1`, `/health`, `/ready`, `/doc`, `/docs` to the Worker API. This plan removes the Pages control plane entirely and makes the loopback-bound local Vite server the only admin UI runtime. The deployed Worker API (`apps/api`) remains the sole remote authorization boundary: bootstrap bearer token or scoped `sfk_` API keys, route scopes, and per-key rate limits are unchanged. No new server, dependency, or framework is added; no CORS is opened on the Worker; no credential is ever persisted. Setup/doctor/deploy become Worker-only, legacy config and local-state files migrate automatically, Pages-only code/tests/workflows/scripts are deleted, and docs are rewritten around two commands: `npm run setup` (deploy/operate the API) and `npm run dev:admin` (launch the local admin UI).

## 1. Current Architecture (verified facts)

Browser-to-API path (both today's modes):
1. React SPA (`apps/admin/src`) keeps the operator credential only in React state. `apps/admin/src/api.ts` (`requestAdminJson`, line 76-88) fetches relative same-origin paths (`/v1/admin/...`). `apps/admin/src/auth.ts` emits the private header `x-sheetflare-admin-credential` (`adminCredentialHeaderName`, `buildAdminHeaders`, `normalizeAdminCredential`). `App` in `app.tsx` deletes the legacy `sheetflare.adminCredential` key from local/session storage on mount and never persists new credentials (covered by `app.test.tsx`).
2. Local mode: `apps/admin/vite.config.ts` proxies `/v1`, `/health`, `/ready`, `/doc`, `/docs` to `process.env.SHEETFLARE_API_BASE_URL` (default `http://127.0.0.1:8787`). The `/v1` `proxyReq` hook rewrites the private header to `Authorization: Bearer <credential>` and removes the private header. No host/port/strictPort is pinned today.
3. Deployed mode (being removed): `apps/admin/functions/_middleware.ts` -> `handleAuthenticatedRequest` in `functions/_lib/security.ts` (site-wide Basic Auth from `ADMIN_UI_USERNAME`/`ADMIN_UI_PASSWORD`, CSP/nosniff/noindex/frame-denial headers). Route files `functions/v1/[[path]].ts`, `health.ts`, `ready.ts`, `doc.ts`, `docs.ts` delegate to `proxyToApi` in `functions/_lib/api-proxy.ts` (HTTPS-only `SHEETFLARE_API_BASE_URL`, allowlists `accept`/`content-type`, header-to-Bearer translation, forces `cache-control: no-store`). Env contract: `functions/_lib/env.ts` (`AdminPagesEnv`).

Worker boundary (unchanged by this plan): `apps/api/src/index.ts` authenticates `Authorization: Bearer` only (bootstrap `ADMIN_BEARER_TOKEN` or verified API key), enforces scopes/project boundaries/rate limits, and applies CORS only for origins configured in `SHEETFLARE_ALLOWED_ORIGINS` (unset in both `apps/api/wrangler.jsonc` and `wrangler.staging.jsonc`). `grep ADMIN_UI|pages apps/api` -> zero hits: the API has no coupling to Pages.

Setup control plane (Pages touchpoints to remove):
- `scripts/setup.ts`: imports `deployAdminPages`, `ensurePagesProjectExists`, `getAdminPagesProjectName` (lines 8-14), `applyAdminSecrets`, `applyAdminApiBaseUrl`, `collectAdminSiteSecrets`, `requireAdminSiteSecrets` (16-24), `verifyAdminPagesDeployment` (45). Defines `ensureAdminPagesProjectReady` (236-244) and `applyAdminPagesConfiguration` (246-273). Uses `config.deploy.admin` at 368-370 (wrangler-auth gate), 397 (`includeAdminUiSecrets`), 433-446 (apply-secrets-without-deploy Pages configuration), 461-508 (Pages ensure/secrets/deploy/live-verify inside `--deploy`). Persists `adminUrl`/`adminUiUsername`/`adminUiPassword` into local state (426-431, 512-521); reports `adminUrl` in `SetupExecutionSummary` (50-53) and next steps (668-676).
- `scripts/lib/setup-deploy.ts`: Pages-only exports `parsePagesProjectList`, `listPagesProjects`, `buildAdminDeployCommand`, `buildPagesProjectListCommand`, `buildPagesProjectCreateCommand`, `ensurePagesProjectExists`, `deployAdminPages`, `getAdminPagesProjectName`, `getAdminPagesSiteUrl`, plus `extractPagesDeploymentUrl` and `PagesProjectListEntry`. API exports `deployApiWorker`, `buildApiDeployCommand` (pinned `wrangler@4.107.0`), `patchApiConfigForDeploy`, `withPatchedJsonConfig`, `getApiWranglerConfigPath` stay.
- `scripts/lib/setup-secrets.ts`: Pages-only `AdminSiteSecrets`/`AdminSiteSecretState` (32-40), `collectAdminSiteSecrets` (119-163), `requireAdminSiteSecrets` (165-176), `applyAdminSecrets` (~430-465), `applyAdminApiBaseUrl` (~468-486), `buildAdminSecretCommands` (496-501), `buildAdminApiBaseUrlCommand` (503-505); `SetupSecrets` carries `adminUiUsername`/`adminUiPassword` (28-29) and `collectSetupSecrets` takes `includeAdminUiSecrets`. Worker secret logic (`applyApiSecrets`, Google/Drive/bootstrap collection) stays.
- `scripts/lib/setup-state.ts`: `SetupLocalState` allows `adminUrl`, `adminUiUsername`, `adminUiPassword`; `createSetupLocalStateFromUnknown` (56-77) throws on any unknown key -> removing the keys without a migration would brick every returning operator's `.sheetflare.setup.local.json` (the real file on this machine contains `adminUrl` today).
- `scripts/lib/setup-runtime.ts`: `ResolvedSetupRuntimeState` carries `adminUrl`/`adminUiUsername`/`adminUiPassword` (env fallbacks `ADMIN_UI_USERNAME`/`ADMIN_UI_PASSWORD`); `summarizeSetupSecrets`'s redacted branch exists solely to show admin site credentials.
- `scripts/lib/setup-doctor.ts`: imports Pages helpers (lines 5, 8, 22-27, 138-140); emits 'Admin Pages project' and 'Admin Pages verification' results (269-345) gated on `config.deploy.admin`; `wranglerResult` (137) exists only for that block. Google-credential, API-readiness, and Drive-watch checks stay.
- `scripts/lib/setup-verify.ts` (+ test): 100% Pages Basic-Auth live probing (`verifyAdminPagesDeployment`, `getAdminPagesVerificationUrls`). Delete whole file.
- `scripts/lib/setup-config.ts`: `SetupConfig.deploy` { api, admin } (31-34); `parseSetupConfig` requires both booleans (258-265); `createDefaultSetupConfig` writes `deploy.admin: true` (213-216). Note: `deploy.api` is parsed but never consulted anywhere (`actions.deployNow` always deploys the Worker), and `parseSetupConfig` ignores unknown top-level keys -> the whole `deploy` section can be dropped from the contract with zero config migration.
- `scripts/lib/setup-prompts.ts`: `deployAdmin` answer (16), advanced prompt 'Configure admin UI deploy now' (322-325), beginner config emits `deploy: { api: true, admin: true }` (146-148), advanced config emits `admin: answers.deployAdmin` (210-212).
- `scripts/lib/setup-cli.ts`: help lines 174-175 promise Worker+Pages behavior; `actionsRequireWranglerAuth` (211-218) has the verify-only `verifiesAdminPagesProject` branch.
- `scripts/lib/setup-next-steps.ts`: prints 'Admin URL: ...' when `adminUrl` is set (formatBeginnerSetupNextSteps).

Packaging/workflows/E2E:
- Root `package.json`: `deploy:admin:raw`, `deploy:staging:admin:raw`, and combined `deploy:raw`/`deploy:staging:raw` depend on Pages. `dev:admin`, `e2e:browser`, `e2e:local` already exercise the loopback topology.
- `apps/admin/package.json`: `dev:pages`, `deploy:raw`, `deploy:staging:raw` are Pages-only (pinned `wrangler@4.85.0`).
- `apps/admin/tsconfig.json` includes `"functions"`. `apps/admin/shared/` is an empty leftover directory.
- `.github/workflows/deploy-admin-staging.yml` is wholly Pages (uploads `ADMIN_UI_USERNAME`/`ADMIN_UI_PASSWORD` from `SHEETFLARE_STAGING_ADMIN_UI_*` secrets, `wrangler pages deploy apps/admin/dist`). `deploy-staging.yml` is Worker-only. `ci.yml` runs lint/test/typecheck/build for all workspaces.
- `scripts/local-e2e.ts` launches Wrangler API dev on `127.0.0.1:8787` and Vite on `127.0.0.1:4173` (passes `--host`/`--port` explicitly, exports `SHEETFLARE_API_BASE_URL`), then runs `npm run smoke` and `scripts/admin-browser-e2e.ts` (Playwright: credential entry, project cards, cache status text, reindex). `admin-browser-e2e.ts` defaults to `http://127.0.0.1:4173`.
- Drive ops scripts carry a Pages-flavored hint string 'not the admin Pages URL' (`register-drive-watches.ts:20`, `get-drive-watch-status.ts:21`, `get-drive-watch-retry-advice.ts:6`, `stop-drive-watches.ts:6`).
- Root `vitest.config.ts` runs only `scripts/lib/**/*.test.ts`; admin workspace tests run via workspace `vitest run --passWithNoTests` with per-file `// @vitest-environment jsdom` docblocks (default env is node).

## 2. Target Architecture and Invariants

$$\text{Browser (loopback)} \to \text{Vite dev server } 127.0.0.1{:}4173 \to \text{HTTPS Worker API}$$

- Operator browser loads the React admin app from a Vite server bound exactly to `127.0.0.1`, fixed strict port `4173` (matches today's E2E defaults and Vite's preview default).
- The SPA keeps calling relative paths with `x-sheetflare-admin-credential`; the Vite proxy rewrites it to `Authorization: Bearer` upstream. Same-origin from the browser's perspective -> the Worker's CORS configuration stays untouched (`SHEETFLARE_ALLOWED_ORIGINS` remains unset).
- Proxy target resolution (new, logged at startup): `SHEETFLARE_API_BASE_URL` env var -> `apiUrl` from repo-root `.sheetflare.setup.local.json` (written by setup on deploy) -> default `http://127.0.0.1:8787` (local Worker dev). Non-loopback targets must be `https:` (preserves the invariant the deleted Pages proxy enforced in `resolveApiBaseUrl`, because the proxy forwards the admin credential as a Bearer header).
- Deployment control plane: `npm run setup -- --apply-secrets` = Worker secrets only; `--deploy` = Worker only; `--verify`/`npm run doctor` = Worker readiness + Google credential + Drive-watch checks only. Verify-only runs neither require Wrangler authentication nor spawn `wrangler whoami`.
- Deleted layer: Pages projects, Pages Functions (Basic Auth gate + proxy), Pages secrets (`ADMIN_UI_USERNAME`, `ADMIN_UI_PASSWORD`, Pages-level `SHEETFLARE_API_BASE_URL`), Pages wrangler configs, Pages deploy scripts/workflow, Pages setup/doctor/verify code and state.

Invariants that MUST hold at every phase boundary and at the end:
1. Worker API auth, scopes, per-key rate limits, error boundaries, cache behavior (`no-store` on admin/gateway responses), and Google/Drive behavior are byte-for-byte untouched (`apps/api/**` is not edited).
2. No direct browser-to-Worker CORS: `SHEETFLARE_ALLOWED_ORIGINS` stays unset; the SPA keeps relative URLs and the private header; the Bearer header is only attached by the local proxy process.
3. Credentials remain ephemeral: React state only; no localStorage/sessionStorage/IndexedDB/URL/env-baked (`VITE_*`) credentials; the legacy-storage cleanup in `app.tsx` stays.
4. Admin server binds loopback only, fixed strict port; preserves CSP, anti-framing, nosniff, no-referrer, and noindex response headers; docs explicitly prohibit `--host 0.0.0.0`, LAN hostnames, and public tunnels.
5. No new runtime server, npm dependency, or framework. Vite (already a dependency) is the only local server.
6. Admin React features (projects/tables/keys/cache/reindex/drafts) are unchanged; `apps/admin/src/**` is not edited.
7. `npm run check` is green at the end of every phase.

## 3. Design Decisions

- D1 - Dev server, not `vite preview`: `npm run dev:admin` stays the single operator command. No build step, always-fresh sources, and it is exactly what `scripts/local-e2e.ts` already drives. `preview` gets the same host/port/strictPort pin for hygiene (Vite 7 preview inherits `server.proxy` when `preview.proxy` is absent) but is not documented as an operator path.
- D2 - Proxy target from setup local state, not a new launcher: `.sheetflare.setup.local.json` already persists `apiUrl` after `--deploy`, and `resolveSetupRuntimeState` already treats local-state-then-env as the canonical resolution pattern. Reading it from `vite.config.ts` makes `npm run dev:admin` work with zero arguments on Windows and POSIX without adding a launcher script, npm alias, or env-var choreography. The resolved target is printed at startup so behavior is observable, and `SHEETFLARE_API_BASE_URL` remains the explicit override (staging: point it at the staging Worker URL).
- D3 - Drop the whole `deploy` config section, not just `deploy.admin`: `deploy.api` is parsed but consulted nowhere; keeping a one-key object is dead flexibility. Because `parseSetupConfig` ignores unknown top-level keys, existing `sheetflare.setup.json` files that still contain `deploy` keep parsing - migration-free cutover (add a regression test proving it).
- D4 - Local-state migration is a read-time tombstone, not a shim: `createSetupLocalStateFromUnknown` gets a `removedSetupLocalStateKeys` set ('adminUrl', 'adminUiUsername', 'adminUiPassword') that is silently dropped on read; every other unknown key still throws. Dropped keys disappear from disk on the next `writeSetupLocalState` (setup already merges-and-rewrites). No deprecated runtime fields survive.
- D5 - Replace deleted Pages-proxy unit coverage by extracting the Vite proxy hooks into an importable module (`apps/admin/vite-proxy.ts`) with a node-env unit test. Today the header-to-Bearer translation is only proven indirectly by browser E2E while the doomed Pages twin has direct tests; after deletion the local proxy is the security-relevant translation point and deserves the same direct regression tests (AGENTS.md: auth fixes need cross-layer coverage).
- D6 - Keep `deploy:api:raw` / `deploy:staging:api:raw` as the only raw fallbacks; delete the admin raw scripts and the combined `deploy:raw` / `deploy:staging:raw` aliases (their only purpose was combining API+Pages).
- D7 - Time-boxed decommission: keep the two Pages projects alive for a 14-day rollback window after merge, then delete projects + GitHub Pages secrets + narrow the Cloudflare token. Rollback inside the window is `git revert` + restoration of the legacy `deploy: { api: true, admin: true }` config section if it was removed + redeploy; Pages project secrets/bindings remain intact until deletion.

## 4. Phased Implementation

Each phase ends with the repository green (`npm run check`) and lists narrow verification first. Phases 2-4 are separable for reviewability but may be folded into one commit; the internal edit order still applies.

### Phase 1 - Loopback hardening + testable proxy module (apps/admin)

Additive; independent of everything else.

1. Create `apps/admin/vite-proxy.ts` (node-side module, sibling of `vite.config.ts`):
   - `export const adminHost = '127.0.0.1'`, `export const adminPort = 4173`.
   - `export function resolveAdminApiTarget(env: string | undefined, localStateText: string | null): string` - pure resolution + validation. A trimmed, non-empty `env` wins; blank/whitespace env is absent. Otherwise parse `localStateText` as JSON and use a non-blank string `apiUrl`; missing/unreadable/invalid JSON, non-string, or blank state values fall through to `http://127.0.0.1:8787`. Once either source supplies a non-blank target, validation failures MUST throw rather than fall through: parse with `new URL(...)`; allow `https:` always and `http:` only for `127.0.0.1`, `localhost`, `::1`, or `[::1]`. The error names the offending source/value and explains that remote targets require HTTPS because the proxy forwards the admin credential as Bearer. No `as any`/`as unknown`; narrow untrusted JSON with `typeof` checks.
   - `export function rewriteAdminProxyRequest(proxyRequest: Pick<ClientRequest, 'setHeader' | 'removeHeader'>, request: Pick<IncomingMessage, 'headers'>): void` - use narrow structural contracts so tests need no unsafe casts. Always remove any inbound `authorization` and `x-sheetflare-admin-credential` from the upstream request first. If the private credential header is a non-empty string, set a fresh `Authorization: Bearer <credential>`; otherwise leave upstream authorization absent. Import `adminCredentialHeaderName` from `./src/auth` and node types from `node:http`. This deliberately tightens today's local hook, which only removes the private header on the happy path and can otherwise forward caller-supplied auth material.
   - Export an immutable `adminResponseHeaders` object used by both Vite servers. Preserve the deleted Pages middleware's security intent: CSP with `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `img-src 'self' data:`, `connect-src 'self' ws: wss:` (Vite HMR), `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and `form-action 'none'`; plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`.
2. Rewrite `apps/admin/vite.config.ts` to use the module:
   - Resolve the state path independently of the process working directory: `fileURLToPath(new URL('../../.sheetflare.setup.local.json', import.meta.url))` from `node:url`. Read it with `readFileSync(..., 'utf8')` in a try/catch that returns `null` only for file-read failures, call `resolveAdminApiTarget(process.env.SHEETFLARE_API_BASE_URL, text)`, and log one line: `[sheetflare-admin] proxying API requests to <target>`. Config loading during dev, build, preview, and tests may emit this line; that is expected.
   - `server: { host: adminHost, port: adminPort, strictPort: true, headers: adminResponseHeaders, proxy: <existing map with proxy.on('proxyReq', rewriteAdminProxyRequest)> }`.
   - `preview: { host: adminHost, port: adminPort, strictPort: true, headers: adminResponseHeaders }` (proxy inherited from `server.proxy` per Vite 7).
3. Add `apps/admin/vite-proxy.test.ts` (default node env; picked up by the workspace's configless vitest):
   - Target resolution: non-blank env wins over state; blank/whitespace env falls through; state `apiUrl` is used when env is absent; default applies when both are absent; unreadable input, invalid JSON, non-string, or blank state values fall through; malformed explicit env throws; `http://example.com` from either env or state throws; `https://example.workers.dev`, `http://localhost:8787`, `http://127.0.0.1:8787`, and loopback IPv6 pass.
   - Header rewrite: a minimal structural fake records `setHeader`/`removeHeader` without casts. With a valid credential, both inbound credential-bearing headers are removed and a fresh Bearer header is set. Missing, empty-string, or array-valued private credentials result in no upstream authorization and no leaked private header. An inbound `Authorization` value is never preserved.
   - Security-header contract: assert the exported header object denies framing, MIME sniffing, indexing, and includes the CSP directives above. This prevents the Pages deletion from silently weakening the surviving UI surface.
4. Update `apps/admin/tsconfig.json` include to add `"vite-proxy.ts", "vite-proxy.test.ts"` (keep `"functions"` until Phase 5).

Acceptance criteria:
- `npm --workspace @sheetflare/admin run test` passes with the new tests.
- `npm run dev:admin` binds `127.0.0.1:4173`, logs the resolved target, and serves the UI; a second instance fails fast (strictPort) instead of drifting ports.
- With this machine's `.sheetflare.setup.local.json` present and no env var, the logged target is the deployed Worker URL from that file.

Verification commands:
```powershell
npm --workspace @sheetflare/admin run test
npm --workspace @sheetflare/admin run typecheck
npm run dev:admin   # observe host/port/target log; Ctrl+C
```

### Phase 2 - Orchestrator/doctor/next-steps stop using Pages

Callers first; `scripts/lib` Pages exports become dead but still compile.

1. `scripts/setup.ts`:
   - Imports: from `setup-deploy` keep only `deployApiWorker`, `getApiWranglerConfigPath`; from `setup-secrets` keep `applyApiSecrets`, `collectSetupSecrets`, `hasDefaultGoogleCredentialEnvironment`; delete the `setup-verify` import.
   - Delete `ensureAdminPagesProjectReady` and `applyAdminPagesConfiguration`.
   - `SetupExecutionSummary` drops `adminUrl`; delete the `adminUrl`/`adminUiUsername`/`adminUiPassword` locals and every read of `resolvedRuntimeState.adminUrl/adminUiUsername/adminUiPassword`.
   - Wrangler-auth gates: call `checkSetupPrereqsWithOptions` with `includeWranglerAuth: options.applySecrets || options.deploy` (remove `options.verify`), then call `actionsRequireWranglerAuth(actions)` without the Pages-specific options object. Verify-only runs must not execute `wrangler whoami` or print a Wrangler-auth prerequisite row. Update the setup/prerequisite test fixture that observes this branch.
   - apply-secrets block: call `collectSetupSecrets` with `includeAdminUiSecrets: false` (temporary literal, removed with the param in Phase 4); stop assigning `adminUiUsername/adminUiPassword`; `persistLocalState` writes only `googleClientEmail`; delete the `config.deploy.admin && !actions.deployNow` Pages-configuration branch (433-446).
   - deploy block: delete the entire `if (config.deploy.admin) { ... }` branch (461-508: ensure project, collect/require site secrets, apply Pages configuration, `deployAdminPages`, `verifyAdminPagesDeployment`); `persistLocalState` writes `googleClientEmail` + `apiUrl` only.
   - `printExecutionSummary`/`summarizeSetupSecrets` call: drop `adminUrl` and pass `adminUiUsername: null, adminUiPassword: null` (temporary literals until Phase 4); verify block's `mergeSetupRuntimeState` updates drop the three admin fields; `formatBeginnerSetupNextSteps` call drops `adminUrl`.
2. `scripts/lib/setup-next-steps.ts`: `BeginnerSetupNextStepsInput` drops `adminUrl`; replace the 'Admin URL:' step with a fixed instruction line: `'<n>. Launch the admin UI any time with npm run dev:admin (loopback-only, http://127.0.0.1:4173; it targets your deployed API automatically).'`. Update `setup-next-steps.test.ts` expectations (lines 25-66) accordingly.
3. `scripts/lib/setup-doctor.ts`: delete imports from `setup-deploy` and `setup-verify` (lines 5, 8); `SetupDoctorDependencies` drops `listPagesProjects`/`verifyAdminPagesDeployment` (23-24) and the impl locals (139-140); delete the `wranglerResult` lookup (137) and the whole `if (options.config.deploy.admin)` block (269-345); remove the now-unused `prereqResults` option from `runSetupDoctor` and from the `scripts/setup.ts` call site. Remaining checks: Google credential, API readiness (/ready), Drive watch status.
4. `scripts/lib/setup-doctor.test.ts`: remove `listPagesProjects`/`verifyAdminPagesDeployment` fixture deps and all 'Admin Pages ...' assertions; drop `prereqResults` from calls; keep/extend API-readiness, Google-credential, and Drive-watch cases unchanged.

Behavior notes for this intermediate state (intentional, green): the config schema still accepts `deploy` and prompts still ask about admin deploy, but nothing reads `config.deploy` anymore; `--apply-secrets`/`--deploy`/`--verify` are already Worker-only.

Acceptance criteria:
- `npx vitest run --config vitest.config.ts` passes (doctor/next-steps suites updated; verify/deploy/secrets suites untouched and still passing against still-present exports).
- Automated tests prove verify-only mode performs no Pages call, spawns no `wrangler whoami`, prints no Wrangler-auth prerequisite, and reports only Google credential + API readiness + Drive-watch results. When a valid operator setup config and credentials are available, `npm run setup -- --verify --config <path>` confirms the same behavior live; otherwise skip this live-only check rather than creating or mutating operator configuration.
- Setup summary JSON no longer contains `adminUrl`.

Verification commands:
```powershell
npx vitest run --config vitest.config.ts
npx tsc -p tsconfig.scripts.json --noEmit
# Live-only, conditional: npm run setup -- --verify --config <existing-valid-config>
```

### Phase 3 - Setup contract cleanup (config / prompts / CLI)

1. `scripts/lib/setup-config.ts`: delete `deploy` from `SetupConfig` (31-34); delete the `input.deploy` record check and `deploy` construction in `parseSetupConfig` (258-265) and `deploy` from its return (318); delete the `deploy` block from `createDefaultSetupConfig` (213-216).
2. `scripts/lib/setup-prompts.ts`: delete `deployAdmin` from the answers type (16); delete the 'Configure admin UI deploy now' confirm (322-325) and its use (447); delete `deploy` emission from beginner (146-148) and advanced (210-212) config builders.
3. `scripts/lib/setup-cli.ts`: `actionsRequireWranglerAuth(actions)` loses the options parameter (211-218) -> `applySecretsNow || deployNow`; help text: line 174 -> '--apply-secrets    Apply Worker secrets.'; line 175 -> '--deploy           Deploy the API Worker.'.
4. Tests: `setup-config.test.ts` remove every `deploy: { api, admin }` fixture block (12 occurrences in the current tree) and any parsed-`deploy` assertion; ADD regression 'ignores a legacy deploy section' (input containing `deploy: { api: true, admin: true }` parses successfully and the result has no `deploy` property). `setup-prompts.test.ts` remove `deployAdmin` answers and `deploy` assertions and drop the corresponding prompt from scripted prompter sequences. `setup-cli.test.ts` rewrite the `actionsRequireWranglerAuth` cases: verify-only never requires Wrangler auth; apply-secrets/deploy still do.

Acceptance criteria:
- Legacy-config regression passes; a scratch starter config written by `--write-default-config` contains no `deploy` section. If an existing production or staging config is available, parsing it proves the legacy section is harmless; no such gitignored file is assumed to exist in a fresh checkout.

Verification commands:
```powershell
npx vitest run --config vitest.config.ts setup-config setup-prompts setup-cli
npx tsc -p tsconfig.scripts.json --noEmit
npm run setup -- --write-default-config --config sheetflare.setup-scratch.jsonc   # inspect: no deploy section; delete after inspection
```

### Phase 4 - Delete dead Pages library surface + local-state migration

1. `scripts/lib/setup-verify.ts` and `scripts/lib/setup-verify.test.ts`: delete both files (no importers remain after Phase 2).
2. `scripts/lib/setup-deploy.ts`: delete `PagesProjectListEntry` (12-14), `extractPagesDeploymentUrl` (74-80), `parsePagesProjectList` (97-118), `listPagesProjects` (120-135), `buildAdminDeployCommand` (141-143), `buildPagesProjectListCommand` (145-147), `buildPagesProjectCreateCommand` (149-151), `ensurePagesProjectExists` (179+), `deployAdminPages`, `getAdminPagesProjectName`, `getAdminPagesSiteUrl`. Retain everything API-side (`withPatchedJsonConfig`, `patchApiConfigForDeploy`, `buildApiDeployCommand` with the `wrangler@4.107.0` pin, `deployApiWorker`, `extractWorkersDevUrl`, `getApiWranglerConfigPath`, profile helpers).
3. `scripts/lib/setup-deploy.test.ts`: drop deleted imports (8-13) and the describes for admin deploy command (34-44), pages project list/create commands (46-66), project names (68-71), site URL (78-81), `parsePagesProjectList` (205+). Keep API deploy command, config-path, and `withPatchedJsonConfig`/`patchApiConfigForDeploy` suites.
4. `scripts/lib/setup-secrets.ts`: delete `AdminSiteSecrets`/`AdminSiteSecretState` (32-40), `collectAdminSiteSecrets` (119-163), `requireAdminSiteSecrets` (165-176), `applyAdminSecrets` (430-465), `applyAdminApiBaseUrl` (468-486), `buildAdminSecretCommands` (496-501), `buildAdminApiBaseUrlCommand` (503-505); `SetupSecrets` drops `adminUiUsername`/`adminUiPassword` (28-29); `collectSetupSecrets` drops `includeAdminUiSecrets`/`defaultAdminUiUsername`/`defaultAdminUiPassword` params and the admin-site branch (~236-259). Remove the now-obsolete temporary `includeAdminUiSecrets: false` literal from `scripts/setup.ts`.
5. `scripts/lib/setup-secrets.test.ts`: delete the admin env cleanup lines (23-24), Pages command-builder tests (37-50), `adminUi*` expectations (71-73, 94-96), and the entire admin-site-secrets suite (292-360). Keep Google credential detection, Worker secret command, and bootstrap-token suites.
6. `scripts/lib/setup-state.ts` - the local-state migration:
   - `SetupLocalState` keeps only `googleClientEmail?` and `apiUrl?`; shrink `allowedSetupLocalStateKeys` to match.
   - Add `const removedSetupLocalStateKeys = new Set(['adminUrl', 'adminUiUsername', 'adminUiPassword'])` and, in `createSetupLocalStateFromUnknown`, `continue` past those keys BEFORE the unknown-key throw (silent drop; truly unknown keys still throw). This is the entire migration: legacy files (including this machine's `.sheetflare.setup.local.json`, which contains `adminUrl` today, and any `.sheetflare.staging.setup.local.json`) read cleanly, and the keys vanish from disk on the next `writeSetupLocalState` merge-and-rewrite.
   - Delete `redactSetupLocalState` and its private `redactValue` helper. Once Pages credentials leave local state and summaries stop displaying state values, they have no production caller and must not survive as test-only dead code.
7. `scripts/lib/setup-state.test.ts`: delete the obsolete redaction-only expectations; ADD migration regressions: (a) input with all three legacy keys plus valid keys -> parses to state without legacy keys, no throw; (b) input with a genuinely unknown key still throws 'contains unknown key'.
8. `scripts/lib/setup-runtime.ts`: `ResolvedSetupRuntimeState` drops `adminUrl`/`adminUiUsername`/`adminUiPassword`; `resolveSetupRuntimeState` drops those resolutions incl. `ADMIN_UI_USERNAME`/`ADMIN_UI_PASSWORD` env fallbacks; `mergeSetupRuntimeState` drops them; `SetupSecretsSummary` drops `adminUiUsername`/`adminUiPassword` and `summarizeSetupSecrets`'s non-`showSecrets` branch returns `{ localStatePath }` only; drop the now-unused `redactSetupLocalState` import and remove the matching temporary null literals from `scripts/setup.ts`.
9. `scripts/lib/setup-runtime.test.ts`: update fixtures/expectations (27-36, 91-115, 124-170). `scripts/lib/setup-doctor.test.ts`: remove `adminUrl`/`adminUiUsername`/`adminUiPassword` from runtime-state fixtures (82-86, 240-244, 300-304, 411-415) - they become excess-property type errors once the fields are gone.

Acceptance criteria:
- `grep -ri "pages" scripts/` finds no functional code references (only the Drive-script hint strings removed in Phase 5, if run before it).
- Migration regressions pass. When an existing legacy local-state file is available, `npm run setup -- --verify --config <existing-valid-config>` reads it successfully; after a state-writing action the file no longer contains `adminUrl`. Automated fixtures remain the mandatory proof on fresh checkouts.

Verification commands:
```powershell
npx vitest run --config vitest.config.ts
npx tsc -p tsconfig.scripts.json --noEmit
npm run lint
# Live-only, conditional: npm run setup -- --verify --config <existing-valid-config>
```

### Phase 5 - Delete Pages runtime artifacts (apps/admin, packages, workflow)

1. Delete directory `apps/admin/functions/` entirely: `_middleware.ts`, `_lib/security.ts`, `_lib/security.test.ts`, `_lib/api-proxy.ts`, `_lib/api-proxy.test.ts`, `_lib/env.ts`, `v1/[[path]].ts`, `health.ts`, `ready.ts`, `doc.ts`, `docs.ts`.
2. Delete `apps/admin/wrangler.jsonc`, `apps/admin/wrangler.staging.jsonc`, and the empty `apps/admin/shared/` directory.
3. `apps/admin/tsconfig.json`: include becomes `["src", "vite.config.ts", "vite-proxy.ts", "vite-proxy.test.ts"]`.
4. `apps/admin/package.json`: delete `dev:pages`, `deploy:raw`, `deploy:staging:raw` (removes the `wrangler@4.85.0` usage from this package). Keep `dev`, `build`, `typecheck`, `test`.
5. Root `package.json`: delete `deploy:admin:raw`, `deploy:staging:admin:raw`, `deploy:raw`, `deploy:staging:raw`. Keep `deploy` (setup-driven, now Worker-only), `deploy:api:raw`, `deploy:staging:api:raw`, `dev:admin`, `e2e:browser`, `e2e:local`, `setup*`, `doctor`, `ops:*`.
6. Delete `.github/workflows/deploy-admin-staging.yml`. `deploy-staging.yml` and `ci.yml` are untouched (CI keeps building/testing the admin workspace via `npm run -ws ...`).
7. Update the four Drive ops hint strings - drop the Pages clause: `scripts/register-drive-watches.ts:20`, `scripts/get-drive-watch-status.ts:21`, `scripts/get-drive-watch-retry-advice.ts:6`, `scripts/stop-drive-watches.ts:6` -> 'Set SHEETFLARE_BASE_URL to the deployed API Worker URL.'.

Acceptance criteria:
- `npm run -ws build`, `npm run -ws typecheck`, `npm run -ws test` pass; admin workspace tests now consist of `src/*.test.*` + `vite-proxy.test.ts`.
- `glob apps/admin/functions/**` and `glob **/wrangler*.jsonc` under `apps/admin` return nothing; `grep -i "pages" package.json apps/admin/package.json .github/` returns nothing.

Verification commands:
```powershell
npm run build
npm run typecheck
npm --workspace @sheetflare/admin run test
npm run lint
```

### Phase 6 - Documentation rewrite

Anchors are current line numbers; adjust to content, not numbers.

1. `README.md`:
   - Repo map line 48: `apps/admin` -> 'React admin UI (local, loopback-only Vite server)'.
   - Commands block (60-66): `npm run deploy` comment -> 'deploy the API Worker'; keep `dev:admin`/`e2e:local`.
   - Setup flag list (75-76): `--apply-secrets` 're-apply Worker secrets'; `--deploy` 'redeploy the API Worker'.
   - CORS paragraph (119): 'The admin UI runs locally and calls the API through its same-origin loopback Vite proxy, so no CORS setup is needed for normal admin use. ...' (keep the `SHEETFLARE_ALLOWED_ORIGINS` sentence for intentional third-party origins).
   - Admin UI section (132-136): add launch guidance: run `npm run dev:admin`; it serves `http://127.0.0.1:4173` bound to loopback only; API target resolution order (env -> `.sheetflare.setup.local.json` -> local dev API); remote targets must be https; never pass `--host 0.0.0.0` or expose the port via tunnels; credentials are pasted per session and never stored.
2. `docs/quickstart.md`: outcome sentence (5) -> 'a live Cloudflare Worker API ... and a local admin UI you can launch on demand'; prerequisites (39) -> Wrangler deploys the Worker; beginner defaults (65-68) remove 'admin UI: enabled'; remove the admin-site Basic Auth warning near line 78; 'What Setup Creates' (84-88) removes the Pages bullet; the doctor text near line 103 names only Worker readiness, Google credential, and Drive-watch checks; extend 'Check The Deployment' with `npm run dev:admin`, `http://127.0.0.1:4173`, and scoped-key guidance.
3. `docs/deploy.md` (largest doc surface):
   - Intro/Setup Flow: one-command journey now deploys the API only; remove the admin-site-secrets and admin-site Basic Auth material notes (including the local-state warning near line 55); `--verify` means Worker readiness, Google credential, and Drive-watch coverage and does not need Wrangler auth.
   - GitHub Actions: Cloudflare token scopes drop 'Pages Write'; repository secrets drop `SHEETFLARE_STAGING_ADMIN_UI_USERNAME/PASSWORD`.
   - Deploy section: delete Pages authority notes, the routine-admin-deploy phrasing, the `npm run deploy:admin:raw` entry from raw fallbacks, and the complete 'Manual admin Pages fallback' block including `wrangler pages` commands and the dist-upload warning.
   - Post-Deploy Verification: delete Basic-Auth probes; replace them with the local check: launch `npm run dev:admin`, open the UI, paste a scoped key, confirm projects load.
   - Add 'Local Admin UI': command, binding/port, target resolution, HTTPS rule, loopback warning, explicit local-development override (`$env:SHEETFLARE_API_BASE_URL = 'http://127.0.0.1:8787'; npm run dev:admin`), and staging override.
   - Add 'Decommission Cloudflare Pages' and rollback instructions from Phase 8.
   - Migration notes: legacy `deploy` remains accepted and should be retained until the 14-day rollback window closes, then may be deleted; legacy admin keys in `.sheetflare*.local.json` are dropped automatically; `ADMIN_UI_USERNAME`/`ADMIN_UI_PASSWORD` are no longer read.
4. `docs/operator-runbook.md`: add 'Run The Admin UI Locally' after 'Bootstrap Setup' (command, credential-per-session UX, loopback warning, scoped-key guidance, and local Worker override). Rewrite the doctor sentence near line 35 so it mentions only Worker readiness, Google credential, and Drive-watch checks; the later admin task guidance remains.
5. `apps/admin/README.md`: rewrite 'Important Files' (drop `functions/*`; add `vite-proxy.ts`) and 'Key Insights' (loopback-only server boundary, local header-to-Bearer translation, HTTPS remote target, security headers, ephemeral credentials, unchanged UI features). Delete Pages auth-gate bullets.
6. `contributor-staging.md`: delete Pages asset rows; change local-state wording near line 46 from 'local admin-site state' to API deployment state; fix flow text to Worker secrets/API deployment only; replace the hosted admin target with the local launch command against staging; add the explicit local Worker override for contributor UI work; update the raw-workflow caveat.
7. `workers-cache-handoff.md`: remove the obsolete admin Pages resource and make the local admin command the only supported control-plane UI path.
8. `docs/workers-cache-plan.md`: keep the current Worker cache invariants unchanged; remove obsolete Pages references rather than adding historical annotations.

Acceptance criteria: repository search for `pages.dev|Pages|ADMIN_UI_|[Bb]asic[- ][Aa]uth|protected admin|admin-site|deploy:admin:raw` across `README.md`, `docs/`, `contributor-staging.md`, `workers-cache-handoff.md`, and `apps/admin/README.md` yields no obsolete hosted-admin guidance. Every documented npm command exists in the root or owning workspace `package.json`.

### Phase 7 - Full verification sweep

1. `npm run check` (lint + typecheck incl. `tsconfig.scripts.json` + all workspace tests + root vitest + build).
2. Local E2E (requires the operator smoke env used today: Google credentials for the local Worker, smoke config, Playwright installed): `npm run e2e:local` - proves API dev server + loopback Vite admin + browser flow (credential entry -> projects -> cache status -> reindex) end to end through the new pinned host/port config.
3. Manual browser QA against the deployed Worker (the new operator path):
   - `npm run dev:admin` with no env var -> log shows `apiUrl` from `.sheetflare.setup.local.json`; open `http://127.0.0.1:4173`, paste a scoped admin key, confirm projects/cache/reindex work; DevTools shows the browser sending the private credential header, never `Authorization`, and no credential in browser storage; refresh requires re-pasting. Also verify CSP, frame denial, nosniff, no-referrer, and noindex response headers.
   - Invalid credential -> UI shows the 401 flow (existing behavior).
   - Negative: `$env:SHEETFLARE_API_BASE_URL = "http://not-loopback.example.com"` -> `npm run dev:admin` fails at startup with the https-required error. Occupied port 4173 -> strictPort failure, no silent port drift.
4. Deployed-control-plane spot check, only when valid operator config/credentials are available: `npm run doctor` is green against the live Worker; `npm run setup -- --deploy --config <staging-config>` deploys only the Worker and prints no Pages steps. Automated setup tests are the required proof on a fresh checkout.

### Phase 8 - Rollout, decommission, rollback (operational; after merge)

Rollout: merge phases 1-7 as one PR (or stacked commits per phase). Nothing in the merge touches deployed Workers; the admin Pages sites simply stop receiving deploys.

Rollback window (14 days): keep `sheetflare-admin` and `sheetflare-staging-admin` Pages projects untouched. Rollback = `git revert` of the cutover; if the legacy `deploy` section was removed, restore `"deploy": { "api": true, "admin": true }` in the setup config; then run `npm run setup -- --deploy`. The reverted parser requires that section, and the existing project secrets remain available. Do not document Pages as a supported fallback elsewhere; the window is an operational safety net only.

Decommission (after the window):
```powershell
npx wrangler pages project delete sheetflare-admin
npx wrangler pages project delete sheetflare-staging-admin
```
Then delete GitHub repository secrets `SHEETFLARE_STAGING_ADMIN_UI_USERNAME` and `SHEETFLARE_STAGING_ADMIN_UI_PASSWORD`. Replace or edit the repository's `CLOUDFLARE_API_TOKEN` so it no longer has Pages Write while retaining the exact Worker permissions required by API deployment. Deleting the Pages projects deletes their project secrets; no API key or Worker secret rotation is required because Pages never stored API bearer credentials and only forwarded per-session browser input. Rotate admin keys only if incident evidence indicates abuse.

## 5. Migrations (summary)

| Artifact | Legacy shape | Cutover behavior |
| --- | --- | --- |
| `sheetflare.setup.json` / `sheetflare.staging.setup.json` | contains `deploy: { api, admin }` | `parseSetupConfig` ignores unknown top-level keys -> parses unchanged; new default configs omit `deploy`; regression test added (Phase 3) |
| `.sheetflare.setup.local.json` / `.sheetflare.staging.setup.local.json` | may contain `adminUrl`, `adminUiUsername`, `adminUiPassword` | read-time tombstone drop in `createSetupLocalStateFromUnknown`; keys removed from disk on next state write; regression test added (Phase 4) |
| `ADMIN_UI_USERNAME` / `ADMIN_UI_PASSWORD` env vars | consumed by setup/runtime | no longer read; documented in deploy.md migration notes |
| Pages projects + secrets | live | retained 14 days for rollback, then deleted (Phase 8) |
| GitHub secrets `SHEETFLARE_STAGING_ADMIN_UI_*` | referenced by deleted workflow | deleted in Phase 8 |
| Cloudflare API token | Workers Scripts Write + Pages Write | remove Pages Write after project deletion; retain only API Worker deployment permissions |

## 6. Edge Cases and Error Conditions

- Legacy local state on doctor-only runs is read but never rewritten - the tombstone keys persist on disk harmlessly until the next state-writing action; the read path must therefore stay tolerant indefinitely (it is 3 lines).
- `resolveAdminApiTarget` treats unreadable/invalid JSON state as absent. Blank env is absent. Once env or state provides a non-blank target, malformed URLs and non-HTTPS remote targets hard-fail; never silently retarget past explicit operator input.
- `scripts/local-e2e.ts` remains loopback-only. Its `SHEETFLARE_E2E_API_HOST` contract narrows to `127.0.0.1`, `localhost`, or IPv6 loopback because non-loopback HTTP targets now fail validation. The script's explicit host/port flags match config defaults and remain unchanged.
- IPv6: `localhost` may resolve to `::1`; the https-exemption allowlist must include `::1`/`[::1]` (URL.hostname reports `[::1]` with brackets for IPv6).
- The Vite proxy passes ALL request headers through by default (unlike the Pages proxy allowlist). That is unchanged from today's local behavior and acceptable on a loopback trust boundary; do not add header filtering (no new moving parts), but keep removing the private credential header before upstream.
- Windows: all documented commands must have PowerShell forms; env-var-prefixed one-liners (`FOO=bar npm run ...`) do not work in PowerShell - which is why target resolution reads local state instead of requiring env plumbing.
- `npm run deploy` (setup-driven) with `--profile staging` continues to work; the staging admin experience is env-var override of the proxy target, documented in contributor-staging.md.
- On operator machines with `.sheetflare.setup.local.json`, `npm run dev:admin` now defaults to the deployed API rather than local Wrangler. Contributors who intend local API development must use the documented PowerShell override; the startup target log is mandatory observability.
- Do not touch `.sheetflare.operator.env` (gitignored operator convenience file containing a live credential).

## 7. Explicit Non-Goals

- No changes under `apps/api/`: CORS middleware, `authenticateRequest`, scopes, rate limits, no-store cache headers, Google/Drive code, wrangler configs all stay as-is. `SHEETFLARE_ALLOWED_ORIGINS` stays unset.
- No changes under `apps/admin/src/`: `api.ts` relative fetches, `auth.ts` header contract (incl. the legacy `adminCredentialStorageKey` cleanup), `app.tsx` credential lifecycle, components, drafts, styles, and their tests are untouched.
- No new server, dependency, launcher binary, packaged artifact, Electron/Tauri wrapper, or framework.
- No credential persistence anywhere (browser, disk, env-baked bundles).
- No remote-access alternative (Cloudflare Access, tunnels) is shipped or documented as supported.
- No direct browser-to-Worker mode; no wildcard or localhost CORS.

## 8. Verification Command Reference

```powershell
# narrow, per phase (see phase sections)
npm --workspace @sheetflare/admin run test
npx vitest run --config vitest.config.ts
npx tsc -p tsconfig.scripts.json --noEmit

# final gates
npm run check          # lint + typecheck + all tests + build
npm run e2e:local      # local API + loopback admin + Playwright browser flow (needs smoke env)
npm run doctor         # Worker-only verification against the live deployment
npm run dev:admin      # manual browser QA against the deployed API (see Phase 7)
```

## 9. Critical Files for the Implementer (read before editing)

- `apps/admin/vite.config.ts`, `apps/admin/src/auth.ts`, `apps/admin/src/api.ts` (contract being preserved)
- `apps/admin/functions/_lib/api-proxy.ts` + `api-proxy.test.ts` (invariants to port into `vite-proxy.ts` tests before deletion)
- `scripts/setup.ts` (full main() flow), `scripts/lib/setup-config.ts`, `setup-state.ts`, `setup-runtime.ts`, `setup-secrets.ts`, `setup-deploy.ts`, `setup-doctor.ts`, `setup-verify.ts`, `setup-cli.ts`, `setup-prompts.ts`, `setup-next-steps.ts` and their sibling tests
- `scripts/local-e2e.ts`, `scripts/admin-browser-e2e.ts` (E2E topology that must keep passing)
- `package.json` (root), `apps/admin/package.json`, `apps/admin/tsconfig.json`, `.github/workflows/deploy-admin-staging.yml`
- `README.md`, `docs/deploy.md`, `docs/quickstart.md`, `docs/operator-runbook.md`, `apps/admin/README.md`, `contributor-staging.md`, `workers-cache-handoff.md`

## 10. Risk Summary

1. Local-state bricking (highest): `createSetupLocalStateFromUnknown` rejects unknown keys, while returning operator state may contain `adminUrl`. The Phase 4 tombstone migration and regression tests are mandatory.
2. Accidental network exposure of the credential-bearing proxy: mitigated by pinned `host: 127.0.0.1` + `strictPort`, the https-only rule for remote targets, and explicit docs prohibiting `--host 0.0.0.0`/tunnels. CLI flags can still override config - documentation is the only guard there.
3. Loss of hosted security middleware: mitigated by applying equivalent CSP, anti-framing, nosniff, no-referrer, and noindex headers through both Vite server modes and directly testing the exported header contract.
4. Coverage regression on the auth-translation hop: deleting `api-proxy.test.ts` removes the only direct test of header-to-Bearer translation; Phase 1's `vite-proxy.test.ts` must land BEFORE deletion.
5. Setup type-coupling: caller-first sequencing plus temporary literals keeps each phase type-correct.
6. Operator UX regression: no hosted URL; requires Node/repo and credential re-entry. Accepted and mitigated by zero-argument target resolution, explicit target logging, and docs.
7. Rollback debt: after 14 days and Pages deletion, rollback requires full Pages reprovisioning. The plan makes that cliff explicit.
