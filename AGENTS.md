# AGENTS

## Purpose

This repository is a self-hosted Sheetflare gateway: a Cloudflare-first system that exposes Google Sheets tabs through a stable API with durable local caching, explicit auth, and predictable query semantics.

The standard here is not "works eventually." The standard is:

- idiomatic
- minimal
- elegant
- observable
- performant
- secure
- easy to configure
- easy to operate
- easy for users to understand

## Core Implementation Principles

### Prefer simple architecture with strong boundaries

Keep these boundaries sharp:

- control plane vs data plane
- contracts vs runtime implementation
- pure domain/query logic vs storage/orchestration logic
- Google Sheets adapter vs cached local table state

Do not collapse layers just to save a file or two if it makes behavior harder to reason about.

### Minimize moving parts

Choose the smallest design that preserves:

- correctness
- debuggability
- future extension

Avoid premature frameworking, generic abstraction, or clever helper stacks.

### Optimize for operator and user comprehension

A self-host operator should be able to answer:

- what is cached?
- what is authoritative?
- when does sync happen?
- why did this request fail?
- how do I add a new table or indexed field?

If the implementation obscures those answers, it is too complicated.

## TypeScript Rules

### Cast discipline

Never use:

- `as any`
- `as unknown`

Do not introduce them even as a temporary escape hatch.

If types are difficult:

- improve the type model
- add a narrow helper type
- validate at boundaries
- refactor the code so the type flow is explicit

Unsafe casting is treated as a design failure, not a convenience.

### Prefer explicit contracts

Request/response objects, RPC payloads, cache metadata, and query structures should have explicit types and schemas.

Do not hide important contracts in loose objects or inferred ad hoc shapes when the structure matters operationally.

### Keep runtime validation aligned with types

If data crosses a trust boundary, validate it.

Trust boundaries include:

- HTTP requests
- Durable Object RPC
- persisted metadata
- Google Sheets payloads when assumptions matter

## Cloudflare / Data-Plane Rules

### Durable Objects own local truth

For runtime performance, `TableDO` should treat its SQLite cache as the normal query surface.

For correctness, Google Sheets remains upstream truth and mutations must remain safe under direct sheet edits.

### Cache behavior must be explicit

Any cache or sync mechanism must make these questions answerable:

- cold vs warm behavior
- freshness policy
- invalidation path
- sync status
- failure state

Do not add hidden background behavior that is difficult to observe.

### Large-sheet behavior matters

Assume some users will have very large sheets.

Avoid implementations that require:

- full in-memory scans on common reads
- unbounded sort/filter work on large caches
- hidden O(n) behavior in the hot path

If a query shape is expensive, reject it clearly instead of silently degrading.

## API and UX Rules

### Make constraints explicit

Do not silently accept unsupported or dangerous behavior.

Prefer clear errors like:

- field is not indexed
- query requires a full scan beyond threshold
- duplicate managed row id detected
- table configuration is incomplete

### Stable behavior beats magical behavior

Avoid implicit auto-discovery that makes operator intent unclear.

Examples:

- a new tab should be explicitly configured as a table
- indexed fields should be explicitly declared
- auth mode should be explicit

### User-facing changes should feel coherent

When adding a feature, think through:

- docs
- errors
- operability
- migration path
- test coverage

Do not ship implementation-only changes that leave the UX half-specified.

## Testing Rules

### Tests must exercise real business logic

Tests should validate the real logic of:

- query semantics
- auth rules
- sync behavior
- cache state transitions
- row identity and mutation correctness

### Avoid mock-heavy fake confidence

Do not write tests that only prove a mocked collaborator returned what the test told it to return.

Mocks/stubs are acceptable only at true external boundaries, such as:

- HTTP request harnesses
- Google Sheets API transport
- Cloudflare binding surfaces

Even there, the test should still exercise the real repository logic, not a hollow shell around mocks.

### Prefer narrow unit tests plus meaningful integration behavior

Good tests in this repo:

- cover pure domain/query helpers directly
- cover API authorization behavior through the actual route layer
- cover DO behavior through real state transitions where feasible

Bad tests in this repo:

- assert implementation trivia
- snapshot arbitrary large payloads without intent
- mock away the logic we actually care about

## Code Review Expectations

When reviewing changes, prioritize:

1. correctness under real sheet mutation
2. auth and authorization safety
3. large-table query behavior
4. sync/cache observability
5. simplicity of the resulting operator experience

If a change adds complexity, it must earn that complexity with concrete correctness, scale, or usability benefits.

## Documentation Expectations

Keep docs practical.

Prefer:

- how to configure
- how to operate
- what constraints exist
- what happens on failure
- how to extend safely

Avoid abstract product language or vague architecture prose that does not help an operator or contributor act.
