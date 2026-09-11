# D06: Jobs table, attempt timeline and cancel/retry flows Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Give authorized operators detailed queue/job diagnostics and correct lifecycle actions.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D01](../dashboard/D01-dashboard-foundation-auth.md), [D04](../dashboard/D04-workers-list-detail.md), [B09](../backend/B09-admin-job-cancel-retry.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/jobs/jobs-page.tsx`, `job-detail-page.tsx`, `job-attempt-timeline.tsx`, `job-action-dialog.tsx`, `jobs-api.ts` and colocated component tests under `src/features/jobs/`.
- Create `dashboard/e2e/jobs.spec.ts` and list/detail routes; reuse date-range and status components.

## Interfaces

Consume job list/detail/attempts from B08 and action responses from B09. Known status union comes from contracts.ts; revisioned cancel/retry use operation receipts, not speculative state changes.

## Steps

- [x] 1. Test filters by status/userId/workerId/jobId/date, cursor reset on filter changes, missing timestamps and full known status set. No arbitrary queue reorder or delete controls.

- [x] 2. Build paginated list/detail with opaque IDs, allowed identity expansion, real stage timing and last error. Page attempt history independently; distinguish failed source from linked retry job.

- [x] 3. Show queuePosition as observed position, never a guaranteed completion estimate. Current active state refreshes every 10 seconds while visible, coalescing/aborting requests and preserving stale data on failures.

- [x] 4. Implement reason-required cancellation dialog; show cancel_requested until confirmed terminal state. Retry only eligible failed jobs with reusable input; NEW_INPUT_REQUIRED explains why a new client upload is needed.

- [x] 5. On successful retry, link to the new queued job and leave source history unchanged. For 409 refresh details; for uncertain mutation read receipt then current job. Interrupted work links to worker recovery only for workers.recover.

- [x] 6. Test simultaneous cancel/complete, repeated click, API error, suspension/maintenance retry denial, forbidden role and narrow keyboard-accessible layouts.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Clicking Cancel on a processing job displays cancellation requested rather than cancelled.
Scenario 2: Retry opens the new job ID returned by the server without changing the source row to queued.
Scenario 3: A recovery-required job exposes no ordinary Retry action.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/jobs
npm run test:e2e -- e2e/jobs.spec.ts
```

## Completion evidence

- [x] Job operations mirror real server state and preserve FIFO/history while exposing useful diagnostics.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
