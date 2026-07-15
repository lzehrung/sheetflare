# `@sheetflare/admin`

Minimal React admin UI for operating the control plane.

## What It Does

- Lets an operator paste a bootstrap admin token or scoped admin API key.
- Calls the Worker admin API through the local same-origin Vite proxy.
- Displays the current project registry without adding another backend layer.
- Validates project, table, and API-key drafts before submit using the shared contracts.
- Exposes explicit refresh controls plus cache/sync metadata for the selected project.

## Important Files

- `src/app.tsx`: orchestration and async state wiring for the admin surface.
- `src/admin-drafts.ts`: draft defaults plus contract-aligned client validation.
- `src/components/credential-panel.tsx`: per-session credential entry.
- `src/components/api-key-panel.tsx`: scoped/global key creation, refresh, and revoke flows.
- `src/components/selected-project-panel.tsx`: selected-project metadata, table creation, and cache actions.
- `src/auth.ts`: credential normalization and private proxy-header helpers.
- `vite.config.ts`: fixed loopback host/port, proxy routes, and response headers.
- `vite-proxy.ts`: API target validation and credential-header translation.
- `src/styles.css`: lightweight styling.

## Key Insights

- `npm run dev:admin` serves the UI only at `http://127.0.0.1:4173`; never expose that port through `0.0.0.0`, a LAN hostname, or a public tunnel.
- Target precedence is `SHEETFLARE_API_BASE_URL`, then repo-root `.sheetflare.setup.local.json` `apiUrl`, then `http://127.0.0.1:8787` for a local Worker. Non-loopback targets must use HTTPS.
- The browser sends a private same-origin header. The local proxy replaces it with Worker bearer authorization and removes caller-supplied authorization before forwarding.
- Admin credentials remain in React memory for the current session only; they are never stored in browser storage or setup state.
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
