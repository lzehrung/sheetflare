# Contributing

## Workflow

1. Open an issue or draft proposal for behavior changes, public API changes, or operator-surface changes.
2. Keep changes narrow and explain the operational impact.
3. Update docs, tests, and examples when behavior changes.

## Local Checks

Run from repo root before opening a pull request:

```powershell
npm run lint
npm test
npm run typecheck
npm run build
```

## Repo Standards

- Keep contracts explicit.
- Do not add hidden background behavior.
- Prefer simple boundaries over generic abstraction.
- Add regression tests for bug fixes.
- Keep operator docs practical and current.

Read [AGENTS.md](./AGENTS.md) before making substantial changes.

## Pull Requests

Include:

- what changed
- why it changed
- test coverage added or updated
- operator or migration impact, if any

If a change affects deploy or runtime behavior, update the relevant docs in `docs/`.
