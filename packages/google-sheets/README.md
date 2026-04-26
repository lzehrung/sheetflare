# `@sheetflare/google-sheets`

Service-account Google Sheets adapter for reads and mutations.

## What It Does

- Exchanges a service-account JWT for an OAuth token.
- Reads headers, whole-table values, row references, and single rows.
- Appends, overwrites, and deletes sheet rows through the Sheets REST API.

## Important Files

- `src/service.ts`: the full adapter, retry behavior, row parsing, and mutation calls.

## Key Insights

- Google Sheets is upstream truth; this package should not know about local cache policy.
- Read paths retry bounded transient failures. Mutation paths intentionally avoid automatic replay to reduce duplicate-write risk.
- Row identity correctness depends on the managed ID column lookup helpers here, especially after manual sheet reordering.
