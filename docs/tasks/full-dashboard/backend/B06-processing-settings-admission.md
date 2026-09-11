# B06: Editable processing settings and admission fences Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Make maintenance and bounded processing limits editable without rejecting already accepted work or racing per-user limits.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B02](../backend/B02-audit-operation-receipts.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-settings/processing-settings.schema.ts, processing-settings.service.ts, admin-settings.controller.ts, admin-settings.module.ts, dto/processing-settings.dto.ts and processing-settings.service.spec.ts.
- Modify backend/src/jobs/jobs.service.ts, job-actions.service.ts, job-state.ts, job.schema.ts, enqueue.service.ts; backend/src/worker/worker-coordinator.service.ts for measured-duration validation; backend/src/processing/processing-transactions.ts and compatible public availability presentation.
- Create backend/test/admin-settings.e2e-spec.ts, backend/test/admin-admission.integration.mjs; modify existing job admission tests.

## Interfaces

GET/PUT /admin/settings/processing -> ProcessingSettings. A shared admission service evaluates settings and user processing suspension in the same transactional fence. Each accepted job stores effective reservation limits; the initial null active-job cap preserves legacy behavior.

## Steps

- [ ] 1. Write boundary tests for exclusive byte/duration maxima, optional Arabic message, null versus finite active-job limit and invalid attempts to exceed current worker/mobile limits. Seed current behavior, not new restrictive defaults.

- [ ] 2. Implement a revisioned settings record with audited owner updates. On missing stored settings, use current behavior without writing automatic migrations. Preserve environment feature/readiness switches as stronger technical gates.

- [ ] 3. Enforce admission in creation, renewal and retry paths with a shared writable admission/fence record per user and policy revision touch. Concurrent submissions must serialize before checking active count; terminal/deletion transitions must not leave stale quota accounting.

- [ ] 4. Snapshot limits on accepted reservations. Validate declared size/duration at admission, actual pinned upload size at confirmation, and worker-measured duration against the same snapshot before separation; client declarations alone cannot enforce a lowered duration ceiling. Maintenance/suspension closes new reservations and renewal/retry; a valid previously issued reservation can confirm/queue within its recorded expiry. Do not cancel queued/active jobs or block existing downloads.

- [ ] 5. Expose GET /processing-policy with the additive contract in contracts.md, reusing effective settings and existing readiness authority. Keep strict existing client JSON unchanged. The endpoint supplies future mobile policy consumers; mobile adoption is recorded in linked mobile work and is not part of this dashboard task.

- [ ] 6. Test both commit orders of admission versus settings change, quota races, upload confirmation after pause, expired reservations and legacy documents with no snapshot. Use immutable legacy ceilings as the fallback for already accepted records.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: With cap=1, two simultaneous creates by one user accept at most one reservation.
Scenario 2: Changing maximum duration from 600 to 300 does not invalidate a valid previously accepted 500-second reservation.
Scenario 3: Maintenance rejects new work but an already queued job completes and its result remains readable.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-settings src/jobs/job-state.spec.ts src/jobs/job-actions.service.spec.ts
npm run test:e2e -- test/admin-settings.e2e-spec.ts
npm run build
node --test test/admin-admission.integration.mjs
```

## Completion evidence

- [ ] Settings are transactional, backward-compatible and cannot silently increase worker/mobile limits.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
