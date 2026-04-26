# `@sheetflare/admin`

Minimal React admin UI for browsing the control plane.

## What It Does

- Lets an operator paste a bootstrap admin token or scoped admin API key.
- Calls the protected admin API directly from the browser.
- Displays the current project registry without adding another backend layer.

## Important Files

- `src/app.tsx`: credential flow and project list UI.
- `src/auth.ts`: browser-local credential normalization and storage helpers.
- `src/styles.css`: lightweight styling.

## Key Insights

- The UI is intentionally small. It is an operator convenience layer, not the source of system behavior.
- Credentials are stored in browser local storage, so this app assumes a trusted operator environment.
- If control-plane behavior changes, update the API and contracts first, then keep this UI aligned.

## Commands

```powershell
npm --workspace @sheetflare/admin run dev
npm --workspace @sheetflare/admin run test
```
