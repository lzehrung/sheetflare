# `@sheetflare/cloudflare`

Durable Object implementations and Cloudflare-specific runtime glue.

## What It Does

- Implements the control plane, project registry, table cache, and rate limiter.
- Treats Durable Object SQLite as the local query surface for table reads.
- Bridges the route layer to Google Sheets through RPC and cached table state.

## Important Files

- `src/do/table-do.ts`: cache lifecycle, sync orchestration, query execution, and row mutations.
- `src/do/project-do.ts`: project and table configuration storage.
- `src/do/control-plane-do.ts`: project registry and API-key records.
- `src/do/rate-limit-do.ts`: fixed-window request budgets.
- `src/google-credentials.ts`: gateway and named credential resolution.
- `src/rpc.ts`: Durable Object RPC helper.

## Key Insights

- This package owns the real runtime complexity of the system.
- `TableDO` should query SQLite for normal reads and use narrow upstream row-ID repairs for point operations when possible.
- Full sync must fail loudly on duplicate managed IDs; silent cache collapse is a correctness bug.
- Cache behavior should remain explicit: freshness, sync failure, and config-driven invalidation all need to stay observable.
