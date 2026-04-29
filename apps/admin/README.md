# `@sheetflare/admin`

Minimal React admin UI for operating the control plane.

## What It Does

- Lets an operator paste a bootstrap admin token or scoped admin API key.
- Calls the protected admin API through a same-origin proxy.
- Displays the current project registry without adding another backend layer.
- Validates project, table, and API-key drafts before submit using the shared contracts.
- Exposes explicit refresh controls plus cache/sync metadata for the selected project.
- Supports a Pages-side auth gate so the deployed UI itself is not anonymously browsable.

## Important Files

- `src/app.tsx`: orchestration and async state wiring for the admin surface.
- `src/admin-drafts.ts`: draft defaults plus contract-aligned client validation.
- `src/components/credential-panel.tsx`: credential entry and persistence opt-in.
- `src/components/api-key-panel.tsx`: scoped/global key creation, refresh, and revoke flows.
- `src/components/selected-project-panel.tsx`: selected-project metadata, table creation, and cache actions.
- `src/auth.ts`: browser-local credential normalization and storage helpers.
- `functions/_middleware.ts`: site-wide auth gate and security headers for Pages deploys.
- `functions/_lib/api-proxy.ts`: same-origin proxy from Pages routes to the configured API Worker.
- `src/styles.css`: lightweight styling.

## Key Insights

- The UI is intentionally small. It is an operator convenience layer, not the source of system behavior.
- Only scoped admin API keys are eligible for browser persistence. Bootstrap admin tokens stay session-only.
- A deployed admin site should use a site-level access gate such as Cloudflare Access or Pages-side Basic Auth plus the normal admin API credential inside the app.
- If control-plane behavior changes, update the API and contracts first, then keep this UI aligned.
- Operator state should stay explicit: project selection, cache status, sync freshness, and key scope should never rely on hidden browser state.

## Commands

```powershell
npm --workspace @sheetflare/admin run dev
npm --workspace @sheetflare/admin run typecheck
npm --workspace @sheetflare/admin run test
npm --workspace @sheetflare/admin run build
```
