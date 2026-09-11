# D02: Administrator list, role changes and owner protection Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Let the owner manage the approved Google accounts and roles with clear permission and last-owner feedback.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D01](../dashboard/D01-dashboard-foundation-auth.md), [B03](../backend/B03-administrator-access-management.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/administrators/administrators-page.tsx`, `admin-access-form.tsx`, `role-permissions.ts`, `administrators-api.ts` and colocated component tests under `src/features/administrators/`.
- Create `dashboard/e2e/administrators.spec.ts`; add the owner-only route/navigation entry in `src/app/router.tsx`.

## Interfaces

Consume GET/POST /admin/access and PATCH /admin/access/:uid. Role labels and effective descriptions match scope.md; fresh reauthentication occurs before submission and the user explicitly confirms the pending change afterward.

## Steps

- [x] 1. Write component tests for role columns, active/inactive filtering, empty/error/loading list states, forbidden routes and role-to-permission explanations.

- [x] 2. Implement email lookup/add form with the five fixed roles. Explain an existing verified Google account is required; backend directory verification determines acceptance. Do not offer wildcard domains or client-created administrator identities.

- [x] 3. Implement role change and deactivate/reactivate dialogs showing target identity, current/new role, reason and impact. No hard delete; last-owner removal is disabled when known and backend remains authoritative.

- [x] 4. Handle stale auth with reauthentication and renewed explicit confirmation, revision conflicts by refreshing the exact record, and uncertain results by operation read-back. Do not silently retry a grant or overwrite a concurrent role change.

- [x] 5. On self-demotion/deactivation, clear session permissions immediately after confirmed success and return to the permitted route/sign-in. Other pages cannot retain forbidden data.

- [x] 6. Run keyboard/focus and integration fixtures for concurrent last-owner conflict, denied directory identity and permission loss. Confirm action records are visible in the owner audit page once D13 is present.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Support cannot navigate to Administrators or invoke access changes through a forged UI request.
Scenario 2: A last-owner conflict explains why the action failed and preserves current data.
Scenario 3: Self-deactivation removes the shell's privileged content without waiting for a full application restart.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/administrators
npm run test:e2e -- e2e/administrators.spec.ts
```

## Completion evidence

- [x] Owner access management is usable, revision-safe and consistent with the server's last-owner protection.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
