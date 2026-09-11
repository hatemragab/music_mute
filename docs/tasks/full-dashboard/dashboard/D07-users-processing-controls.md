# D07: User directory and processing suspension UI Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Provide support/owner account lookup and reversible processing restrictions without implying account deletion or login suspension.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D01](../dashboard/D01-dashboard-foundation-auth.md), [D06](../dashboard/D06-jobs-queue-operations.md), [B07](../backend/B07-user-search-processing-suspension.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/users/users-page.tsx`, `user-detail-page.tsx`, `processing-suspension-dialog.tsx`, `users-api.ts` and colocated component tests under `src/features/users/`.
- Create `dashboard/e2e/users.spec.ts` and permission-limited list/detail routes.

## Interfaces

Consume B07 UserSummary/detail and suspension/resumption endpoints. Display account status and processing suspension separately; no reset-password/impersonation/delete API is available.

## Steps

- [x] 1. Test exact UID/email and prefix query validation, debounced supported search, pagination reset, disabled/deleting/suspended combinations and users.read denial.

- [x] 2. Build user detail with name/email, account status, processing restriction, actual created/updated timestamps and job summary/links. Do not add unsupported location, billing, last login or device analytics.

- [x] 3. Implement suspend/resume dialog with reason, expected revision, fresh reauthentication and explicit impact text: new processing is blocked while existing jobs/results remain.

- [x] 4. Prevent disabled/deleting accounts from appearing restored by a resume success; reflect authoritative status after read-back. Do not expose account deletion through this dashboard.

- [x] 5. Handle concurrent deletion/role removal, stale revision and uncertain mutation outcomes without optimistic status changes. Preserve accessible focus and non-secret form content through conflict.

- [x] 6. Run dashboard flows showing user lookup -> filtered job list -> processing suspension -> new admission denial using fixtures/local API. Verify existing media/result access is not labeled deleted.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: A suspended active user displays Active account and Processing suspended as separate labels.
Scenario 2: Resume never changes a deleting account to active in the UI.
Scenario 3: Worker Manager and Viewer cannot view user email/name through direct routing.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/users
npm run test:e2e -- e2e/users.spec.ts
```

## Completion evidence

- [x] Support controls have clear processing-only semantics and preserve the established account lifecycle.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
