# Scheduled Account Deletion Recovery Implementation Plan

> **Execution status:** Implemented locally on 2026-09-11. No commit, push,
> deployment, Firebase operation, or production data mutation was performed.

**Goal:** Schedule every account deletion for irreversible cleanup after three
calendar months, let a deleting user request recovery after signing in, and give
authorized administrators a visible high-priority review and recovery workflow.

**Architecture:** Keep the existing durable deletion fence and maintenance worker.
Store the recovery deadline on the user, admit only dedicated recovery routes for a
deleting authenticated identity, store one request per deletion, and execute admin
decisions through the existing fresh-auth, permission, revision, operation-receipt,
audit, and MongoDB transaction boundaries.

**Tech stack:** NestJS/TypeScript/Mongoose, React/TypeScript/TanStack Query,
Kotlin/Compose, Swift/SwiftUI, Vitest, Node test, Playwright, Gradle, XCTest.

## Invariants

- There is no immediate-permanent-delete option or API.
- `recoverUntil` is three UTC calendar months after acceptance, with month-end
  clamping. No irreversible cleanup starts before that instant.
- A deleting account cannot use ordinary authenticated APIs. A valid Firebase
  session can only read/submit recovery state and retry the same deletion request.
- Recovery requests are idempotent for `(userId, deletionRequestId)` and the reason
  is optional, trimmed, and limited to 500 characters.
- Pending requests after their deadline are presented as expired and are excluded
  from the high-priority count.
- Only owner/support roles with `users.account-recovery.manage` can review. Decisions
  require fresh authentication, expected revision, UUID operation ID, and a review
  reason.
- Approval and identity-fence unblocking commit in the same MongoDB transaction.
  Approval clears deletion scheduling but preserves processing suspension.
- Once cleanup owns the account and changes it to `purging`, recovery is unavailable.

## Task 1: Backend lifecycle and user recovery API

- [x] Add the three-calendar-month deadline policy and persist recovery/purge timing.
- [x] Delay cleanup selection until the deadline and transition `deleting` to
      `purging` before irreversible work.
- [x] Add the recovery request schema and authenticated `GET`/`POST`
      `/users/me/account-recovery` routes.
- [x] Add stable `ACCOUNT_DELETION_PENDING` and `ACCOUNT_RECOVERY_EXPIRED` errors and
      a narrow recovery guard exception.
- [x] Remove recovery records during final account cleanup.
- [x] Cover deadline, idempotency, expiry, guard, and cleanup behavior with tests.

## Task 2: Administrator recovery API

- [x] Add `users.account-recovery.manage` for owner and support.
- [x] Add list, summary, detail, approve, and reject routes under
      `/admin/account-recovery-requests`.
- [x] Reuse fresh-auth, rate-limit, revision, operation-receipt, and audit contracts.
- [x] Restore the user and identity fence atomically on approval.
- [x] Add unit, controller-inventory, and replica-set transaction coverage.

## Task 3: Dashboard and native client flows

- [x] Add the dedicated dashboard queue, status filters, optional user reason,
      reviewed history, approve/reject dialogs, and visible-only refresh.
- [x] Add an accessible high-priority navigation count for active pending requests.
- [x] Route Android and iOS login bootstrap failures to a dedicated recovery screen
      with deadline, optional reason, submitted/review state, refresh/polling, and sign
      out.
- [x] Remove immediate-deletion wording and local controls from native disclosures.
- [x] Preserve English/Arabic localization parity and native session-generation
      protections.

## Task 4: Verification and release boundary

- [x] Run backend formatting, lint, typecheck, build, unit, HTTP e2e, and focused
      replica-set deletion/recovery integration tests.
- [x] Run dashboard typecheck, lint, build, unit, and complete Playwright coverage.
- [x] Run Android unit/lint/debug assembly with bounded Gradle workers.
- [x] Run iOS formatting, full unit tests, and the authorized iPhone 17 Pro/iOS 26.0
      simulator UI suite.
- [ ] Deploy the backend/dashboard/apps and validate a disposable live Firebase user,
      production MongoDB transaction behavior, notification delivery, and post-deadline
      provider/S3 cleanup. These actions require separate authorization and safe staging
      data.

Local tests establish implementation behavior only. They do not prove production
deployment, live dashboard notification delivery, Firebase/S3 cleanup, store-policy
acceptance, or backup-retention compliance.
