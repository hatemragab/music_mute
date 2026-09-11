# D04: Workers list and machine detail Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Present worker availability and assignment state without confusing offline with stopped or idle.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D01](../dashboard/D01-dashboard-foundation-auth.md), [B05](../backend/B05-worker-admin-controls.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/workers/workers-page.tsx`, `worker-detail-page.tsx`, `worker-status.ts`, `workers-api.ts` and colocated component tests under `src/features/workers/`.
- Create `dashboard/e2e/workers-read.spec.ts`; add worker list/detail routes to `src/app/router.tsx`.

## Interfaces

GET /admin/workers and /:id -> WorkerSummary/detail. Online, registration state, active slot and recoveryRequired are independent fields. Worker ID/label are distinct; legacy timestamps may be null.

## Steps

- [x] 1. Write fixtures for enabled+online, enabled+offline, draining+active, draining+idle, revoked+reserved and unknown lastSeen. Include owner, worker manager, support and viewer navigation behavior.

- [x] 2. Build paginated searchable-by-supported-fields list with ID, label, registration state, last seen, online flag, current job and recovery badge. Only expose filters actually accepted by the API; do not invent fuzzy search.

- [x] 3. Build detail with active job/attempt selectors, protocol version, safe recent events and explicit stale timestamp. Link job details only when jobs.read is present.

- [x] 4. Show explanatory text that an offline worker may still own unfinished processing; never enable a Retry/release button solely from age of heartbeat. D05 owns guarded actions.

- [x] 5. Use foreground-page refresh at 15 seconds with abort/coalescing and permission-loss handling; retain previous data as stale while retrying, never flicker a reserved slot to idle on fetch error.

- [x] 6. Run integration fixtures for 0/1/5/20 workers, pagination, responsive table/card behavior and missing historical fields. No CPU/GPU/RAM charts or remote-computer controls.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Offline plus activeAttemptId is shown as reserved work, not available capacity.
Scenario 2: A revoked worker with unfinished work remains visible with recovery required.
Scenario 3: Viewer can inspect worker metadata but no management control is offered.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/workers/workers-page.test.tsx
npm run test:e2e -- e2e/workers-read.spec.ts
```

## Completion evidence

- [x] Worker pages reflect separate liveness, registration and assignment facts from the backend.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
