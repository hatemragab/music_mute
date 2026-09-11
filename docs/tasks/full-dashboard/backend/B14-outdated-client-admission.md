# B14: Enforce update requirements on new processing submissions Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Reject outdated new submissions while allowing accepted cloud work and stored results to survive mandatory updates.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B06](../backend/B06-processing-settings-admission.md), [B09](../backend/B09-admin-job-cancel-retry.md), [B13](../backend/B13-publish-withdraw-update-policy.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Modify backend/src/app-policy/processing-access.guard.ts, app-policy.service.ts; backend/src/jobs/jobs.controller.ts, jobs.service.ts and job-actions.service.ts where admission decisions apply.
- Create or extend backend/src/app-policy/processing-access.guard.spec.ts; backend/test/admin-update-admission.e2e-spec.ts and backend/test/admin-update-admission.integration.mjs.
- Update backend/docs/dashboard-api.md with exact admission boundary and existing client metadata requirements.

## Interfaces

Preserve current validated device/platform/build source and APP_UPDATE_REQUIRED response contract. Consume B13 policy; apply B06 accepted-reservation boundary. Mobile root gate/timers/installers remain owned by existing Android/iOS update plans.

## Steps

- [ ] 1. Enumerate every creation/upload-renewal/retry route and the established trusted client build metadata. Test missing/invalid metadata as currently defined; never trust an arbitrary role or platform header to bypass checks.

- [ ] 2. Block below-minimum new reservations, renewal and client retries through the common admission guard. Admin retry uses administrator authority and user/maintenance constraints, not an invented mobile installed version.

- [ ] 3. Allow valid previously issued upload reservations to confirm under their snapshots; preserve worker stage/output/finish APIs, notifications, cancellation, deletion and existing-result access. A policy change does not cancel a cloud job.

- [ ] 4. Keep app policy unavailable and invalid target behavior fail-safe for new admission while preserving already accepted work. Feature-disabled handling does not silently clear old minimum requirements.

- [ ] 5. Write before/after tests for publishing a forced policy while a job is queued/processing/uploading_result; verify ready output and owner linkage remain.

- [ ] 6. Cross-link mobile plan acceptance for full-app block, offline cached requirements, 15-minute checks and 24-hour Later. These API tests do not prove any mobile dialog, background service or installer behavior.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Build 9 cannot submit after minimum becomes 10, but its already processing job reaches ready.
Scenario 2: The worker completes an existing assignment without supplying a mobile build.
Scenario 3: An administrator retry respects suspension/maintenance without pretending to be an updated phone.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/app-policy src/jobs
npm run test:e2e -- test/admin-update-admission.e2e-spec.ts
npm run build
node --test test/admin-update-admission.integration.mjs
```

## Completion evidence

- [ ] Backend update enforcement matches the preserved-work contract and has an explicit mobile integration boundary.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
