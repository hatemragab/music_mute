# D13: Owner activity log and filtered CSV export actions Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Make privileged history inspectable and allow authorized operators to export the exact selected operational dataset.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D03](../dashboard/D03-overview-page.md), [B02](../backend/B02-audit-operation-receipts.md), [B17](../backend/B17-csv-exports.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/activity/activity-log-page.tsx`, `audit-event-detail.tsx`, `activity-api.ts` and colocated component tests.
- Create `src/components/export-csv-button.tsx`, `src/api/csv-download.ts`, their colocated component/unit tests, and `e2e/activity-exports.spec.ts`; integrate export actions into overview/jobs. Use browser Blob/object-URL download handling without an additional download package.

## Interfaces

GET /admin/audit owner-only; jobs/overview CSV endpoints require exports.read plus source-read grant. Exports inherit current URL filters and fixed server columns; no custom sensitive field selection.

## Steps

- [x] 1. Test owner-only audit routing, date/actor/action/resource filtering, cursor reset and safe before/after revision metadata. Render reasons as plain text; never assume raw payload or secret data exists.

- [x] 2. Build paginated log with timestamp/timezone, actor UID, action, resource and reason, and links only where permitted. No log deletion/edit controls.

- [x] 3. Add export button on jobs/overview with current range/filter summary, downloading/progress status and disabled duplicate invocation. Keep CSV bytes transient: download a Blob through a temporary object URL, then revoke it after the browser consumes the click and on teardown. Do not persist an in-app export library.

- [x] 4. Handle 401/403/429 and EXPORT_TOO_LARGE clearly, suggesting narrower filters without silently changing them or accepting truncated output. Preserve filenames/content type from trusted response handling.

- [x] 5. Verify export requires both permissions even when a page itself is readable. No audio export, personal-field picker or stored exported-file library.

- [x] 6. Run fixtures for empty CSV, cap exceeded, formula-neutralized cells, network failure and audit filter navigation. Assert no signed URL/key/media name appears in audit UI or exported fixture headers.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: CSV uses the currently selected date and job-status filters, not a default all-time dataset.
Scenario 2: 10,001-row rejection produces an actionable error instead of a partial download.
Scenario 3: A non-owner with export permission can export jobs but cannot open the Activity Log.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/activity src/components/export-csv-button.test.tsx src/api/csv-download.test.ts
npm run test:e2e -- e2e/activity-exports.spec.ts
```

## Completion evidence

- [x] Audit history stays owner-scoped and CSV actions faithfully preserve filters and privacy bounds.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
