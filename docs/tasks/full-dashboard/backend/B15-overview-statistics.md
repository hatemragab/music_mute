# B15: Overview metrics and bounded date-range aggregates Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Provide accurate processing and worker metrics from persisted facts, with clear time semantics and no invented analytics.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B05](../backend/B05-worker-admin-controls.md), [B08](../backend/B08-job-search-detail-attempts.md), [B11](../backend/B11-release-model-public-policy.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-observability/admin-observability.module.ts, admin-overview.controller.ts, admin-overview.service.ts, overview.types.ts and admin-overview.service.spec.ts.
- Add targeted job indexes if query explain results justify them; preserve existing indexes and do not auto-rewrite them.
- Create backend/test/admin-overview.e2e-spec.ts and backend/test/admin-overview.integration.mjs.

## Interfaces

GET /admin/overview from contracts.md. Mean queue wait uses queuedAt -> valid start; mean processing uses actual persisted processing interval. Return sampleCount and null timing where missing; current queue and historical interval are separate fields.

## Steps

- [ ] 1. Define fixtures across UTC midnight, requested timezone offsets, missing/invalid timestamps, retried jobs, cancelled jobs and empty ranges. Specify submitted/finished cohorts separately rather than dividing unrelated totals into a fake success rate.

- [ ] 2. Implement [from,to) 90-day maximum and daily series. processingActiveUsers counts distinct submitting users, not application DAU. Exclude deleted personal fields and do not expose per-user tracking.

- [ ] 3. Aggregate queue/worker status at asOf and historical counts over the requested interval. Preserve unknown duration as null. Optional release summary is omitted if the actor lacks releases.read.

- [ ] 4. Use indexed bounded aggregations with deadlines and a short cache keyed by exact filters/permission projection; do not cache across privileged field scopes. Degraded dependencies surface explicit partial/unavailable metrics, never fabricated zero.

- [ ] 5. Inspect query plans on isolated realistic-size fixtures and record scanned/indexed behavior. Avoid per-job S3 probes, full history scans for each refresh or materialized counters without repair semantics.

- [ ] 6. Test each role's projection, invalid dates, empty datasets and old singleton worker history. Publish metric definitions alongside API docs.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: A failed retry counts as its own submission; source history is not overwritten.
Scenario 2: No recorded processing duration yields meanProcessingSeconds=null and sampleCount=0.
Scenario 3: A release manager can view aggregate workload without receiving user identities or forbidden worker details.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-observability/admin-overview.service.spec.ts
npm run test:e2e -- test/admin-overview.e2e-spec.ts
npm run build
node --test test/admin-overview.integration.mjs
```

## Completion evidence

- [ ] Overview numbers have reproducible definitions, bounded queries and honest missing-data behavior.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
