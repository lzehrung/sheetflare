# `@sheetflare/google-sheets`

Service-account Google Sheets adapter for reads and mutations.

## What It Does

- Exchanges a service-account JWT for an OAuth token.
- Reads headers, whole-table values, row references, and single rows.
- Finds a row by managed ID. A lookup that trusts a row-number hint reads the row together with the rows directly above and below it in one request.
- Appends, overwrites, and deletes sheet rows through the Sheets REST API.

## Important Files

- `src/service.ts`: the full adapter, retry behavior, row parsing, and mutation calls.

## Key Insights

- Google Sheets is upstream truth; this package should not know about local cache policy.
- Read paths retry bounded transient failures. Mutation paths intentionally avoid automatic replay to reduce duplicate-write risk.
- Row identity correctness depends on the managed ID column lookup helpers here, especially after manual sheet reordering.
- `findRowById` returns the managed IDs beside the row it found. Callers use them to confirm after a by-index delete that the intended row was removed (Sheets cannot make a delete conditional on a row's ID). A hinted lookup counts an ID repeated in a neighbouring row as a duplicate; only an ID-column scan (`verifyUnique`, or a hint miss) sees a duplicate elsewhere.
