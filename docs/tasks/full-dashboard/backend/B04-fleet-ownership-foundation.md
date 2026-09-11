# B04: Worker registry and per-machine lifecycle authority Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Prepare the existing backend for multiple independently authenticated Windows workers while preserving one owner per active attempt.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B01](../backend/B01-admin-identity-permissions.md), [B02](../backend/B02-audit-operation-receipts.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/worker/worker-registration.schema.ts, worker-registry.service.ts, worker-identity.service.ts and worker-registry.service.spec.ts.
- Modify backend/src/worker/worker-auth.guard.ts, worker-control.schema.ts, worker-coordinator.service.ts, worker-output.service.ts, worker-terminal.service.ts, worker-recovery.service.ts, worker-claim-wait.service.ts, worker.controller.ts; backend/src/jobs/job.schema.ts and job-attempt.schema.ts.
- Create backend/test/admin-fleet.integration.mjs; modify relevant worker HTTP/integration tests, backend/src/config/environment.ts and processing schema registration.

## Interfaces

Consume the multi-machine worker design with admin identity supplied by B01. Add server-authenticated workerId to claims, attempts and lifecycle context; POST /worker/identity -> {workerId,state,protocolVersion:2}. Dashboard interfaces are completed by B05.

## Steps

- [ ] 1. Reinspect whether the separate fleet implementation has landed. Reuse it and its tests if present; close only proven gaps. Keep Windows source/tasks separate and record protocol-v2 support as an external compatibility prerequisite.

- [ ] 2. Write isolation tests: worker A cannot claim another slot, finish B's attempt, mint B's output grant or replay B's receipt. Test 20 unique workers across two API instances with no duplicate assignment and FIFO selection.

- [ ] 3. Implement registry digest lookup, server-owned identity, per-worker control records and owned attempts in existing transactions. Touch controlRevision when lifecycle state/key changes so claims and side-effect grants race safely with drain/revoke.

- [ ] 4. Preserve legacy mode for z440 and introduce explicit fleet mode without credential fallback. Provide dry-run ownership/backfill checks through trusted operations; no automatic document rewrite, mode switch or key rotation. A successful migration remains separately authorized.

- [ ] 5. Update bounded long-poll admission (default 32 per process, allowed 1–1024), one waiter per worker/process, recheck current credentials and release counts on disconnect/error/shutdown. Other workers continue while one interrupted slot is fenced.

- [ ] 6. Run native compiled-node isolated integration for concurrent claims, stale events and recovery; retain the existing processing suite. Document that no physical Windows test or live migration was performed.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Twenty worker IDs claim twenty distinct queued jobs and each has at most one slot.
Scenario 2: Revocation racing with a claim is serialized by shared control authority; no stale post-revocation allocation commits.
Scenario 3: Lease expiry keeps unfinished ownership reserved while unrelated workers continue.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/worker src/jobs/job-schema.spec.ts
npm run test:e2e -- test/worker-auth.e2e-spec.ts test/worker-claim.e2e-spec.ts
npm run build
node --test test/admin-fleet.integration.mjs
npm run test:processing:integration
```

## Completion evidence

- [ ] Fleet ownership invariants are proven locally; compatibility and migration prerequisites are explicit.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
