# D09: Release list, draft editor and APK upload verification Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Create/edit release drafts and upload signed APKs with actual progress and verification status before publication.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D01](../dashboard/D01-dashboard-foundation-auth.md), [B12](../backend/B12-apk-upload-verification.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/releases/releases-page.tsx`, `release-detail-page.tsx`, `release-draft-form.tsx`, `apk-upload-panel.tsx`, `releases-api.ts`, `apk-upload.ts` and colocated component tests.
- Create `dashboard/e2e/releases-upload.spec.ts` and synthetic artifact fixtures; add release list/detail routes. Use a native file input with APK selection filtering and validate the selected File independently of the picker hint.

## Interfaces

Consume B11 drafts/list and B12 upload reservation/complete/status. Platform/source/build/changelog fields are contract-typed. Draft lifecycle and artifact lifecycle are shown separately; D10 owns publication.

## Steps

- [x] 1. Test Android direct/Play and iOS App Store field combinations, positive integer build, plain-text English changelog, store link validation and duplicate version/build conflicts.

- [x] 2. Implement paginated list and draft/detail form with dirty-form navigation warning and published-content read-only state. Display checksum/signer/size/verification result as returned data, not trust claims derived from file name.

- [x] 3. Validate APK size <=256 MiB locally, compute SHA-256 incrementally in a Web Worker using a reviewed open-source hashing package with bounded file chunks, then reserve upload and send only the returned S3 form fields and selected File in FormData. Create `src/features/releases/apk-hash.worker.ts` with cancellation and error handling. Use XMLHttpRequest upload progress and abort for byte progress/cancellation; do not buffer a full APK or attach the Firebase bearer to S3.

- [x] 4. Show reserved/uploading/verifying/verified/rejected phases and actual byte progress. Upload cancellation stops the client transfer without publishing or deleting remote data. Failed/expired reservation requires explicit new reservation after inspecting current draft.

- [x] 5. Finalize by upload ID and poll verification status with bounded backoff up to the documented 120-second UI request/wait budget. Surface safe verifier error codes and Retry/Refresh; verified means server confirmation, not 100% transfer.

- [x] 6. Handle unknown completion response by status read-back, revision conflicts by refresh, auth loss by stopping upload, and no bearer forwarding to S3. Do not enable publication for unverified artifacts.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: A 100% uploaded APK remains Verifying until the server reports verified.
Scenario 2: An incorrect signer shows rejection and no Publish action becomes eligible.
Scenario 3: Selecting Google Play removes the APK upload path instead of silently keeping an old upload target.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/releases/release-draft-form.test.tsx
npm run test:e2e -- e2e/releases-upload.spec.ts
```

## Completion evidence

- [x] Release drafts and binary verification are actionable and clearly distinct from publication.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
