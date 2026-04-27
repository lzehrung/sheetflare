# Admin Editor Review

Scope reviewed on 2026-04-27:

- `apps/admin` only
- The practical "editor" in this repo is the admin configuration surface for projects, tables, and API keys

## What Was Wrong

1. State correctness
   - Cache status was keyed only by `tableSlug`, so switching projects with the same table slug could render the wrong cache state.
   - Revealed key output and selection state were not fully reconciled when the operator changed project context.

2. Operator UX
   - Form inputs were weakly validated on the client, so common mistakes only failed after a network round trip.
   - The UI exposed too little project/cache metadata for an operator trying to answer "what is cached?" and "when did it sync?"
   - There was no explicit refresh path for the project registry or key lists.

3. Code structure
   - `apps/admin/src/app.tsx` had grown into a monolithic state-and-render file, which made the behavior harder to review, test, and extend safely.

4. Accessibility and interaction polish
   - Project cards used custom button semantics instead of real buttons.
   - Success/error notices were not isolated into a dedicated status component.

5. Test coverage
   - The existing tests covered the happy path and revoke flow, but not project-context leakage, refresh/reselection behavior, or validation behavior.

## What Was Changed

### Commit `dc9ba96` - `Fix admin project state leakage`

- Scoped cache state by `projectSlug + tableSlug`
- Reconciled project selection against the actual refreshed registry
- Cleared revealed key output on project changes
- Added regression tests for overlapping table slugs and project-switch key leakage

### Commit `2e19d2d` - `Refactor admin panels and validation`

- Added contract-aligned draft validation in `apps/admin/src/admin-drafts.ts`
- Split the admin UI into focused panels/components:
  - credential panel
  - project form
  - API-key panel
  - selected-project panel
  - notice banner
  - cache status summary
- Added explicit refresh controls for:
  - project registry
  - selected project
  - scoped keys
  - global keys
- Surfaced selected-project metadata and richer cache/sync status
- Switched project cards to real buttons
- Added validation/unit/integration coverage for the new flows

## Tiptap / Plugin Note

- No Tiptap editor or rich-text plugin surface exists in this repo right now.
- Tiptap plugin recommendations are therefore not actionable for `sheetflare` at this time.
- If a real editor workspace is added later, it should be reviewed as a separate package/runtime boundary, not mixed into the current admin control plane.

## Final State

- High-priority correctness and operator-UX issues in `apps/admin` are addressed in code and tests.
- The remaining meaningful verification gap is browser/e2e execution against a live configured environment, which depends on local/staging credentials and was not assumed during this pass.
