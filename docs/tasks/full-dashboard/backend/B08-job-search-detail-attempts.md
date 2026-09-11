# B08: Job search, queue view and attempt history Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Expose bounded operational job views with real stages, ownership and safe user/media projections.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B04](../backend/B04-fleet-ownership-foundation.md), [B07](../backend/B07-user-search-processing-suspension.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-jobs/admin-jobs.module.ts, admin-jobs.controller.ts, admin-jobs-query.service.ts, admin-jobs.presenter.ts, dto/admin-job-query.dto.ts and admin-jobs-query.service.spec.ts.
- Modify backend/src/jobs/job.schema.ts and lifecycle write paths to maintain a monotonic adminRevision, including job deletion/cancel/retry and worker progress/terminal writes.
- Create backend/test/admin-jobs-read.e2e-spec.ts, backend/test/admin-jobs-read.integration.mjs.

## Interfaces

GET /admin/jobs, /:id and /:id/attempts -> contract read models. API revision maps to a persisted adminRevision incremented on relevant visible/action-authority transitions; legacy missing value is zero until touched, with conflict-safe selectors.

## Steps

- [ ] 1. Write filter/cursor tests using all actual JOB_STATUSES, ID validation, [from,to) boundaries, same-timestamp tiebreakers, deleted jobs and filter changes with old cursors.

- [ ] 2. Implement lean bounded queries and declared indexes for status/time, owner/time and worker/time. Keep attempt history paginated and query plans inspectable; no unbounded population or result-object fetch per list row.

- [ ] 3. Present only persisted stage timestamps/durations and safe known errors. Queue position is computed for eligible queued work at observation time; return null when unavailable, never a guessed finish estimate.

- [ ] 4. Gate email/name fields by users.read and media names by media.read. No object keys, hashes, presigned URLs, worker credentials, full source URLs or private diagnostic stacks in list/detail.

- [ ] 5. Add/verify a revision increment across every state/action-authority writer without breaking existing worker event idempotency. Legacy __v alone is not reliable for updateOne/findOneAndUpdate; explicitly test these paths.

- [ ] 6. Run isolated pagination under inserts, same-time rows, old ownership records and malicious search values. Confirm read APIs cannot mutate status, enqueue jobs or mint audio URLs.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Jobs with identical createdAt values paginate without duplicates using the unique ID tiebreaker.
Scenario 2: A worker manager sees userId but no email/name or audio filename.
Scenario 3: An interrupted job reports its reserved attempt and recoveryRequired rather than a ready-to-retry control.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-jobs/admin-jobs-query.service.spec.ts src/jobs
npm run test:e2e -- test/admin-jobs-read.e2e-spec.ts
npm run build
node --test test/admin-jobs-read.integration.mjs
```

## Completion evidence

- [ ] Dashboard job views are truthful, permission-filtered and support safe subsequent revisioned actions.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
