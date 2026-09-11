# D03: Overview cards, charts and date filters Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Show the actual system workload and release summary with understandable metrics and missing-data states.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D01](../dashboard/D01-dashboard-foundation-auth.md), [B15](../backend/B15-overview-statistics.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/overview/overview-page.tsx`, `overview-cards.tsx`, `job-series-chart.tsx`, `overview-api.ts` and colocated component tests under `src/features/overview/`.
- Create `src/components/date-range-filter.tsx` and `e2e/overview.spec.ts`; use Recharts only after D01 verifies compatibility, and retain an accessible textual equivalent.

## Interfaces

GET /admin/overview with explicit from,to,bucket=day. Fields are those finalized by B15; processingActiveUsers label is 'Users who submitted jobs', not DAU. Null timing has a descriptive unavailable state.

## Steps

- [x] 1. Write fixtures for empty, healthy, no-workers, degraded and legacy-missing-timing responses. Verify cards never convert unknown timing into zero or show forbidden release data.

- [x] 2. Build submitted/completed/failed/cancelled cards, current queue/worker summary and historical daily chart. Label current values and date-range values separately, with last-updated time and timezone.

- [x] 3. Implement date presets Today/7 days/30 days/custom <=90 days as URL-backed filters and UTC interval requests. Preserve selected range on navigation and validate invalid/backward dates.

- [x] 4. Use Recharts after dependency review, with semantic labels and a textual/table equivalent. Provide keyboard-readable labels and color-independent status cues.

- [x] 5. Poll visible overview reads no faster than 30 seconds; pause backgrounded applications, coalesce requests, abort obsolete filter fetches and show stale data with retry on error. Expose contextual links only when the actor can open the destination.

- [x] 6. Test race between filter changes, timezone day boundaries, permission-scoped release cards and narrow layouts; format elapsed durations consistently and avoid invented completion estimates.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Missing processing timestamps display 'No timing data' instead of 0 seconds.
Scenario 2: Changing the range while a request is pending cannot render the old range's response.
Scenario 3: A user without releases.read sees no release card, even if a fixture accidentally includes releaseSummary.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/overview
npm run test:e2e -- e2e/overview.spec.ts
```

## Completion evidence

- [x] Overview answers whether processing is working, who is waiting and what needs attention using documented metrics.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
