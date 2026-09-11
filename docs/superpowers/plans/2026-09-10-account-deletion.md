# Account Deletion Implementation Plan

> **Execution status:** Local implementation was authorized and completed on 2026-09-10. See the [implementation and validation record](../../validation/2026-09-10-store-readiness.md) for actual files, tests and outstanding release requirements. The original checklist below is retained as design history; proposed filenames and test commands may differ from the final implementation. Unresolved publication settings remain release blockers.

**Goal:** Delete a MusicMute account and its associated data through native app controls and an external request path, with durable recovery and truthful completion reporting.

**Architecture:** Add a deletion lifecycle to the existing NestJS API and reuse job cancellation, S3 version cleanup, Firebase auth, and session cleanup. Persist deletion intent before external operations and use bounded leased maintenance independent of processing enablement.

**Tech Stack:** NestJS/TypeScript, Mongoose/MongoDB, Firebase Admin/Auth, S3, Kotlin/Compose, Swift/SwiftUI, existing test frameworks.

**Spec:** [Store readiness design](../specs/2026-09-10-store-readiness-design.md).

## Global constraints

All Global constraints in the linked spec apply. No production deletion, deployment or commit is authorized. Both apps, backend and website are confirmed scope; domain/contact and retention questions remain in the spec. Test destructive behavior only with isolated/disposable fixtures.

## Task 1: Durable deletion request and access fence

**Modify:** `backend/src/users/user.schema.ts`, `users.service.ts`, `users.module.ts`, `users.controller.ts`; `backend/src/auth/auth.guard.ts`, `auth.errors.ts`, `firebase-identity.service.ts`; `backend/docs/auth-api.md`.

**Create:** `backend/src/users/account-deletion.schema.ts`, `account-deletion.service.ts`, `account-deletion.service.spec.ts`; `backend/test/account-deletion.e2e-spec.ts`.

**Proposed contract:** `DELETE /users/me`, empty body, existing bearer identity, server-validated authentication age at most 300 seconds. Identity comes from the token, never a client UID. Return `202 { requestId, status: "accepted" }` only after durable acceptance. Define `REAUTHENTICATION_REQUIRED` using the existing error envelope. Repeated same-account requests resolve to the existing request; permit that narrow path for an already-deleting identity without reopening normal APIs. A token rejected by Firebase requires the support/recovery path, not a bypass of token verification.

Persist states `accepted | cancelling | purging | completed`, retry metadata and an expiring cleanup lease. Errors retain the current stage for retry. Add `deleting` to the existing user status; do not equate deletion with ordinary disabling. Define internal `requestDeletion(userId: string): Promise<{ requestId: string; status: 'accepted' }>` and `advanceDeletion(now: Date): Promise<boolean>`.

- [ ] Write failing HTTP/service tests for stale auth, absent bearer, foreign account identifiers, repeat requests, concurrent requests, persistence failure, and restricted processing/email-verification policies.
- [ ] Implement schema registration and unique account-request indexing using the existing startup index mechanism. Record intent and account fence atomically before calling Firebase or S3.
- [ ] Ensure session bootstrap/profile sync cannot recreate or reactivate a deleting account. Fence each mutating/grant-issuing path transactionally or with conditional account generation checks; a guard-only check has a race with deletion acceptance.
- [ ] Refresh existing guard/profile/session tests and API examples. Verify deletion remains reachable without purchasing, processing approval or email-verification completion.
- [ ] Run `cd backend && npm test -- src/users/account-deletion.service.spec.ts` and `npm run test:e2e -- test/account-deletion.e2e-spec.ts`; inspect actual failure before implementation and passing evidence after it.

## Task 2: Recoverable cleanup across storage, jobs and identity

**Modify:** `backend/src/jobs/job-deletion.service.ts`, `job-actions.service.ts`; `backend/src/storage/storage-transfers.service.ts`; `backend/src/processing/processing-maintenance.service.ts`; relevant `backend/src/worker/` completion/claim paths; `backend/src/users/users.module.ts`.

**Create:** `backend/src/users/account-deletion-maintenance.service.ts`, `account-deletion-maintenance.service.spec.ts`; `backend/test/account-deletion.integration.mjs`; `backend/docs/account-deletion.md`.

**Interfaces:** maintenance consumes `advanceDeletion(now)` from Task 1. Add narrow internal adapters around existing cancellation and cleanup rather than accepting job IDs or S3 keys from a deletion client. Reuse `deleteVersionsForKey(key)` and the existing grant grace policy.

- [ ] Inventory account-linked profile, devices, installation ownership, push installations/deliveries/outbox, jobs, attempts, receipts, errors/reports, S3 versions, worker temporary files, caches and operational logs. Identify shared installation records and delete only entries still owned by this account.
- [ ] Write failing lifecycle tests: accepted request survives restart; concurrent replicas do not double-own cleanup; queued and active jobs stop; a completion racing deletion cannot restore a result; an S3/Firebase outage retries without declaring completion.
- [ ] Revoke refresh tokens and disable Firebase after durable fencing. Cancel work using existing worker protocol; reject new claims/grants for deleting accounts and fence existing completions. Never treat a timeout as proof the Windows process exited.
- [ ] Add bounded leased deletion sweeps that run even when audio processing is disabled. Preserve the API-only architecture and retry/backoff conventions.
- [ ] After active ownership and outstanding signed grants are safely resolved, sweep all account-owned S3 versions, including unconfirmed upload/output attempts. Ensure late uploads cannot recreate retained data after the final sweep.
- [ ] Purge associated database data in bounded batches after storage cleanup no longer needs its keys. Delete the Firebase user idempotently (already absent is success); retain the account fence until stale-token reprovisioning is impossible, then remove the profile. Treat unresolved worker copies/provider errors as incomplete cleanup.
- [ ] Define finite receipt/log retention, backup expiry and restore-time deletion replay in the runbook. Set the public completion timeframe only after the operator confirms these limits.
- [ ] Run `cd backend && npm run build && node --test test/account-deletion.integration.mjs` against isolated services, plus `npm run test:processing:integration` for cancellation/worker/storage regressions.

## Task 3: Native deletion controls and local cleanup

**Modify Android:** `android/app/src/main/java/com/hatem/musicmute/ui/auth/AccountScreen.kt`, `auth/AuthSessionCoordinator.kt`, `auth/AuthApiClient.kt`, `auth/AuthModels.kt`, `auth/FirebaseAuthGateway.kt`, `VocalApplication.kt`, and existing localized string resources.

**Modify iOS:** `ios/Vocal/UI/Auth/AccountView.swift`, `Auth/AuthSessionModel.swift`, `Auth/AuthAPIClient.swift`, `Auth/AuthModels.swift`, `Auth/FirebaseAuthGateway.swift`, `VocalApp.swift`, and existing localized resources.

**Create tests:** Android `android/app/src/test/java/com/hatem/musicmute/auth/AccountDeletionTest.kt`; iOS `ios/VocalTests/AccountDeletionTests.swift`. Extend existing account UI tests only for the authorized iOS target.

**Interfaces:** both API clients expose an async `deleteAccount` operation returning the Task 1 acceptance receipt. Session coordinators own reauthentication, generation checks, local purge and sign-out; UI widgets never invoke Firebase deletion directly.

- [ ] Write failing tests for cancelled confirmation/reauthentication, stale credentials, duplicate taps, account switching mid-request, lost response after acceptance, and cleanup interrupted by process death.
- [ ] Add accessible Delete account controls with clear scope and final confirmation. Reuse provider reauthentication (email/password, Google on Android, Apple on iOS); fetch a fresh ID token after reauthentication. Check current Apple token-revocation requirements before implementing the iOS branch.
- [ ] On accepted deletion, stop playback, local uploads/downloads and pending account operations; invalidate generation/epoch before purging so callbacks cannot recreate data. Clear only the deleting account's private staging, results/history, notification state and credential/session data.
- [ ] Persist a minimal local pending-deletion marker for restart recovery and ambiguous responses. Never display “deleted” because a request timed out. Show acceptance separately from confirmed backend completion, with the public support route available after sign-out.
- [ ] Other devices clear private account data when they next validate the revoked/deleted session. Document that an offline device cannot be remotely wiped immediately. Leave original Files/document-provider media, exported files and other-account data untouched.
- [ ] Unit-test the purge hooks with owned/foreign file fixtures; run the Android commands below and iOS unit/UI checks on the exact permitted simulator.

## Task 4: External deletion request and privacy resource

**Create proposed artifacts:** `docs/store/delete-account-page.md`, `docs/store/privacy-data-inventory.md`, `docs/store/account-deletion-support-runbook.md`. These are page content/runbook sources, not claims of a deployed website.

**Modify:** `backend/docs/account-deletion.md`; existing backend operations CLI only if adding an operator deletion command is needed. Reuse its authorization/access model; do not expose an unauthenticated deletion-by-email endpoint.

- [ ] Draft public `/delete-account` copy identifying the actual developer/app, data removed, retained data and periods, normal processing time, and an actionable monitored support email. Actual domain/contact and retention commitments require the answers in the spec.
- [ ] Specify the support flow: neutral acknowledgement, ownership verification through an approved existing provider/account channel, no password/token collection, authenticated operator request into Task 1, durable receipt, completion only after Task 2. Never delete based on a bare claimed email address.
- [ ] Draft privacy disclosures from the actual data inventory: Firebase auth, device/push data, uploaded source audio, private S3 output, Windows processing copies, error reports, retention and deletion. Reconcile each category with Data Safety answers.
- [ ] After the user selects the host/domain, implement the page in that host's maintained project and verify it anonymously, including submission/contact action. This plan does not authorize hosting or sending messages.
- [ ] Verify the page works without the app installed and does not redirect users back into the app to request deletion. Record the verified public URL for Play Console only after publication is separately authorized and completed.

## Task 5: Acceptance and handoff

- [ ] Backend: `cd backend && npm run verify`, `npm run test:auth:integration`, and the isolated deletion/processing integration commands above. Use scoped formatting; do not format unrelated dirty files.
- [ ] Android: `cd android && ./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest`. No Android emulator/device substitution is permitted by the current user instruction; report runtime UI proof as outstanding.
- [ ] iOS: `cd ios && xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" test`. If unavailable, report that blocker.
- [ ] With separately authorized disposable staging accounts: prove in-app request and support-assisted request both remove identity, jobs, object versions and worker temp data. Exercise one active job and one interrupted cleanup. Record backend/S3/Firebase evidence separately from mocked/unit results.
- [ ] Review diff and API docs, public-page accessibility, retention commitments and release disclosures. Do not claim Play approval or production deletion from local tests.

No tests in this document have been executed as part of drafting it.
