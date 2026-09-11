# D14: Full dashboard integration, accessibility and completion review Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Prove the complete local dashboard works with the verified backend and document remaining external integration limits.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D02](../dashboard/D02-administrator-access-page.md), [D03](../dashboard/D03-overview-page.md), [D05](../dashboard/D05-worker-management-dialogs.md), [D06](../dashboard/D06-jobs-queue-operations.md), [D07](../dashboard/D07-users-processing-controls.md), [D08](../dashboard/D08-audio-preview-download.md), [D09](../dashboard/D09-release-editor-apk-upload.md), [D10](../dashboard/D10-update-policy-publication.md), [D11](../dashboard/D11-processing-settings-page.md), [D12](../dashboard/D12-health-alerts-page.md), [D13](../dashboard/D13-activity-audit-csv.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/e2e/full-dashboard.spec.ts`, `permissions.spec.ts`, `accessibility.spec.ts` and `backend-contract.spec.ts` using the D01 harness.
- Create `docs/validation/full-dashboard-local.md` and update `dashboard/README.md` with local commands and approved API configuration.
- Modify only owned browser tests, scripts and contract fixtures needed for validation; hosting files remain untouched.

## Interfaces

All B18 API fixtures and real isolated API endpoints; all five roles; browser viewport widths 360/768/1440. Test fixtures never replace the real server permission boundary in compiled backend integration.

## Steps

- [x] 1. Create end-to-end local workflows for owner access management, worker registration/drain/recovery, support user suspension/job retry/audio access, release upload/preview/publication/withdrawal, health acknowledgment and CSV/audit.

- [x] 2. Run one Playwright browser suite against deterministic contract fixtures for UI edge cases and a separate Playwright browser suite against the isolated compiled backend for real permission/concurrency/session proof. Tag fake S3/Firebase/verifier boundaries explicitly.

- [x] 3. Test each role on direct URLs and tampered API calls; mid-session revocation; expired auth; duplicate clicks; stale revisions; ambiguous writes; no raw secrets or signed URLs in logs/storage/snapshots.

- [x] 4. Check keyboard-only navigation, labels, focus return, error announcements, sufficient contrast in both themes, reduced-motion behavior, charts' text alternatives and responsive overflow. Do not add a dependency solely for a decorative visual.

- [x] 5. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` and `npm run build` once after fixes; inspect the final scoped diff and contract inventory. Do not run the separate MusicMute consumer apps, Windows tests or live cloud mutation as an incidental dashboard check.

- [x] 6. Write evidence with exact commands/revisions/results, API route/page coverage, package versions, local runtime prerequisites and remaining real-provider/media-range/mobile/Windows limits. Link original Android/iOS update and fleet plans for those separate owners. No hosting setup/deployment/publish/commit.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: All five roles see only their approved navigation and backend-forbidden calls remain denied.
Scenario 2: A complete local release flow ends with verified policy read-back, not merely a success toast.
Scenario 3: No dashboard flow auto-plays media, retries key issuance or frees a worker solely on heartbeat expiry.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Completion evidence

- [x] All planned dashboard pages/actions are verified locally with honest fixture/provider boundaries and a complete review record.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
