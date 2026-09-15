# V02: Validate the integrated fleet under ownership, setup and update failures Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Prove the new components work together without duplicate work, accidental broad rollouts, secret leakage or lost setup history.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B06, D03, D02, H02, W04

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create backend/test/cross-platform-worker-fleet.integration.mjs and backend/test/worker-update-races.integration.mjs.
- Create worker/tests/test_fleet_protocol.py with shared wire fixtures.
- Create dashboard/test/worker-fleet.acceptance.spec.ts using the existing browser test harness or add a scoped harness only if absent.
- Create docs/tasks/cross-platform-workers/evidence/integration-report.md during execution.
- Wire a repeatable fleet integration command into `backend/package.json` covering
  runtime, installations, events, rollouts, readiness, fleet-only and Python-spool
  integrations as well as this task's new scenarios. Existing processing/dashboard
  scripts enumerate older subsets and do not automatically include new test files.
  Document/provision the isolated launcher Python prerequisite for the spool test;
  missing dependencies must be an explicit failure, not a silent skipped test.

## Interfaces

- Consumes the complete version-3 protocol, selected rollouts, installer event batches, native process abstraction and signed release fixtures.
- Produces integrated proof using two backend instances, multiple worker identities and isolated MongoDB/Redis plus local artifact HTTP service.

## Steps

- [ ] 1. Exercise installation registration, logs before pairing, code expiry/approval, permanent-auth readiness and one complete job result with no manual secret transfer.

- [ ] 2. Run claim/revoke/readiness/update races in both commit orders across two API instances. Assert exact owner/session/generation and no duplicated processing publication.

- [ ] 3. Test lost responses at registration, approval, completion, cleanup, publication, rollout creation and activation acknowledgement. Retry without duplicate identities, jobs or events.

- [ ] 4. Raise minimum build during a current-protocol assignment and verify completion remains possible while new claims are blocked. Reject obsolete protocol versions directly; no compatibility adapter.

- [ ] 5. Confirm selected-group snapshot isolation, stable-install independence, withdrawn/prohibited fallback behavior and rollout pause while offline.

- [ ] 6. Test offline log buffering, redaction, ingest quotas, duplicate conflicts, TTL visibility, interruption unknown-state and 30-day local-spool expiry.

- [ ] 7. Run same-protocol state-compatible update fault injection; for intentional breaking schema changes require stopped development restart and explicit handling of incompatible state instead of a converter.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Two API instances race a claim and an update hold
  Given one idle worker is eligible for a new job
  When a policy change and a claim commit concurrently
  Then either the claim owns the job under the valid earlier state
  Or the hold prevents the claim
  And no unowned or duplicated assignment is published
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm run verify
npm run build
node --test test/cross-platform-worker-fleet.integration.mjs test/worker-update-races.integration.mjs
npm run test:processing:integration
npm run test:dashboard:integration
```

## Completion evidence and limits

Compiled-node integration output, race outcomes, safe fixture logs, browser acceptance and shared Python protocol fixtures. Also run dashboard typecheck/lint/test/build and the shared worker suite from their documented roots.

Use existing native isolated service helpers. Do not connect tests to CapRover production services or use Docker as a substitute for native workers.
