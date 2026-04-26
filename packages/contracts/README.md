# `@sheetflare/contracts`

Shared schemas, request/response types, RPC messages, IDs, and error contracts.

## What It Does

- Defines the public API payloads and Durable Object RPC message shapes.
- Keeps runtime validation and TypeScript types aligned through Zod.
- Centralizes application error classes and HTTP error serialization.

## Important Files

- `src/api.ts`: HTTP request and response payload schemas.
- `src/rpc.ts`: Durable Object RPC request/response unions.
- `src/auth.ts`, `src/project.ts`, `src/table.ts`: core domain contracts.
- `src/errors.ts`: stable app error model.

## Key Insights

- This package should describe contracts, not behavior.
- If a payload crosses HTTP, RPC, or persistence boundaries, define it here first.
- Keep schemas explicit and operator-readable. Loose anonymous objects make the system harder to debug.
