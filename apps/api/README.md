# `@sheetflare/api`

Cloudflare Worker entrypoint for the Sheetflare HTTP surface.

## What It Does

- Exposes the admin and data APIs under `/v1/*`.
- Owns request authentication, scope checks, rate limiting, OpenAPI generation, and HTTP error shaping.
- Forwards stateful work into Durable Objects instead of embedding table logic in routes.

## Important Files

- `src/index.ts`: route definitions, auth flow, rate-limit enforcement, docs endpoints, and request logging.
- `src/env.ts`: Worker binding shape.

## Key Insights

- API-key verification is cached per request so auth and rate limiting do not re-verify the same key twice.
- Responses include `x-request-id`; rate-limited routes also expose rate-limit headers.
- Data routes should stay thin. Query semantics, cache behavior, and Google Sheets mutation correctness belong in `@sheetflare/cloudflare`.

## Commands

```powershell
npm --workspace @sheetflare/api run dev
npm --workspace @sheetflare/api run test
```
