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

- API-key verification is cached per isolate for up to 10 seconds, positive and negative, so auth and rate limiting do not re-verify the same key twice. A revoked key can therefore keep working for up to 10 seconds on other isolates.
- Missing or invalid credentials return `401`. A valid key that lacks the required scope returns `403` with `FORBIDDEN`.
- Responses include `x-request-id`; rate-limited routes also expose rate-limit headers.
- Admin project and table POST routes create by default; replacing an existing config requires `?upsert=true` and returns `200` when an existing config was intentionally replaced.
- Data routes should stay thin. Query semantics, cache behavior, and Google Sheets mutation correctness belong in `@sheetflare/cloudflare`.

## Commands

```powershell
npm --workspace @sheetflare/api run dev
npm --workspace @sheetflare/api run test
npm --workspace @sheetflare/api run typecheck   # src (tsconfig.json), then src and test (tsconfig.test.json)
```
