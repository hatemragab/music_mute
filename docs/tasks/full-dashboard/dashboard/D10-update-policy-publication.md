# D10: Update policy preview, publication and withdrawal Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Let release managers control platform minimums and channel targets with an understandable before/after preview.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D09](../dashboard/D09-release-editor-apk-upload.md), [B13](../backend/B13-publish-withdraw-update-policy.md), [B14](../backend/B14-outdated-client-admission.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/releases/update-policy-page.tsx`, `update-policy-form.tsx`, `policy-preview.tsx`, `publish-release-dialog.tsx`, `withdraw-release-dialog.tsx`, `update-policy-api.ts` and colocated component tests.
- Create `dashboard/e2e/update-policy.spec.ts` and add the release-policy route.

## Interfaces

Consume policy read/preview/publish/withdraw plus safe operation read-back. One platform minimum with channel-specific targets; exact revisions and complete replacement selections are passed to backend.

## Steps

- [x] 1. Write tests for minimum 10/target 12 sample decisions, direct+Play target compatibility, iOS store target, absent policy and invalid target below minimum.

- [x] 2. Build platform-separated form showing minimum supported build, current target for each channel and Android source. Explain required versus optional by numeric builds; no misleading independent force toggle that conflicts with minimum.

- [x] 3. Render English changelog and mobile-message preview as escaped text, current versus proposed policy and sample installed-build decisions from the preview endpoint. Preview makes no write.

- [x] 4. Require verified artifact or explicit store availability confirmation, fresh reauthentication, reason and a final concrete summary before publication. Prevent stale preview/revision from silently publishing; refresh and require review again.

- [x] 5. Implement withdrawal with replacement policy/minimum review and explanation that it changes update requirements but cannot downgrade installed apps. Preserve release history; no delete APK button.

- [x] 6. Handle uncertain publication by operation/policy read-back rather than automatic resend. Verify optional 24-hour reminders and 15-minute checks are described as existing mobile behavior, not editable switches or proof of mobile implementation.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: The form explains build 9 is forced and build 10 is optional for minimum 10/latest 12.
Scenario 2: A concurrent policy change requires a new preview before the operator can publish.
Scenario 3: Withdrawing a release never claims that an installed phone has been downgraded.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/releases/update-policy-page.test.tsx
npm run test:e2e -- e2e/update-policy.spec.ts
```

## Completion evidence

- [x] Release policy changes are concrete, reviewable, concurrency-safe and consistent across channels.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
