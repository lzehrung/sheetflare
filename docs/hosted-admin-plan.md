# Hosted Admin Plan

## Goal

Serve the admin UI from the deployed API Worker at `https://<worker>/admin/`, so operators can manage Sheetflare from any browser with an admin key and no local tooling.

The local loopback admin (`npm run dev:admin`) remains for UI development and for operators who prefer CLI-held credentials.

## Decisions

### 1. Same Worker, Workers Static Assets

Ship the built admin SPA as the API Worker's static assets. This needs no Pages project, no second Worker, no proxy, and no CORS. `npm run deploy` deploys both.

- `assets.directory`: `../admin/dist`
- `assets.binding`: `ASSETS`
- `assets.run_worker_first`: `true`

The Worker decides every request. Assets are reachable only through the Worker's `/admin` route, so stale build files or a disabled switch can never expose assets directly. One assets collection per Worker is a platform limit; the admin is the only collection.

### 2. Build layout

- Vite `base` is `/admin/` for `vite build` and `/` for `vite` dev.
- `build.outDir` is `dist/admin`, so asset paths match request paths (`/admin/index.html`, `/admin/assets/*`).
- The admin scripts use `--configLoader runner`, because `vite.config.ts` imports the TypeScript-source `@sheetflare/contracts` package.
- The app has no client-side router. No SPA fallback is configured; unknown `/admin/*` paths return 404.

### 3. Worker admin route

`GET` (and implicit `HEAD`) on `/admin` or `/admin/*`:

| `ADMIN_UI` | `ASSETS` | Result |
| --- | --- | --- |
| unset or `disabled` | any | JSON `404 NOT_FOUND`; assets never read |
| `enabled` | bound | `/admin` → `308 /admin/`; otherwise `env.ASSETS.fetch(request)` plus the shared security headers |
| `enabled` | missing | JSON `503 SERVICE_UNAVAILABLE` |
| any other value | any | JSON `503 SERVICE_UNAVAILABLE` |

- Other methods on `/admin/*` fall through to the standard 404.
- The gateway's existing `Cache-Control: no-store` applies to every admin response.
- The route never touches auth, Durable Objects, rate limiting, or Workers Cache; the default entrypoint already runs with cache disabled.
- `GET /__sheetflare/admin-session` returns `{ "serverCredential": false }`, so the UI goes straight to manual entry without a failed request.
- `/ready` reports `checks.adminUi`: `enabled`, `disabled`, `invalid`, or `assets-missing`, with a note for the last two. It does not change `ok`.

`ADMIN_UI` is declared explicitly in both Wrangler configs with value `enabled`. Setup config `adminUi: "enabled" | "disabled"` (default `enabled`) is patched into `vars` at deploy. `disabled` also removes the `assets` block, so no admin files upload. Legacy setup configs with `deploy.admin: false` map to `disabled`.

### 4. Auth

- Cloudflare Access is optional hardening, documented and not required. It needs a custom domain with an Access application on the `/admin` path; `/v1/*` stays open for API clients. Access on `workers.dev` protects the whole Worker URL, so `workers_dev` must be `false` once the custom domain serves traffic. No Access-specific code ships.
- The browser sends `Authorization: Bearer` to the same origin. No server credential exists in hosted mode.
- The credential stays in React memory. A stable HTTPS origin makes password-manager save and fill reliable.
- Cloudflare Access is optional hardening, documented and not required. Protect `/admin*` only, because API clients must keep reaching `/v1/*`. Access on a custom domain does not cover `*.workers.dev`, so either disable `workers_dev` or protect it too. No Access-specific code ships.

### 5. One security-header policy

`@sheetflare/contracts` exports `buildAdminUiHeaders({ hotReloadOrigin? })`: CSP, `Cache-Control: no-store`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`.

- Hosted: `connect-src 'self'`.
- Local dev: `connect-src 'self' ws://127.0.0.1:4173`.
- `style-src` keeps `'unsafe-inline'` for Vite dev style injection; both variants share it so the policy stays single-sourced.

### 6. Build and deploy wiring

- `apps/api` scripts `dev`, `build`, `deploy`, and `deploy:staging` build the admin first. Wrangler rejects a missing assets directory.
- `scripts/lib/setup-deploy.ts`: `deployApiWorker` builds the admin when enabled, then deploys with patched `ADMIN_UI` and `assets`.
- `.github/workflows/deploy-staging.yml` builds the admin before `wrangler deploy`, because `run_checks` can be off.

### 7. Operator narrative

- Setup prints `Admin UI is live at <apiUrl>/admin/` after deploy. Beginner next steps list the hosted URL, or `npm run dev:admin` when hosting is disabled or no API URL is known.
- `npm run doctor` adds an **Admin UI** result from `/ready`: ready when the deployed state matches setup config, warning on mismatch or an older Worker, blocked on `invalid` or `assets-missing`.
- Docs lead with the hosted URL. Local mode is documented as optional.

## Tests

- API routes with a fake `ASSETS` binding: headers on served and missing assets, redirect, `unset`/`disabled` 404 without reading assets, `invalid`/`assets-missing` 503 plus readiness notes, session response, and no asset reads for writes, root asset paths, or `/administrator`.
- Contracts: hosted policy pinned; local variant differs only by the HMR origin.
- Setup: `adminUi` parsing (default, explicit, legacy opt-out, invalid), deploy patching (assets kept or removed), next steps, and doctor states.

## Verification

1. `npm run check`.
2. `wrangler dev` with built assets, then route probes and a Playwright sign-in against `http://127.0.0.1:8787/admin/`.
3. Staging deploy: same browser run against the staging Worker.
4. Disabled switch on staging: `/admin/` returns 404, API unaffected.

## Non-goals

- Server-held credentials in hosted mode.
- Cookie sessions or a login endpoint.
- Access JWT validation code.
- Multi-instance switching. Hosted admin is per instance by construction; revisit `multi-instance-admin-plan.md` after this ships.
