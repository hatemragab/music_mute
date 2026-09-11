# B05: Worker administration, one-time keys and stopped recovery Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Expose real worker management APIs for registration, drain, enable, key changes and exact-attempt recovery.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B03](../backend/B03-administrator-access-management.md), [B04](../backend/B04-fleet-ownership-foundation.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-workers/admin-workers.module.ts, admin-workers.controller.ts, admin-workers.service.ts, admin-workers.presenter.ts, dto/admin-worker.dto.ts and admin-workers.service.spec.ts.
- Modify worker-registry.service.ts and worker-recovery.service.ts only through shared lifecycle methods; register module in backend/src/app.module.ts.
- Create backend/test/admin-workers.e2e-spec.ts and backend/test/admin-workers.integration.mjs.

## Interfaces

All worker administration routes and WorkerSummary in contracts.md. Raw keys occur only in successful registration/rotation responses; status/list/detail never contain key digests. workers.recover is required for release-stopped.

## Steps

- [x] 1. Test each endpoint against allowed and forbidden roles; validate IDs, labels, revisions, reasons, operation IDs and fresh authentication for key/recovery changes.

- [x] 2. Implement paginated safe registry/control joins with actual liveness timestamps, distinct online/draining/revoked/recovery flags and bounded detail events. Label rename is audited; no hardware telemetry invention.

- [x] 3. Register with server-generated 32-byte random secrets, unique digests, one-time no-store response and non-secret receipts. Explicitly test lost-response recovery without automatic replay or reveal.

- [x] 4. Implement drain/enable through controlRevision transactions: draining finishes active work but accepts none; normal rotation requires idle; revoked identity cannot enable. Active emergency revoke leaves its attempt reserved.

- [x] 5. Implement stopped-release attestation matching worker/job/attempt/session/generation/revision. Reject heartbeat-only proof, inconsistent slot/job state, stale evidence and concurrent worker completion. Retain the existing recovery semantics and transaction fences.

- [x] 6. Run both commit-order race cases for drain/claim, revoke/output grant, rotate/pending poll and recover/finish. Audit every successful write and deny cross-worker selectors.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Drain on an active worker preserves its job while the next claim returns no new assignment.
Scenario 2: Rotating an active worker returns WORKER_NOT_IDLE and stores no replacement key.
Scenario 3: Release-stopped with the prior generation is rejected even when the machine is offline.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-workers
npm run test:e2e -- test/admin-workers.e2e-spec.ts
npm run build
node --test test/admin-workers.integration.mjs
```

## Completion evidence

- [x] The dashboard can control actual backend worker state with one-time key handling and conservative recovery.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.

## Implementation evidence (2026-09-11)

Implemented in the shared working tree based on `719b39be0d8d0a3b01a94d43ee66cfc039651e7c`; no commit, push, deployment, credential migration or real data change was performed.

- New `backend/src/admin-workers/` module, controller, DTOs, service and explicit safe presenters implement the full worker route contract. `AppModule` registration is coordinated with the main implementation.
- `WorkerRegistryService` and `WorkerRecoveryService` share `controlRevision` write fencing with worker traffic. Label limit is 100. All management writes require fleet mode; legacy mode cannot report successful registry controls that its authentication ignores.
- Keys are generated only inside successful registration/idle-rotation transactions, stored only as SHA-256, returned once with no-store, and excluded from receipt/audit/list/detail data. Replays return a non-secret operation receipt. Lost keys require an explicit new idle rotation.
- Exact stopped recovery retains revoked state, old attempts, pinned inputs and original FIFO position. It requires current worker/job/attempt/session/generation/revision, an operator-observed termination statement and a stoppedAt no earlier than current attempt/worker activity. Heartbeat-only, nonresponsive-process, uncertain, stale and future evidence is rejected. Cancellation is finalized through the existing terminal service; administrative recovery does not invent a heartbeat.
- Optional audit `stopEvidence` metadata has an exact typed shape: attestation, stoppedAt, jobId, attemptId, sessionId and generation. Existing audit event representations are backward compatible. Bounded recent worker events expose only action/time/outcome, never credentials.
- Server-built Mongoose operator values are explicitly trusted. Regression checks actively enable sanitization; the installed Mongoose version moves the connection option into `db.config`, which its query casting path does not read, so setting the connection option alone is not sufficient test coverage.

Validation actually run:

- Initial new presenter test failed before its source existed; implementation then passed.
- `npm test -- src/admin-workers` — 5 tests passed, including safe presentation, cursor scope, proof validation, audit metadata and real Mongoose casting.
- `npm test -- src/admin-workers src/admin/admin-audit-query.spec.ts src/worker` — 69 tests passed on the final helper source.
- `npm run test:e2e -- test/admin-workers.e2e-spec.ts` — 7 tests passed, exercising every endpoint for all five roles, fresh-auth/no-store behavior and DTO validation.
- Root-coordinated `npm run build` — passed. `node --test test/admin-workers.integration.mjs` — 12 tests including the parent passed, with two independent API connections and active Mongoose sanitizer. Covers one-time keys, reservation retention, exact recovery, and both transaction commit orders for drain/claim, revoke/output, rotate/pending-poll and recover/finish.
- Scoped Prettier and `oxlint --deny-warnings` — passed. A final helper-only tightening rejects process heartbeat/response failure statements; its focused unit suite passes and it is included in the next main validation build.

Remaining external limits: all accounts, media and processes are synthetic fixtures. These tests do not prove Windows process termination, actual worker binary compatibility, live MongoDB/S3 behavior, dashboard UI or production liveness. Operator evidence is an attestation, not remotely verified operating-system telemetry.
