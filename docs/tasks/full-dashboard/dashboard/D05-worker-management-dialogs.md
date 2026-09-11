# D05: Worker registration, credentials, drain and recovery UI Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Provide guarded operator workflows for real worker lifecycle changes with safe one-time credentials.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D04](../dashboard/D04-workers-list-detail.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/workers/worker-registration-dialog.tsx`, `worker-key-dialog.tsx`, `worker-action-dialog.tsx`, `worker-recovery-dialog.tsx` and colocated component tests.
- Extend `workers-api.ts` and the detail page; create `dashboard/e2e/workers-actions.spec.ts`.

## Interfaces

Consume B05 registration/rename/drain/enable/rotate/revoke/release-stopped routes. Every write has operationId and appropriate revision/reason; key/recovery mutations require fresh authentication.

## Steps

- [x] 1. Test every action's visibility and eligibility from permissions and actual state. Provide ID/label validation on create and label rename; backend decides conflicts and state authority.

- [x] 2. Implement one-time key dialog with explicit Copy and acknowledgment before close. Hold key in component memory only; no URL parameters, local/session storage, console/error analytics, operation receipts or automated screenshot traces of real keys.

- [x] 3. For lost create/key response, read the safe operation/worker state and explain the key cannot be retrieved. Offer a separately confirmed idle rotation when eligible; never replay issuance automatically.

- [x] 4. Build drain progress showing current job finishes before idle, enable only for non-revoked registrations, idle-only rotation and emergency revoke dialog showing that active work remains reserved.

- [x] 5. Build stopped-recovery form showing exact job/attempt/session/generation and requiring observed stoppedAt, detailed stopEvidence and reason. Refresh before submission, require fresh auth and explicit acknowledgment; no auto-filled heartbeat proof or remote process kill.

- [x] 6. Test stale revisions, in-flight completion, revoked credentials, canceling dialogs and permission loss. Show 409 current-state updates, preserve non-secret draft reasons and clear raw key on any exit.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Closing or signing out from the key dialog removes the raw key from application state.
Scenario 2: An uncertain registration result offers inspection rather than repeating POST /admin/workers.
Scenario 3: Recovery cannot submit with an offline checkbox alone; exact stopped evidence and current assignment are required.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/workers/worker-actions.test.tsx
npm run test:e2e -- e2e/workers-actions.spec.ts
```

## Completion evidence

- [x] Operators can safely administer workers without accidental duplicate issuance or unsafe lease recovery.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
