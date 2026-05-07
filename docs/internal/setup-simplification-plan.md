# Setup Simplification Implementation Plan

> **Implementation note:** Work through this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default Sheetflare setup path easy for a nontechnical operator who wants one Google Sheet tab exposed as an API, while preserving every advanced customization through explicit config and advanced flags.

**Architecture:** Keep the existing `sheetflare.setup.json` contract as the source of customization. Add a beginner-focused prompt mode that derives safe defaults, then layer optional advanced configuration and rerun commands on top of the same validated config, deployment, bootstrap, smoke, and doctor implementation.

**Tech Stack:** TypeScript setup scripts, Zod-backed setup config validation, Vitest regression tests, Markdown operator docs.

---

## Current Friction

The current setup flow is powerful but asks a first-time operator to make decisions they usually do not care about:

- profile name
- whether to deploy the admin UI
- private project slug and name
- table slug
- existing tab name
- managed ID column
- indexed fields
- cache TTL
- smoke field and smoke values
- public-read project setup
- whether to apply secrets, deploy, bootstrap, and smoke-test

This is too much for the target user. A novice should be able to start with:

1. install dependencies
2. log in to Cloudflare and optionally Google Cloud
3. run one setup command
4. paste a Google Sheet URL
5. enter the tab name
6. enter one writable column for smoke validation
7. follow one clear instruction to share the sheet with the service account

Advanced operators still need full control over names, projects, indexed fields, cache TTLs, public-read coverage, custom credentials, and separated deploy/bootstrap/smoke stages. The simplification must change defaults and presentation, not remove capability.

## Product Shape

Recommended approach: **guided default setup with explicit advanced escape hatches**.

- `npm run setup` remains the main command.
- First run with a TTY starts a beginner path unless `--advanced` is passed.
- Beginner path prompts only for values that cannot be safely inferred:
  - Google Sheet URL or spreadsheet ID
  - sheet tab name
  - writable smoke-test column
  - whether setup should provision Google credentials when none are available
  - Google Cloud project ID when setup provisions Google credentials
- Beginner defaults:
  - `profile`: `production`
  - private project slug/name: `main` / `Main`
  - first table slug: normalized from the tab name, falling back to `table`
  - managed ID column: `_id`
  - indexed fields: empty
  - cache TTL: `60`
  - admin UI deploy: enabled
  - public-read project: disabled
  - smoke create/update values: generated from the smoke field
  - actions: apply secrets, deploy, bootstrap, smoke, and verify
- `npm run setup -- --advanced` keeps the current question set.
- `npm run setup -- --write-default-config` keeps producing a customizable file.
- Existing action flags continue to support partial reruns.
- Docs should present the simple path first and move advanced config to a later section.

## Phase 1: Beginner Prompt Mode

**Files:**

- Modify: `scripts/lib/setup-cli.ts`
- Modify: `scripts/lib/setup-cli.test.ts`
- Modify: `scripts/lib/setup-prompts.ts`
- Modify: `scripts/lib/setup-prompts.test.ts`
- Modify: `scripts/setup.ts`

### Task 1: Add CLI Shape for Beginner and Advanced Modes

- [x] Add `advanced: boolean` to `SetupCliOptions`.
- [x] Parse `--advanced`.
- [x] Update help text so the first common flow is `npm run setup`, followed by `npm run setup -- --advanced`.
- [x] Keep every existing flag unchanged.
- [x] Add a regression test in `scripts/lib/setup-cli.test.ts`:

```ts
it('parses advanced setup mode', () => {
  expect(parseSetupArgs(['--advanced'])).toMatchObject({
    advanced: true
  });
});
```

- [x] Extend the help test to expect `--advanced` and text that says advanced mode asks for all config fields.
- [x] Run:

```powershell
npx vitest run --config vitest.config.ts scripts/lib/setup-cli.test.ts
```

- [x] Expected result: all setup CLI tests pass.
- [x] Commit:

```powershell
git add scripts/lib/setup-cli.ts scripts/lib/setup-cli.test.ts
git commit -m "feat: add setup advanced mode flag"
```

### Task 2: Split Prompt Models

- [x] Rename the existing full prompt implementation to `promptForAdvancedSetup`.
- [x] Keep `buildSetupConfigFromAnswers` unchanged for the advanced path.
- [x] Add a new beginner answer type:

```ts
export type BeginnerSetupAnswers = {
  spreadsheetIdOrUrl: string;
  sheetTabName: string;
  smokeFieldName: string;
  provisionGoogle: boolean;
};
```

- [x] Add `buildBeginnerSetupConfigFromAnswers(answers: BeginnerSetupAnswers): SetupConfig`.
- [x] Derive the table slug from `sheetTabName` with this behavior:
  - trim whitespace
  - lowercase
  - replace runs of non-alphanumeric characters with `-`
  - trim leading/trailing hyphens
  - use `table` if the result is blank
  - validate with `normalizeTableSlug`
- [x] Use this beginner config shape:

```ts
{
  profile: 'production',
  deploy: {
    api: true,
    admin: true
  },
  privateProject: {
    slug: 'main',
    name: 'Main',
    spreadsheetId,
    googleCredentialRef: 'default',
    tables: [
      {
        tableSlug,
        sheetTabName,
        idColumn: '_id',
        cacheTtlSeconds: 60
      }
    ]
  },
  publicReadProject: null,
  smoke: {
    enabled: true,
    privateTableSlug: tableSlug,
    publicTableSlug: null,
    adminKeyName: 'main-admin',
    privateReadKeyName: 'main-read',
    mutationKeyName: 'main-mutation',
    createValues: {
      [smokeFieldName]: 'Sheetflare smoke row'
    },
    updateValues: {
      [smokeFieldName]: 'Sheetflare smoke row updated'
    }
  }
}
```

- [x] Reject blank smoke fields and `_id` smoke fields with the same messages as the advanced builder.
- [x] Add tests:
  - beginner config normalizes a tab name like `Contacts 2026` to table slug `contacts-2026`
  - beginner config falls back to `table` for a punctuation-only tab name
  - beginner config rejects blank smoke fields
  - beginner config rejects `_id` as the smoke field
- [x] Run:

```powershell
npx vitest run --config vitest.config.ts scripts/lib/setup-prompts.test.ts
```

- [x] Expected result: all setup prompt tests pass.
- [x] Commit:

```powershell
git add scripts/lib/setup-prompts.ts scripts/lib/setup-prompts.test.ts
git commit -m "feat: derive beginner setup defaults"
```

### Task 3: Wire Beginner Mode Into `npm run setup`

- [x] Update `promptForSetup` so it accepts:

```ts
export type SetupPromptMode = 'beginner' | 'advanced';
```

- [x] In beginner mode, ask only:
  - `Google Sheet URL or spreadsheet ID`
  - `Existing Google Sheets tab name`
  - `Writable sheet column to use for setup validation`
  - `Provision Google Cloud credentials now` only when no usable Google credential is already visible from environment/local state
  - `Google Cloud project ID (must be globally unique)` only after the operator chooses Google provisioning
- [x] Beginner mode should return actions:

```ts
{
  applySecretsNow: true,
  deployNow: true,
  bootstrapNow: true,
  smokeNow: true,
  verifyNow: true
}
```

- [x] Preserve the existing prompt sequence in advanced mode.
- [x] Add `verifyNow: boolean` to `SetupPromptActions`.
- [x] Update `resolveSetupActions()` so explicit CLI reruns set `verifyNow: options.verify`.
- [x] In `scripts/setup.ts`, call `promptForSetup(prompter, { mode: options.advanced ? 'advanced' : 'beginner', googleCredentialAvailable })`.
- [x] Compute `googleCredentialAvailable` from local setup state and environment before prompting. Treat a non-placeholder `GOOGLE_CLIENT_EMAIL` or local `googleClientEmail` as available.
- [x] If the beginner prompt chooses Google provisioning, store that in a local `provisionGoogle` boolean and use it for secret collection.
- [x] If `provisionGoogle` becomes true after the prompt, run `checkGcloudAuthPrereq()` before collecting secrets and fail with its remediation if blocked.
- [x] Use `actions.verifyNow` instead of `options.verify` for the final `runSetupDoctor()` call.
- [x] Add tests with a fake prompter proving beginner mode asks only the beginner questions and returns all actions enabled.
- [x] Run:

```powershell
npx vitest run --config vitest.config.ts scripts/lib/setup-prompts.test.ts scripts/lib/setup-cli.test.ts
npm run typecheck
```

- [x] Expected result: focused tests pass and TypeScript compiles.
- [x] Commit:

```powershell
git add scripts/setup.ts scripts/lib/setup-prompts.ts scripts/lib/setup-prompts.test.ts scripts/lib/setup-cli.ts scripts/lib/setup-cli.test.ts
git commit -m "feat: make setup default to guided beginner flow"
```

## Phase 2: Setup Output and Failure Guidance

**Files:**

- Modify: `scripts/setup.ts`
- Modify: `scripts/lib/setup-secrets.ts`
- Modify: `scripts/lib/setup-secrets.test.ts`
- Modify: `scripts/lib/setup-google.ts`

### Task 4: Print Beginner-Oriented Next Steps

- [x] After beginner setup writes config, print a short summary that names:
  - generated service-account email when known
  - exact spreadsheet sharing instruction
  - API URL when deployed
  - admin URL when deployed
  - `npm run doctor` as the next verification command
- [x] Do not print private keys, bootstrap admin tokens, or API keys unless `--show-secrets` is present.
- [x] When Google provisioning succeeds, print:

```text
Share your Google Sheet with <service-account-email> as Editor, then continue.
```

- [x] When existing credentials are used, print the same instruction with `GOOGLE_CLIENT_EMAIL`.
- [x] Add a unit-testable formatter helper rather than asserting console output through the whole setup script.
- [x] Run the helper tests and `npm run typecheck`.
- [x] Commit:

```powershell
git add scripts/setup.ts scripts/lib/setup-secrets.ts scripts/lib/setup-secrets.test.ts scripts/lib/setup-google.ts
git commit -m "feat: print clearer setup next steps"
```

### Task 5: Improve Common Failure Messages

- [x] Audit setup failures for first-run beginner flow:
  - missing Wrangler auth
  - missing Google credentials without provisioning
  - gcloud auth missing when provisioning
  - sheet not shared with service account
  - missing `_id` column
  - smoke field not present
- [x] Convert messages that currently assume an expert operator into action-first messages.
- [x] Keep raw unknown exceptions out of public API responses; this task only touches local setup script errors.
- [x] Add regression tests for the helper or script-layer errors that change.
- [x] Run focused tests and `npm run typecheck`.
- [x] Commit:

```powershell
git add scripts/lib/setup-*.ts scripts/lib/setup-*.test.ts
git commit -m "fix: clarify beginner setup failures"
```

## Phase 3: Docs Reframe

**Files:**

- Modify: `README.md`
- Modify: `docs/quickstart.md`
- Modify: `docs/deploy.md`
- Modify: `docs/google-service-accounts.md`

### Task 6: Rewrite Quickstart Around One Happy Path

- [x] Make `docs/quickstart.md` start with the novice flow:

```powershell
npm install
npx wrangler login
gcloud auth login
npm run setup
```

- [x] Say setup will create config, apply secrets, deploy, bootstrap, smoke-test, and verify by default.
- [x] Move advanced table options, public-read setup, manual smoke env vars, and raw bootstrap templates below an `Advanced Configuration` heading.
- [x] Keep links to service-account docs for operators who cannot or do not want to use `gcloud`.
- [x] Ensure the quickstart never implies setup can share the spreadsheet automatically.
- [x] Commit:

```powershell
git add README.md docs/quickstart.md docs/deploy.md docs/google-service-accounts.md
git commit -m "docs: simplify first-run setup guidance"
```

### Task 7: Document Customization Without Making It First-Run Work

- [x] Add a concise table of customization knobs:
  - project/table slugs
  - indexed fields
  - read-only fields
  - field rules
  - cache TTL
  - public-read project
  - named Google credentials
  - separate deploy/bootstrap/smoke commands
- [x] For each knob, state where to configure it and whether it requires rerunning bootstrap, deploy, or smoke.
- [x] Keep examples short and practical.
- [x] Commit:

```powershell
git add docs/quickstart.md docs/deploy.md
git commit -m "docs: keep setup customization discoverable"
```

## Phase 4: Verification and Polish

**Files:**

- Modify only files already touched by Phases 1-3 unless a verification failure points to a specific setup caller.

### Task 8: Run Full Setup-Surface Verification

- [x] Run focused setup tests:

```powershell
npx vitest run --config vitest.config.ts scripts/lib/setup-cli.test.ts scripts/lib/setup-prompts.test.ts scripts/lib/setup-secrets.test.ts scripts/lib/setup-config.test.ts scripts/lib/setup-doctor.test.ts
```

- [x] Run the full repo gate:

```powershell
npm run check
```

- [x] If failures are related to the setup simplification, fix them with regression tests before continuing.
- [x] If failures are unrelated, document the exact failing command and error in the final handoff.
- [x] Commit any verification fixes:

```powershell
git add scripts/setup.ts scripts/lib/setup-cli.ts scripts/lib/setup-cli.test.ts scripts/lib/setup-prompts.ts scripts/lib/setup-prompts.test.ts README.md docs/quickstart.md docs/deploy.md docs/google-service-accounts.md
git commit -m "test: cover simplified setup flow"
```

### Task 9: Review the Final Diff for Capability Preservation

- [x] Confirm `sheetflare.setup.json` still supports:
  - private project customization
  - public-read project customization
  - indexed fields
  - read-only fields
  - field rules
  - cache TTL
  - named `GOOGLE_CREDENTIALS_JSON` refs
- [x] Confirm action flags still work:
  - `--apply-secrets`
  - `--deploy`
  - `--bootstrap`
  - `--smoke`
  - `--verify`
  - `--write-default-config`
  - `--config`
  - `--provision-google`
  - `--google-project`
  - `--google-service-account`
- [x] Confirm advanced prompt mode still exposes the old custom questions.
- [x] Run:

```powershell
git diff --check
git status --short --branch
```

- [x] Final handoff must include:
  - branch name
  - commits created
  - verification commands and results
  - any remaining implementation phases not completed in this session
