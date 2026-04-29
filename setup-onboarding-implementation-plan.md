# Setup Onboarding Implementation Plan

This plan defines how Sheetflare should move from a docs-first setup flow to a real guided onboarding flow that is simple, explicit, and safe.

The target is not "hide all complexity."

The target is:

- one obvious starting command
- one durable non-secret config file
- explicit secret handling
- clear stop points when prerequisites are missing
- a private-first happy path
- optional `public-read` coverage, not a required branch

## Goals

- Let a new operator clone the repo, run `npm run setup`, answer prompts, and end with a valid local configuration plus a clear next step or a completed deploy.
- Keep configuration explicit enough that the resulting deployment is understandable without rereading the wizard.
- Reuse existing deploy, bootstrap, smoke, and admin flows rather than creating a second hidden control plane.
- Keep secrets out of checked configuration.
- Make partial progress useful. The setup command should still help if the operator is not ready to deploy yet.

## Non-Goals

- Do not make package-first installation the first milestone. V1 should be repo-first.
- Do not silently create or mutate Google Sheets tabs.
- Do not hide Cloudflare or Google credential requirements behind vague UI copy.
- Do not invent a second runtime configuration model that conflicts with `wrangler.jsonc`, bootstrap config, or existing scripts.

## Current Problems

- The current flow is spread across `README.md`, `docs/quickstart.md`, `docs/deploy.md`, and `docs/google-service-accounts.md`.
- Operators must manually translate docs into environment variables, Wrangler secrets, bootstrap config, and smoke inputs.
- There is no single local artifact that represents "this deployment's intended shape."
- The current bootstrap path is usable, but `SHEETFLARE_BOOTSTRAP_CONFIG_JSON` is an operator convenience, not a good onboarding UX.

## Target User Experience

### V1 Happy Path

1. User clones the repo and runs `npm install`.
2. User runs `npm run setup`.
3. Setup checks prerequisites and explains missing ones with exact commands.
4. Setup prompts for:
   - deployment profile name
   - Worker deploy target
   - whether admin Pages deploy should be configured now
   - Google Sheet URL or spreadsheet ID
   - private project slug and first table mapping
   - whether optional `public-read` coverage should also be configured
5. Setup writes a checked non-secret config file.
6. Setup offers to:
   - set Wrangler secrets
   - deploy the API Worker
   - deploy the admin UI
   - bootstrap the first project/table/key
   - run smoke validation
7. If the operator declines one or more actions, setup prints the exact next commands.

### V1 Failure Behavior

- If `wrangler whoami` fails, setup stops before deploy steps and prints the exact auth fix.
- If the spreadsheet URL is malformed, setup rejects it before writing config.
- If required secrets are missing, setup offers a secret-entry step or prints the exact secret commands to run later.
- If bootstrap validation fails, setup preserves the generated config and prints the failed step plus the retry command.

## Proposed Artifacts

### 1. Checked non-secret config

Create a repo-root file:

`sheetflare.setup.json`

Purpose:

- durable desired-state input for setup, bootstrap, and smoke
- portable between operators
- safe to commit if the operator wants to track deployment shape in Git

Contents should include only non-secret values:

- environment/profile name
- base naming preferences
- API/admin deploy intent
- spreadsheet IDs
- project slugs
- table mappings
- auth modes
- indexed fields
- read-only fields
- field rules
- smoke target selection

### 2. Local secret input path

Do not store secrets in `sheetflare.setup.json`.

V1 should support secrets from:

- interactive prompt entry
- existing environment variables
- existing Wrangler auth plus `wrangler secret put`

Optional later:

- an untracked local template file such as `sheetflare.setup.local.json`

That local file should not be part of the first implementation unless it clearly reduces complexity.

## Proposed Command Surface

### New command

```powershell
npm run setup
```

### Supporting modes

```powershell
npm run setup -- --config sheetflare.setup.json
npm run setup -- --write-default-config
npm run setup -- --deploy
npm run setup -- --bootstrap
npm run setup -- --smoke
```

Rules:

- plain `npm run setup` should be interactive
- `--config` should allow non-interactive reuse in CI or repeated local runs
- `--write-default-config` should generate a starter config and exit
- `--deploy`, `--bootstrap`, and `--smoke` should allow partial reruns without repeating prompt entry

## Proposed Internal Architecture

Keep the setup flow decomposed into small, explicit pieces.

### Setup modules

- `scripts/setup.ts`
  - top-level CLI entrypoint
- `scripts/lib/setup-config.ts`
  - config types, parsing, validation, and serialization
- `scripts/lib/setup-prompts.ts`
  - interactive prompt flow
- `scripts/lib/setup-prereqs.ts`
  - tool/auth checks such as `wrangler whoami`
- `scripts/lib/setup-secrets.ts`
  - secret collection and Wrangler secret application
- `scripts/lib/setup-bootstrap.ts`
  - transform setup config into existing bootstrap input
- `scripts/lib/setup-smoke.ts`
  - transform setup output into existing smoke input
- `scripts/lib/setup-summary.ts`
  - terminal summary and exact next commands

### Design rules

- Reuse existing bootstrap and smoke libraries where possible.
- Setup should produce explicit artifacts or explicit commands, not hidden state.
- Config validation must be separate from prompt rendering.
- Prompt flow should depend on the config model, not the other way around.

## Recommended Config Shape

This is a planning target, not final syntax.

```json
{
  "profile": "local",
  "deploy": {
    "api": true,
    "admin": true
  },
  "spreadsheet": {
    "id": "1abc..."
  },
  "project": {
    "slug": "demo",
    "name": "Demo",
    "defaultAuthMode": "private",
    "googleCredentialRef": "default"
  },
  "tables": [
    {
      "tableSlug": "users",
      "sheetTabName": "Users",
      "idColumn": "_id",
      "indexedFields": ["email", "status"],
      "readOnlyFields": ["status_label"],
      "fieldRules": {
        "email": {
          "required": true,
          "unique": true,
          "normalize": ["trim", "lowercase"]
        }
      },
      "cacheTtlSeconds": 60
    }
  ],
  "smoke": {
    "enabled": true,
    "createValues": {
      "name": "Smoke Row",
      "status": "active"
    },
    "updateValues": {
      "status": "inactive"
    },
    "publicReadProject": null
  }
}
```

Important constraints:

- exactly one private project should be enough for V1
- optional `public-read` support should be additive, not required
- config should map cleanly into current bootstrap and smoke scripts

## Implementation Phases

## Phase 0: Lock the contract

Outcome:

- the team agrees on the setup command contract before building prompt code

Resolved decisions:

- `sheetflare.setup.json` is the checked non-secret config file for V1 and lives at repo root by default.
- V1 does not write a second local secret file by default.
- `npm run setup` is interactive and confirm-before-side-effects by default.
- API deploy is the primary path; admin deploy is an explicit prompt-controlled option.
- Smoke does not run automatically without confirmation, even after successful bootstrap.
- V1 is private-first and single-project-first.
- Optional `public-read` coverage is supported, but only as an additive branch.
- V1 prompt scope is limited to the minimum needed to produce one usable private project and one initial table.
- Setup must reuse the existing deploy, bootstrap, and smoke seams rather than reimplementing them.

Checklist:

- [x] Choose final config filename and repo placement
- [x] Choose whether V1 writes only `sheetflare.setup.json` or also an optional local secret template
- [x] Choose whether `npm run setup` should deploy by default or only after explicit confirmation
- [x] Choose how admin UI deploy is represented when the operator wants API-only setup
- [x] Choose whether smoke should run automatically after successful bootstrap or only by confirmation
- [x] Choose the minimal required prompt set for V1
- [x] Define which existing scripts are official dependencies of setup and which seams should be extracted first

V1 minimum prompt set:

- deployment profile name
- spreadsheet URL or spreadsheet ID
- project slug
- project display name
- first table slug
- first sheet tab name
- ID column
- indexed fields
- whether admin deploy should be configured now
- whether optional `public-read` coverage should be added
- whether to apply secrets now
- whether to deploy now
- whether to bootstrap now
- whether to run smoke now

Official script dependencies for V1:

- `npm run deploy:api`
- `npm run deploy:admin`
- `npm run ops:create-admin-key`
- `npm run ops:bootstrap`
- `npm run smoke`

Seams that should be extracted first if reuse is awkward:

- bootstrap input transformation
- smoke input transformation
- deploy result parsing and summary rendering

Acceptance criteria:

- written contract is stable enough that config/schema work can begin without redoing prompt flow

Parallelization:

- none; this phase should be resolved first

## Phase 1: Config and validation foundation

Outcome:

- `sheetflare.setup.json` exists as a real validated contract

Checklist:

- [ ] Add setup config types and runtime validation
- [ ] Add spreadsheet URL parsing and normalization to spreadsheet ID
- [ ] Add CLI support for `--config` and `--write-default-config`
- [ ] Add config serialization with stable formatting
- [ ] Add tests for valid/invalid config cases
- [ ] Add tests for spreadsheet URL parsing edge cases

Acceptance criteria:

- setup config can be created, loaded, validated, and round-tripped without prompt logic
- invalid config fails with specific operator-facing errors

Parallelization:

- Can run in parallel:
  - config validation implementation
  - config docs/example drafting
  - spreadsheet URL parsing tests

## Phase 2: Prereq and environment inspection

Outcome:

- setup can detect whether the environment is ready for deploy/bootstrap actions

Checklist:

- [ ] Add Wrangler auth check
- [ ] Add Node/npm workspace sanity check
- [ ] Add repo dependency/install check
- [ ] Decide whether `gcloud` should be checked in V1 or left as documented-only
- [ ] Add explicit result model for prereq checks: `ready`, `warning`, `blocked`
- [ ] Add tests around prereq result classification

Acceptance criteria:

- setup can stop early with exact remediation commands
- prereq checks are reusable by both interactive and non-interactive flows

Parallelization:

- Can run in parallel:
  - prereq result model and tests
  - shell integration for Wrangler/npm checks

## Phase 3: Interactive prompt flow

Outcome:

- a new operator can produce a complete config through prompts

Checklist:

- [ ] Add interactive prompt driver
- [ ] Prompt for deployment profile
- [ ] Prompt for spreadsheet URL or ID
- [ ] Prompt for project slug and name
- [ ] Prompt for first table mapping
- [ ] Prompt for optional `public-read` coverage
- [ ] Prompt for whether admin deploy should be configured now
- [ ] Prompt for whether to deploy/bootstrap/smoke immediately
- [ ] Print a review summary before writing config
- [ ] Add prompt-flow tests where practical

Acceptance criteria:

- interactive setup can generate a usable config with no manual JSON editing
- operator sees a concise final review before side effects happen

Parallelization:

- Can run in parallel:
  - prompt copy/content drafting
  - prompt state machine implementation
  - prompt-flow tests

## Phase 4: Secret handling and deploy orchestration

Outcome:

- setup can help apply secrets and reuse the existing deploy commands

Checklist:

- [ ] Define exactly which secrets setup can collect interactively in V1
- [ ] Add `wrangler secret put` orchestration for Worker secrets
- [ ] Decide whether admin Pages basic-auth secrets are in scope for V1 or deferred
- [ ] Reuse existing `npm run deploy:api` and `npm run deploy:admin`
- [ ] Capture deploy results in a structured setup result object
- [ ] Print exact retry commands when deploy fails
- [ ] Add tests for secret/deploy command construction

Acceptance criteria:

- setup can either apply secrets and deploy or print the exact commands needed later
- no secrets are written to checked files

Parallelization:

- Can run in parallel:
  - Worker secret orchestration
  - deploy result summarization
  - docs for secret expectations

## Phase 5: Bootstrap and smoke integration

Outcome:

- setup can finish with a real working project, not just a deployed empty Worker

Checklist:

- [ ] Transform setup config into existing bootstrap input
- [ ] Run bootstrap through the current bootstrap seam rather than reimplementing control-plane calls
- [ ] Create or mint the minimum required admin/read/mutation keys for smoke
- [ ] Transform setup output into smoke input
- [ ] Support private-only smoke as the default path
- [ ] Run optional `public-read` smoke only when configured
- [ ] Persist optional smoke report path when requested
- [ ] Add tests for setup-to-bootstrap and setup-to-smoke transformations

Acceptance criteria:

- a single setup run can end with deploy, bootstrap, and private-only smoke passing
- the optional `public-read` branch is additive and isolated

Parallelization:

- Can run in parallel:
  - bootstrap transform work
  - smoke transform work
  - report/output formatting

## Phase 6: Docs and developer ergonomics

Outcome:

- the new setup flow becomes the primary onboarding path

Checklist:

- [ ] Update `README.md` to lead with `npm run setup`
- [ ] Update `docs/quickstart.md` to use setup as the default path
- [ ] Move manual deploy/bootstrap details into supporting sections instead of the primary flow
- [ ] Document how to rerun only deploy, bootstrap, or smoke from an existing setup config
- [ ] Document what setup does not automate
- [ ] Add troubleshooting for failed Wrangler auth, failed bootstrap, and malformed spreadsheet URL

Acceptance criteria:

- a new public user can follow one primary path without stitching together multiple docs

Parallelization:

- Can run in parallel:
  - README updates
  - quickstart/deploy doc updates
  - troubleshooting documentation

## Phase 7: Cleanup and follow-on work

Outcome:

- the setup implementation does not leave confusing duplicate seams behind

Checklist:

- [ ] Rename staging-era implementation files that are now public/generic seams
- [ ] Remove or reduce redundant script wrappers if setup made them obsolete
- [ ] Review whether `ops:bootstrap` should accept config-file input directly in addition to env JSON
- [ ] Review whether smoke/load should optionally read from `sheetflare.setup.json`
- [ ] Decide whether a later package-first or `npx` distribution path is justified

Acceptance criteria:

- the operator surface is simpler after setup lands, not just larger

Parallelization:

- Can run in parallel:
  - naming cleanup
  - script surface cleanup
  - future package-distribution evaluation

## Testing Strategy

Required automated coverage:

- config validation success/failure
- spreadsheet URL parsing
- prereq result classification
- prompt-to-config transformation
- setup-to-bootstrap transformation
- setup-to-smoke transformation
- command construction for secret application and deploy
- private-only happy path orchestration
- optional `public-read` branch gating

Prefer:

- pure tests for config, parsing, and transformation logic
- narrow command-construction tests at shell boundaries
- one higher-level orchestration test that proves the happy-path sequencing

Do not rely on:

- mock-heavy tests that only assert prompts were called in order

## Suggested Commit Plan

1. Config contract and validation
2. Prereq checks
3. Interactive prompt flow
4. Secret/deploy orchestration
5. Bootstrap/smoke integration
6. Docs and cleanup

Each commit should:

- keep `npm run lint` green
- keep `npm test` green
- keep `npm run typecheck` green
- keep `npm run build` green
- include regression tests for any bug fix discovered during implementation

## First Implementation Cut Recommendation

Build the smallest useful version first:

- one spreadsheet
- one private project
- one initial table
- optional admin UI deploy
- optional immediate bootstrap
- optional immediate private-only smoke

That is enough to transform onboarding quality without overcommitting to multi-project or package-install complexity.

Only after that lands cleanly should the project consider:

- multi-project guided setup
- `public-read` wizard enhancements
- reusable local secret templates
- package-first or `npx` installation
