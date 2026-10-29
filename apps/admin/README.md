# `@sheetflare/admin`

Minimal React admin UI for operating the control plane.

## What It Does

- Runs hosted at the API Worker's `/admin/` (built by `vite build` into `dist/admin` and served from Worker static assets), or locally through the loopback Vite proxy.
- Uses a bootstrap token or scoped admin API key entered for the session; locally it can instead use `SHEETFLARE_ADMIN_CREDENTIAL` from the server environment.
- Displays the current project registry without adding another backend layer.
- Validates project, table, and API-key drafts before submit, and validates every successful Worker response against the shared contract result schemas.
- Works with global admin keys and with project-scoped admin keys (see Key Insights).
- Exposes explicit refresh controls plus cache/sync metadata for the selected project.

## Important Files

- `src/app.tsx`: orchestration and async state wiring for the admin surface.
- `src/api.ts`: admin API client; Zod-validates results, throws typed `AdminApiError` (status, code) and `AdminResponseShapeError`, and classifies auth failures.
- `src/concurrency.ts`, `src/request-generation.ts`: bounded fan-out and latest-request-wins guards used by `app.tsx`.
- `src/components/error-boundary.tsx`: app-level React error boundary wrapped around `App` in `src/main.tsx`.
- `src/admin-drafts.ts`: draft defaults plus contract-aligned client validation.
- `src/components/credential-panel.tsx`: credential source display and password-manager-compatible session entry.
- `src/components/api-key-panel.tsx`: scoped/global key creation, refresh, and revoke flows.
- `src/components/selected-project-panel.tsx`: selected-project metadata, table creation, and cache actions.
- `src/auth.ts`: admin access model, credential normalization, and admin request headers.
- `vite.config.ts`: `/admin/` build base, fixed loopback host/port, proxy routes, session endpoint, and response headers. Scripts pass `--configLoader runner` because the config imports `@sheetflare/contracts` TypeScript source.
- `vite-proxy.ts`: API target validation, server credential resolution, admin-request checks, and authorization forwarding.
- `src/styles.css`: lightweight styling. Color tokens live in `:root`; `src/styles.test.ts` fails the build if a text/background token pair drops below WCAG AA (4.5:1).
- `src/test-support.ts`: fixtures plus a fake Worker that reproduces the real admin route authorization rules.

## Key Insights

- Hosted: the Worker serves `dist/admin` only through its `/admin` route, gated by `ADMIN_UI`, with the shared header policy from `@sheetflare/contracts`. The browser calls `/v1/admin/*` on the same origin with `Authorization: Bearer`.
- Local: `npm run dev:admin` serves the UI only at `http://127.0.0.1:4173`; never expose that port through `0.0.0.0`, a LAN hostname, or a public tunnel.
- Target precedence is `SHEETFLARE_API_BASE_URL`, then repo-root `.sheetflare.setup.local.json` `apiUrl`, then `http://127.0.0.1:8787` for a local Worker. Non-loopback targets must use HTTPS.
- The browser marks admin requests with `x-sheetflare-admin-request` and sends a session credential as standard `Authorization: Bearer`. The proxy removes all authorization, then forwards that explicit caller credential. `SHEETFLARE_ADMIN_CREDENTIAL` is delegated to every local process able to reach `127.0.0.1:4173`. Use a browser-entered credential (no server credential) on shared or untrusted machines. The marker and Fetch Metadata checks only block cross-origin web pages.
- `GET /__sheetflare/admin-session` reports only whether a server credential exists: the Vite server answers from its environment, the Worker always answers `false`. The server credential never reaches the browser.
- Browser-entered credentials remain in React memory for the current session only; they are never stored in browser storage or setup state. Password managers may store them if the operator chooses.
- Both runtimes apply the same CSP, anti-framing, MIME-sniffing, referrer, indexing, and `no-store` protections; local dev adds only the HMR WebSocket origin.
- The UI is an operator convenience layer, not the source of system behavior. Update API contracts and behavior first, then align the UI.
- Project-scoped keys: only `GET /v1/admin/projects` (without `?project=`), project creation, and the spreadsheet-watch list are global-only (the Worker answers 403 `FORBIDDEN`). When the registry probe returns that, the UI asks for the project slug and loads it with `GET /v1/admin/projects?project=<slug>`; it never requests the global registry, global keys, or watches for that key. Key management for the project needs the `admin:keys` scope. A missing or invalid credential is 401.
- Auth failures are classified from the typed client error: a rejected or missing credential shows `Rejected`; a valid key lacking scope or project access shows the Worker's message with a scope hint.
- Project switching is disabled while an action runs, and manual refreshes use latest-request-wins guards, so a late response cannot overwrite the current selection. Cache-status loading is limited to 4 concurrent requests, rendered as each settles, and aborted when the project changes.
- A mutation the Worker accepted is reported as success even if the follow-up refresh fails; the returned data is applied locally and a separate warning offers `Retry refresh`.
- API-key revocation asks for confirmation naming the key and id. New keys start with `table:read` only; every scope shows what it allows and destructive scopes are flagged.
- Operator state stays explicit: project selection, cache status, sync freshness, and key scope never rely on hidden browser state.

## Commands

```powershell
npm --workspace @sheetflare/admin run dev
npm --workspace @sheetflare/admin run typecheck
npm --workspace @sheetflare/admin run test
npm --workspace @sheetflare/admin run build
```
