# `@sheetflare/domain`

Pure query, pagination, row-normalization, and schema-inference logic.

## What It Does

- Normalizes list queries and pagination cursors.
- Builds indexed query plans and scan fallbacks.
- Provides row helpers used by the write path.
- Infers a lightweight schema view from cached headers and sample rows.

## Important Files

- `src/query.ts`: indexed filter planning and value comparison rules.
- `src/pagination.ts`: sort parsing, cursor encoding, and fingerprinting.
- `src/rows.ts`: key normalization and header filtering.
- `src/schema.ts`: inferred schema output.

## Key Insights

- This package should stay side-effect free and easy to test directly.
- Sort and comparison behavior here must match the SQLite-backed query behavior in `@sheetflare/cloudflare`.
- If a rule is hard to prove with a narrow unit test, it probably does not belong in this package yet.
