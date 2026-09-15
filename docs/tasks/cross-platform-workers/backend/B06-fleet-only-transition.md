# B06: Remove legacy runtime and migration machinery outright Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCAL REVIEWED — [independent review](../evidence/B06-review.md) approved the scoped implementation with no actionable findings. See [B06 report](../evidence/B06-report.md) for validation and downstream limits.
**Goal:** Use only the new fleet protocol and pairing flow in development, deleting obsolete compatibility and migration machinery.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B02, B05, W01

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Modify backend/src/worker/worker-auth.guard.ts, worker-registry.service.ts, worker-routes.ts and current coordinator/recovery/terminal callers.
- Modify backend/src/config/environment.ts, safe .env.*.example files, package scripts and current worker documentation.
- Remove obsolete backend/src/operations/worker-fleet-migrate.ts, backend/src/worker/worker-fleet-migration.ts, and migration-only operations helpers/specs after verifying imports.
- Keep any independently useful fleet integrity checks only if they operate solely on the new schema; remove legacy/backfill branches and migration-only audits.
- Create backend/test/worker-fleet-only.integration.mjs using isolated new-schema fixtures.

## Interfaces

- Consumes new registry/installation/runtime contracts from B01/B02/B05 and the shared worker in W01.
- Produces one protocol-v3 fleet path with no auth-mode toggle, environment key fallback, missing-owner inference, migration commands, or legacy client/install adapter.

## Steps

- [ ] 1. Inventory legacy configuration, default IDs, fallback ownership, migration/backfill commands, package scripts and obsolete test fixtures. Mark each for removal or conversion to a new-contract test.

- [ ] 2. Remove legacy authentication and singleton initialization. Require the database-registered identity and explicit ownership for every worker operation.

- [ ] 3. Delete migration/backfill entry points and migration-only helpers/tests; remove imports and script aliases. Do not replace them with a differently named transition tool.

- [ ] 4. Update configuration examples, error messages and README instructions for native setup and code pairing. Existing physical Z440 uses the same new installation path.

- [ ] 5. Test protocol-v2, environment-only credentials, ownerless events, unregistered IDs and mismatched installation identity all fail clearly without mutating ownership.

- [ ] 6. Use fresh isolated test databases. Document the exact manual re-enrollment/reset requirement if old development data is incompatible, without deleting it or adding a converter.

- [ ] 7. Run a repository reference scan to prove no executable migration command, mode flag or owner fallback remains. Prepare the coordinated idle development deployment sequence for V03.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: An old environment-only worker connects
  Given no registered fleet identity matches its credential
  When it requests an assignment
  Then authentication fails with a safe reinstallation reason
  And no z440 slot is created or historical owner inferred
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm run verify
node --test test/worker-fleet-only.integration.mjs
npm run test:processing:integration
```

## Completion evidence and limits

Legacy-reference inventory, deleted obsolete entry points, strict new-contract integration results and configuration validation.

No data migration is required or permitted by this plan. Breaking changes do not authorize deleting existing data or stopping live processes.
