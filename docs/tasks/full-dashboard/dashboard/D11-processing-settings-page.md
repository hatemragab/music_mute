# D11: Processing limits and maintenance settings Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Expose approved admission settings and maintenance messages without changing accepted work or hiding hard technical ceilings.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D01](../dashboard/D01-dashboard-foundation-auth.md), [B06](../backend/B06-processing-settings-admission.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/settings/processing-settings-page.tsx`, `processing-settings-form.tsx`, `settings-api.ts` and colocated component tests.
- Create `dashboard/e2e/settings.spec.ts` and a route visible with `settings.read`; edits require `settings.manage`.

## Interfaces

GET/PUT /admin/settings/processing. Values use exclusive bytes/seconds; maxActiveJobsPerUser null is Unlimited. No model, output stem, retention, host power or billing controls.

## Steps

- [x] 1. Test initial 30,000,000-byte/600-second exclusive ceilings, null/unlimited active limit, invalid numerics, Arabic optional message and English required message when admissions are closed.

- [x] 2. Build form with exact units and exclusive-bound helper text, retaining exact bytes in submitted data. Show current mobile maximums so users understand lowering is supported but raising above existing capability is rejected.

- [x] 3. Add admission open/paused control, English message and optional Arabic translation. Explain that valid already accepted reservations/jobs continue and existing results remain available.

- [x] 4. Provide read-only view to allowed non-owner roles, dirty-state navigation protection and before/after confirmation with reason for owner updates.

- [x] 5. Handle revision conflicts by showing current server settings and preserving the unsaved draft for deliberate reapplication. Fresh-auth flow does not automatically save after reauthentication.

- [x] 6. Test locale numeric entry, keyboard errors, mobile layouts and backend maximum/admission errors. Do not add retention cleanup or automatic job cancellation.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Unlimited submits null rather than zero or a made-up high integer.
Scenario 2: Pausing shows that existing jobs finish and results remain available.
Scenario 3: A viewer can read settings but cannot edit them by manipulating form controls.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/settings
npm run test:e2e -- e2e/settings.spec.ts
```

## Completion evidence

- [x] Processing settings communicate exact admission effects and respect backend limits.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
