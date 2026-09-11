# D08: Private input/result playback and download Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Let permitted administrators explicitly play/download original input or vocals result while keeping temporary access out of persistent application state.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [D06](../dashboard/D06-jobs-queue-operations.md), [B10](../backend/B10-private-media-access.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/src/features/jobs/job-media-panel.tsx`, `admin-audio-player.tsx`, `media-access-dialog.tsx`, `admin-media-api.ts` and colocated component tests. Use the browser HTMLAudioElement and standard download links; no native audio package is required.
- Create `dashboard/e2e/job-media.spec.ts` and synthetic media fixtures under `src/test/fixtures/`; connect the panel to `job-detail-page.tsx`.

## Interfaces

POST /admin/jobs/:id/media-grants returns a 300-second MediaGrant for input/result and play/download. UI requires media.read+jobs.read and fresh authentication; backend remains authoritative.

## Steps

- [x] 1. Test permissions, separate input/result availability, unverified/missing media, stale authentication and account deletion. Seed synthetic short audio only; never use real user files in browser automation.

- [x] 2. Show explicit Play input, Play vocals result and Download actions with a short reason entry. Request a grant only after the action and reauthentication when needed; no autoplay, hover prefetch or background grant creation.

- [x] 3. Use a native `<audio controls>` element behind an injectable player adapter with accessible labels and keyboard controls. Keep the issued URL only in transient component memory, support seeking/range playback where supported, show loading/error/expired states, and stop/clear prior audio when switching jobs or assets.

- [x] 4. Download through the grant's attachment destination without forwarding Firebase credentials or persisting blobs/URLs. Inform the operator which asset is being downloaded; audit is issuance evidence, not proof of completed transfer.

- [x] 5. When a grant expires or playback gets an authorization/missing-object error, stop and offer explicit renewed access. Do not loop grant requests. On logout, permission removal or route exit, pause, clear src and discard grant data; no service-worker caching.

- [x] 6. Test codec-not-supported with a useful download alternative, 410 deletion/missing object, range/seek on local fixture server and no automatic playback. Disable traces/screenshots that could retain live signed URLs; fixture traces use synthetic grants only.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Entering a job page makes no media-grant request until the administrator taps Play or Download.
Scenario 2: Switching to another job stops the previous audio and clears its source URL.
Scenario 3: Expired access offers Renew access; it never silently creates unlimited new grants.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/features/jobs/job-media-panel.test.tsx
npm run test:e2e -- e2e/job-media.spec.ts
```

## Completion evidence

- [x] Authorized media access works through explicit actions, temporary grants and clean player and application teardown.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
