# `@sheetflare/admin`

Minimal React admin UI for operating the control plane.

## What It Does

- Uses `SHEETFLARE_ADMIN_CREDENTIAL` from the local server environment, or a bootstrap token or scoped admin API key entered for the session.
- Calls the Worker admin API through the local same-origin Vite proxy.
- Displays the current project registry without adding another backend layer.
- Validates project, table, and API-key drafts before submit using the shared contracts.
- Exposes explicit refresh controls plus cache/sync metadata for the selected project.

## Important Files

- `src/app.tsx`: orchestration and async state wiring for the admin surface.
- `src/admin-drafts.ts`: draft defaults plus contract-aligned client validation.
- `src/components/credential-panel.tsx`: credential source display and password-manager-compatible session entry.
- `src/components/api-key-panel.tsx`: scoped/global key creation, refresh, and revoke flows.
- `src/components/selected-project-panel.tsx`: selected-project metadata, table creation, and cache actions.
- `src/auth.ts`: admin access model, credential normalization, and admin request headers.
- `vite.config.ts`: fixed loopback host/port, proxy routes, session endpoint, and response headers.
- `vite-proxy.ts`: API target validation, server credential resolution, admin-request checks, and authorization forwarding.
- `src/styles.css`: lightweight styling.

## Key Insights

- `npm run dev:admin` serves the UI only at `http://127.0.0.1:4173`; never expose that port through `0.0.0.0`, a LAN hostname, or a public tunnel.
- Target precedence is `SHEETFLARE_API_BASE_URL`, then repo-root `.sheetflare.setup.local.json` `apiUrl`, then `http://127.0.0.1:8787` for a local Worker. Non-loopback targets must use HTTPS.
- The browser marks admin requests with `x-sheetflare-admin-request` and sends a session credential as standard `Authorization: Bearer`. The proxy removes all authorization, then attaches the browser credential or the server credential only to marked requests from `http://127.0.0.1:4173`.
- `GET /__sheetflare/admin-session` reports only whether a server credential exists. The server credential never reaches the browser.
- Browser-entered credentials remain in React memory for the current session only; they are never stored in browser storage or setup state. Password managers may store them if the operator chooses.
- The local server applies CSP, anti-framing, MIME-sniffing, referrer, and indexing protections.
- The UI is an operator convenience layer, not the source of system behavior. Update API contracts and behavior first, then align the UI.
- Operator state stays explicit: project selection, cache status, sync freshness, and key scope never rely on hidden browser state.

## Commands

```powershell
npm --workspace @sheetflare/admin run dev
npm --workspace @sheetflare/admin run typecheck
npm --workspace @sheetflare/admin run test
npm --workspace @sheetflare/admin run build
```
