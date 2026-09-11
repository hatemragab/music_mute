# B09: Administrator cancellation and eligible retries Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Reuse the existing job state machine for administrative cancel/retry without bypassing ownership, admission or recovery.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B02](../backend/B02-audit-operation-receipts.md), [B06](../backend/B06-processing-settings-admission.md), [B07](../backend/B07-user-search-processing-suspension.md), [B08](../backend/B08-job-search-detail-attempts.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-jobs/admin-job-actions.service.ts, dto/admin-job-action.dto.ts and admin-job-actions.service.spec.ts; extend admin-jobs.controller.ts.
- Refactor shared lifecycle entrypoints in backend/src/jobs/job-actions.service.ts with explicit authorized actor context; preserve mobile owner-only wrappers.
- Create backend/test/admin-job-actions.e2e-spec.ts, backend/test/admin-job-actions.integration.mjs.

## Interfaces

POST /admin/jobs/:id/cancel and /retry. Cancel returns actual status/revision; retry returns a new tail-queued job linked through retryOfJobId. AdminActor is internal context, not a forged user's Firebase token.

## Steps

- [x] 1. Test allowed roles, denied cross-route permission, reason/revision validation and actor attribution. Cover queued, validating, processing, uploading_result, ready, interrupted, failed and cancelled states explicitly.

- [x] 2. Refactor reusable cancellation/retry transitions behind separately validated user/admin entrypoints. Retain current ownership checks on mobile endpoints and prevent request-supplied admin bypass flags.

- [x] 3. Cancellation marks active work cancel_requested and waits for worker termination proof; immediate cancellation is allowed only where the existing state machine allows it. A repeated request is idempotent; completed work is not erased.

- [x] 4. Retry only failed jobs with existing verified pinned input and eligible failure codes; bad input returns NEW_INPUT_REQUIRED. Apply B06/B07 gates and new request identity, allocate a new FIFO position and preserve source job/history.

- [x] 5. Serialize actions with job revision and account-deletion fences. A recovery-required/interrupted job must use B05 stopped recovery rather than retry. Audit source/new IDs without filenames.

- [x] 6. Test concurrent user/admin cancel, retry double submission, finish-versus-cancel, stale revision, suspended owner and deletion races; verify only one retry job is enqueued per operation.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Two retries with one operationId create one new tail-queued job and preserve the failed source.
Scenario 2: Retry of INPUT_CHECKSUM_MISMATCH returns NEW_INPUT_REQUIRED and performs no enqueue.
Scenario 3: Cancellation of active processing returns cancel_requested until the worker confirms termination.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-jobs/admin-job-actions.service.spec.ts src/jobs/job-actions.service.spec.ts
npm run test:e2e -- test/admin-job-actions.e2e-spec.ts
npm run build
node --test test/admin-job-actions.integration.mjs
```

## Completion evidence

- [x] Admin operations preserve the proven job lifecycle, FIFO and stopped-recovery policy.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.

### Local implementation evidence — 2026-09-11

Implemented in the shared working tree based on `719b39b`; no commit, push, deployment or live-data mutation was performed. Changed `backend/src/jobs/job-actions.service.ts` and its unit tests; added `admin-jobs/admin-job-actions.service.ts`, its unit tests and `dto/admin-job-action.dto.ts`; extended the admin jobs controller/module and the existing read HTTP fixture; added `test/admin-job-actions.e2e-spec.ts` and `test/admin-job-actions.integration.mjs`.

Mobile wrappers retain explicit user ownership and existing request hashes. Separate internal admin entrypoints require `jobs.manage`, an exact administrative revision and the B02-supplied transaction. Cancellation retains unfinished worker reservations. Retry requires a failed job with verified pinned input, no unreleased slot, active owner and current admission permission, then creates a new tail-queued job without replacing source history. The source and new job receive safe audit events under one operation ID. Legacy missing administrative revisions compare as zero. Administrative `NEW_INPUT_REQUIRED` uses HTTP 422 while mobile domain behavior remains HTTP 409.

Observed checks:

- New service assertions failed before implementation (7 failed); new shared authority tests failed before their entrypoints existed (4 failed); HTTP action tests failed with 404 before routes were added. The administrative 422 regression was observed failing with 409 before the adapter change.
- `npm test -- src/jobs/job-actions.service.spec.ts src/admin-jobs/admin-job-actions.service.spec.ts` — 18 passed.
- `npm run test:e2e -- test/admin-job-actions.e2e-spec.ts test/admin-jobs-read.e2e-spec.ts` — 4 passed, including the administrative 422 response and preserved mobile domain 409.
- `node --test test/admin-job-actions.integration.mjs` — 10 passed, 0 skipped, against isolated replica-set MongoDB and the parent's serialized compiled output. Scenarios cover all cancellation states; owner isolation; missing-revision CAS with active filter sanitization; duplicate operation retry/FIFO/audit receipt; invalid input and reserved recovery; closed admission and disabled/deleting/suspended owners; deletion/suspension races; audit rollback; concurrent mobile/admin cancellation; and real worker completion versus cancellation.
- Scoped `prettier --write` and `oxlint --deny-warnings` on the ten B09 source/test paths passed. An initial lint warning in a test query double was fixed.
- `npm run typecheck` passed before concurrent B16 work began. The later full invocation reported only B16 files still being implemented; final whole-backend validation is coordinated by the parent task.

The parent task subsequently rebuilt the latest source successfully and reported a fresh passing native B09 run (10 tests), `test/job-actions.integration.mjs` (1 test) and `test/jobs-cancel.integration.mjs` (1 test), covering the final admin-only 422 adapter change and integer-bound tightening. No real Firebase account, S3 object, media, Windows worker, simulator, migration or production service was used by this implementation task.
