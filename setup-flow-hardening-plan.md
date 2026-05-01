# Setup Flow Hardening Plan

This plan turns the recent production rollout lessons into concrete setup-flow improvements.

The goal is to make `npm run setup` the authoritative, trustworthy path for provisioning, deploying, bootstrapping, and verifying a Sheetflare environment.

## Objectives

- [x] Make setup own the full environment lifecycle instead of leaving critical provisioning steps manual
- [x] Fail fast on placeholder, partial, or misleading environment state
- [x] Verify live behavior after deploys instead of trusting command success alone
- [x] Eliminate split ownership for admin Pages runtime config
- [x] Improve operator confidence around Drive watch registration and status
- [x] Tighten docs so the recommended flow matches the actual robust flow

## Phase 1: Baseline Setup And Deploy Hardening

- [x] Port the stronger setup-managed deploy behavior into `main`
- [x] Ensure setup can create the target admin Pages project automatically
- [x] Manage `SHEETFLARE_API_BASE_URL` at the Pages project level instead of checked-in admin Wrangler config
- [x] Verify the protected admin root and proxied `/docs` after admin deploy
- [x] Keep admin deploy code simple and Pages-runtime-safe
- [x] Add or update regression tests for deploy orchestration and admin verification

## Phase 2: Google Provisioning And Fail-Fast Validation

- [x] Add setup-managed Google provisioning via `gcloud`
- [x] Support explicit overrides for Google project ID and service-account name
- [x] Persist only the reusable service-account email locally, not ephemeral generated key files
- [x] Detect placeholder `GOOGLE_CLIENT_EMAIL` defaults before deploy/bootstrap paths rely on them
- [x] Fail clearly when setup is asked to deploy/bootstrap without a real Google credential source
- [x] Add or update regression tests for Google provisioning and validation paths

## Phase 3: Setup Verification / Doctor Flow

- [x] Add a first-class setup verification mode
- [x] Verify local prerequisites and auth state for Wrangler and optional `gcloud`
- [x] Verify Pages project existence and required runtime bindings/secrets
- [x] Verify API `/ready`
- [x] Verify admin Pages root and proxied `/docs`
- [x] Verify Drive watch registration/status through the same operator-facing surface we document
- [x] Produce operator-readable output that identifies exactly what is healthy vs missing
- [x] Add or update regression tests for the verification flow

## Phase 4: Drive Watch Confidence And Operator Usability

- [x] Investigate and fix the `ops:watch:drive:status` confidence gap if it still exists
- [x] Ensure setup verifies automatic watch registration through the same status path operators use
- [x] Improve error messages or output summaries when watch registration succeeds but status is unhealthy
- [x] Add or update regression tests for the watch status path

## Phase 5: Docs And Operator Flow

- [x] Update `README.md` so setup is the clearly preferred environment bring-up path
- [x] Update `docs/quickstart.md` to cover Google provisioning, deploy verification, and watch verification
- [x] Update `docs/deploy.md` so setup is the authoritative deploy path and manual fallback is explicit
- [x] Update `docs/google-service-accounts.md` with the setup-managed provisioning path and boundaries
- [x] Update `docs/operator-runbook.md` with verification and recovery commands for the new flow

## Final Review Gate

- [x] Run targeted tests for each batch while implementing
- [x] Run `npm run check` before the final review pass
- [x] Do one fresh review pass over setup, deploy, Google provisioning, and watch status after the implementation is complete
- [x] Tighten any remaining correctness, usability, or docs gaps found in that final review
