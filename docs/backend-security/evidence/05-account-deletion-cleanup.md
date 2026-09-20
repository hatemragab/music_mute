# Branch 5 checkpoint report: account deletion and permanent cleanup

## Identity

- Assigned branch: `hatem/account-deletion-cleanup`
- Collection branch: `codex/backend-security-cost-hardening`
- Merged predecessor PR: <https://github.com/hatemragab/music_mute/pull/13>
- Starting collection commit: `daad109f646400440714c12c175e3e12ac3442de`
- Tested implementation commit: `7b35761a26f8d2482f1a96b39075a2c7b4afaed7`
- Pull request URL/base: https://github.com/hatemragab/music_mute/pull/14 / `codex/backend-security-cost-hardening`
- Date/time with timezone: 2026-09-20 EEST
- Environment: local macOS isolated worktree, isolated MongoDB/Redis, Firebase and
  S3 test doubles, Android JVM/build tools, and the authorized iPhone 17 Pro iOS
  26.0 simulator for unit tests only

## Progress

- Branch status: `MERGED`
- Completed checkpoints: E1, E2, E3, E4, E5, E6
- Merge commit: `b0b69a6d57021a86327bf438acab360ad2098633`
- Post-roadmap boundary: any merge to `main` or deployment requires separate
  maintainer authorization
- Blocking input: none

## Delivered behavior

| Checkpoint | Result |
| ---------- | ------ |
| E1 | `recoverUntil` is exactly `acceptedAt + 15 * 24 hours`. Recent-authentication and identity fences remain, duplicate requests retain one operation/deadline, and before/exact/after boundaries are tested. |
| E2 | A deleting account can use only deletion status/recovery paths. New jobs, upload/download grants, retries, worker claims, and normal account routes remain blocked; maintenance cancels and fences active work without deleting grace-period data. Recovery restores the same account and leaves jobs, usage, reservations, overrides, events, and restrictions unchanged. |
| E3 | Purge reconciles exact job input/output keys and stale-attempt output versions, then removes account-owned jobs, errors, notifications, devices, installations, usage/grants/reservations, override, abuse data, restriction, recovery records, storage tasks, Firebase identity, and personal profile. No prefix, bucket, database, or Redis-wide deletion exists. |
| E4 | Durable `identity`, `jobs`, `records`, `provider`, and `profile` phases use a lease token and records cursor. Missing Firebase users are success, transient dependency errors become only `DEPENDENCY_RETRY`, recovery is impossible after `purging`, and the final tombstone is non-personal. |
| E5 | Android/iOS receipts and journals preserve the exact backend deadline, English/Arabic copy uses fifteen days, dashboard account/recovery views show phase and safe retry state, the public page and repository/mobile docs agree, and the operations guide separates unchecked provider work. |
| E6 | Backend, isolated integrations, dashboard, Android, focused iOS, privacy, stale-copy, JSON, link, secret, and whitespace gates were exercised. The unrelated broader iOS failures are recorded below. |

## Durable purge inventory

| Owner path | Cleanup rule |
| ---------- | ------------ |
| `audio_jobs` | Cancel/fence active execution, settle usage, clean exact input/output keys, then delete only after job cleanup completion. |
| `worker_attempts`, `audio_job_errors` | Page by owned job; schedule attempt reservation keys and pinned output versions before deleting attempt/error records. |
| `audio_notification_outbox`, `audio_notification_deliveries` | Delete deliveries before each bounded job/user outbox record. |
| `user_devices`, `device_installation_owners`, `push_registrations`, `client_errors` | Page by `userId`; ownership filters preserve transferred/foreign records. |
| `account_recovery_requests` | Page by `userId` after the irreversible purge fence. |
| `account_usage_periods`, `account_daily_usage_periods`, `processing_reservations` | Page by `accountId`; no counter reset occurs during recovery. |
| `upload_grant_receipts`, `download_grant_receipts` | Remove job children first, then any remaining account receipts. |
| `account_policy_overrides` | Remove only the deleting account's replacement override. |
| `abuse_event_buckets`, `abuse_monthly_summaries`, `account_restrictions` | Remove all branch 4 account-owned protection records during permanent purge only. |
| `storage_cleanup_tasks` | Wait until no owner task is pending, then remove completed owner tasks. |
| `users`, Firebase Auth, `user_identity_fences` | Delete Firebase through the safe provider boundary, retain only the short-lived hashed replay fence, write the tombstone, then remove the personal profile. |
| Redis budgets | HMAC-keyed counters are TTL-bound and non-authoritative; no unsafe key scan or broad Redis deletion is added. |

Global service usage, application policies, worker machines/slots, releases,
administrator audit/operation records, and service health documents are not account
ownership stores and are not broadly deleted.

## Minimal tombstone

`account_deletion_tombstones` contains only:

- the random deletion request ID as `_id`;
- accepted and completed timestamps;
- terminal status `purged`;
- schema version `1`.

Unit and isolated MongoDB integration tests assert the exact field set. The schema
and writer contain no account ObjectId, email, display name, Firebase UID, device or
installation ID, IP, media name, object key, checksum, quota/abuse data, or note.

## Verification evidence

| Directory | Command | Exit | Result |
| --------- | ------- | ---: | ------ |
| `backend` | Five-file focused deletion/recovery baseline | 0 | 5 files / 27 tests passed before changes |
| `backend` | `pnpm run verify` | 0 | Format, lint, typecheck, tracked-secret scan, 110 files / 772 unit tests, 23 files / 140 HTTP E2E tests, and build passed |
| `backend` | `pnpm run test:integration` | 0 | 1 authenticated Redis outage/recovery integration passed |
| `backend` | `pnpm run test:auth:integration` | 0 | 18 Firebase/MongoDB/Redis/auth integrations passed |
| `backend` | `pnpm run test:processing:integration` | 0 | 15 jobs/usage/notification/abuse integrations passed |
| `backend` | `pnpm run test:dashboard:integration` | 0 | 23 administrator/dashboard workflow integrations passed |
| `backend` | `pnpm run test:deletion:integration` | 0 | 3 request/recovery/leased purge integrations passed, including provider retry, replica competition, foreign ownership, and tombstone shape |
| `dashboard` | `npm run format:check && npm run lint && npm run typecheck && npm test -- --run && npm run build` | 0 | 16 files / 51 tests and production build passed |
| `android` | Direct and Play debug unit, lint, and assemble Gradle tasks | 0 | Both variants passed; ignored Firebase config was linked temporarily without reading or committing it |
| `ios` | `swift-format lint` plus `only-testing:VocalTests/AccountDeletionTests` on simulator `3CC14436-EC3C-4419-A079-C84951E5FA07` | 0 | Format passed and 2 focused durable store/purge tests passed |
| `ios` | Full `VocalTests` on the same authorized simulator | 65 | All 15 deletion/recovery tests passed; 40 unrelated audio preparation/pipeline/job/upload tests failed and remain outside this branch |
| repository root | Branch-manifest JSON parse, scoped backend-security/deletion-doc relative-link check, stale-copy/privacy scan, and `git diff --check` | 0 | Branch documents and replacement boundary passed; this was not a whole-repository link audit |

No browser UI E2E, Android device test, or iOS UI test ran. The authorized iOS
simulator was used only for unit tests.

## Security and recovery review

- Account status is atomically set to `deleting` with the stable request/deadline;
  the existing guard blocks costly endpoints and worker admission before cleanup.
- Grace maintenance cancels active attempts and releases slots through the existing
  transactional job action, but retains account data for recovery.
- Recovery clears only deletion state and identity fence. It does not recreate an
  account, job, grant, usage period, reservation, override, event, or restriction.
- The transition to `purging` owns a durable lease before irreversible work; user
  recovery requires `deleting` plus a null lease and exact future deadline.
- Exact S3 keys/versions are scheduled through the existing owner-validating
  cleanup service. Missing objects and `auth/user-not-found` are idempotent success.
- Exceptions are not logged with provider details; the dashboard receives only the
  fixed safe retry code.

## Provider boundary and remaining limitations

- No AWS, Atlas, Redis/VPS, Firebase project, CapRover, deployment, production
  database, bucket, real account, real media, or real user data was read or changed.
- Every provider/manual item in `../runbooks/PROVIDER-CONSOLE-CHANGES.md` remains
  unchecked. Real Firebase/S3/deployed deletion is `NOT_RUN`.
- The full iOS unit suite is not green: 40 unrelated media/upload tests failed in
  the isolated worktree, while all deletion/recovery suites passed. This branch did
  not alter or mask those failures.
- Offline devices cannot be remotely wiped; local account-private data is removed
  when the invalid/deleted session is reconciled, as documented by each client.

## Handoff

- Ready for review: yes
- PR base: `codex/backend-security-cost-hardening`
- Next branch: none; this is the final implementation branch in this roadmap
