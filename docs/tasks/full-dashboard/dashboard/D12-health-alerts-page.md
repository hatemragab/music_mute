# D12: System health, issue detail and alert acknowledgment Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Show actionable service/worker problems and acknowledgments without implying automatic recovery or sending external notifications.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D04](../dashboard/D04-workers-list-detail.md), [B16](../backend/B16-health-dashboard-alerts.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/health/system-health-page.tsx`, `health-component-cards.tsx`, `alerts-table.tsx`, `alert-detail.tsx`, `health-api.ts` and colocated component tests.
- Create `dashboard/e2e/health-alerts.spec.ts` and health route/navigation visibility.

## Interfaces

GET /admin/health, GET /admin/alerts and revisioned acknowledge. healthy/degraded/unavailable/unknown and active/resolved are different state dimensions; acknowledgment is separate.

## Steps

- [x] 1. Write component fixtures for not-yet-checked components, stale readings, mixed healthy/degraded status, active acknowledged alert and recovered condition.

- [x] 2. Build status cards with safe dependency labels and check timestamps; show no private hosts, URLs, key presence values or shell commands. Do not label unknown healthy.

- [x] 3. Build paginated severity/state alert filters and detail with first/last observation, resource link, acknowledgment and resolution state. Links require destination permissions.

- [x] 4. Implement reason-required acknowledgment with revision/operationId, clear server confirmation and conflict refresh. It cannot resolve a condition, resume a revoked worker or release an interrupted slot.

- [x] 5. Refresh visible health/alerts at 30 seconds, pause backgrounded applications and respect 429/Retry-After. Keep stale data visible with a banner and manual retry; avoid notification loops or platform notification permission prompts.

- [x] 6. Test recurring alert resets, two admins acknowledging, timeout UI and inaccessible destination links. Do not send email, push or Slack alerts.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: An acknowledged worker-recovery alert remains active until the backend condition resolves.
Scenario 2: A missing first probe displays Not checked instead of green Healthy.
Scenario 3: Backgrounded applications stop refreshing until foregrounded.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/health
npm run test:e2e -- e2e/health-alerts.spec.ts
```

## Completion evidence

- [x] Health and alerts remain factual, bounded and actionable within the dashboard only.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
