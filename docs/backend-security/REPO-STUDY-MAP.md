# Repository study and replacement map

This map records the source inspected while preparing the plan. It prevents a
future agent from rebuilding infrastructure blindly or leaving two product-policy
engines active.

## Architecture confirmed

```text
Android / iOS ── authenticated API ──> NestJS
       │                                │
       └──── exact signed transfer ──> private S3
                                        │
                           MongoDB durable truth
                           Redis bounded counters/hints
                           Worker fleet claims durable jobs
                           React dashboard uses admin APIs
```

MongoDB is authoritative for accounts, usage, jobs, overrides, restrictions, and
cleanup. Redis is not a second durable quota or queue. S3 contains audio; MongoDB
contains exact object identity and accounting metadata.

## Existing behavior to delete or replace

| Area                 | Current source                                                                         | Observed conflict                                                  | Required action                                                           |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Processing allowance | `backend/src/processing-usage/processing-allowance.ts`                                 | Base is 3,600 seconds with legacy user fields                      | Replace with UTC-month account policy                                     |
| Usage ledger         | `backend/src/processing-usage/processing-usage.schema.ts` and service                  | Per-job expiring ledger and legacy allowance lookup                | Replace business model; keep useful transaction patterns                  |
| Admin settings       | `backend/src/admin-settings/processing-settings.*`                                     | 30 MB/10-minute defaults and old active-job setting                | Replace with revisioned account policy                                    |
| Admin quota UI/API   | `backend/src/admin-users/*`, `dashboard/src/features/users/processing-*`               | Temporary allowance and processing suspension contracts            | Replace; do not expose both old and new controls                          |
| Job policy           | `backend/src/jobs/job-state.ts`, `job.schema.ts`                                       | Versioned 30 MB/10-minute and 100 MB/30-minute paths               | Collapse to one 50 MB/20-minute policy                                    |
| Client policy        | `ios/Vocal/Processing/ProcessingMediaPolicy.swift` and Android policy/preparation code | Clients understand multiple legacy policy versions                 | Replace local defaults with one backend contract and safe offline ceiling |
| Admission            | `backend/src/admin-settings/processing-admission.service.ts`                           | All active admission states count against a default maximum of one | Replace with one processing plus three waiting                            |
| Picker               | `backend/src/worker-fleet/claims/worker-claim.service.ts`                              | Global FIFO does not enforce per-account active ownership          | Extend eligibility while preserving atomic claim fences                   |
| Retry policy         | job retry fields, worker recovery, client transfer retry stores                        | Multiple retry meanings and limits                                 | Replace with explicit infrastructure/client taxonomy                      |
| Deletion delay       | `backend/src/users/account-recovery-policy.ts`                                         | Exact fifteen elapsed days                                         | Keep clients and public copy aligned to the backend deadline              |

Before removing any item, find every backend, dashboard, Android, iOS, test, and
documentation caller. Removal is complete only when no runtime path or stale UI
still exposes the legacy behavior.

## Foundations to reuse and harden

| Foundation             | Important source                                                                          | Why it stays                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Firebase identity      | `backend/src/auth/`, `backend/src/users/`                                                 | Working authentication and account fencing                |
| Ownership              | jobs/users guards and owned queries                                                       | Prevents cross-account media and job access               |
| Admin security         | `backend/src/admin/`                                                                      | Roles, permission checks, fresh auth, rate classes, audit |
| Transactions           | existing MongoDB transaction helper                                                       | Required for atomic counters/job transitions              |
| Redis counters         | `backend/src/rate-limits/rate-budget.service.ts`, `quota-script.ts`, `rate-limit-keys.ts` | Atomic, hashed, shared security foundation                |
| S3 verification        | `backend/src/storage/storage-transfers.service.ts`                                        | Exact key, size, type, checksum, version validation       |
| Cleanup                | `backend/src/storage/storage-cleanup*`                                                    | Leased, bounded, retryable exact-object cleanup           |
| Job ownership          | `backend/src/jobs/job.schema.ts` and services                                             | Durable public history and object identity                |
| Worker control plane   | `backend/src/worker-fleet/`                                                               | Atomic claim, attempt, lease, stale-owner fencing         |
| Installation history   | `backend/src/devices/`                                                                    | Retained for login/session history, not quota             |
| Deletion orchestration | `backend/src/users/account-deletion-*`                                                    | Useful leases, identity fencing, resumable cleanup        |

## Branch 1 study targets

- `backend/src/processing-usage/`
- `backend/src/admin-settings/`
- `backend/src/admin-users/`
- `backend/src/users/user.schema.ts`
- `backend/src/jobs/jobs.service.ts`
- `backend/test/processing-usage.integration.mjs`
- `dashboard/src/features/settings/`
- `dashboard/src/features/users/`
- Android/iOS processing-usage response models
- backend audio-processing and dashboard API documentation

The branch must prove the old 3,600-second path, temporary allowance API, and old
dashboard dialog no longer control behavior.

## Branch 2 study targets

- `backend/src/jobs/job-state.ts`, `job.schema.ts`, DTOs, controller, and service
- `backend/src/storage/`
- `backend/src/processing/processing-storage-cleanup.service.ts`
- `backend/src/worker-fleet/attempts/worker-attempt.service.ts`
- Android audio inspection/preparation/upload/download code and tests
- iOS `ProcessingMediaPolicy`, preparation, upload, artifact download, and stores
- dashboard policy/settings and usage panels

Current object keys are owner scoped:
`users/<account-object-id>/jobs/<job-id>/...`. Preserve that boundary. Output keys
are attempt scoped and must not be published without exact attempt finalization.

## Branch 3 study targets

- `backend/src/admin-settings/processing-admission.service.ts`
- `backend/src/jobs/`
- `backend/src/processing-usage/`
- `backend/src/worker-fleet/claims/`
- `backend/src/worker-fleet/leases/`
- `backend/src/worker-fleet/attempts/`
- Android/iOS job state, retry, restoration, and queued presentation
- processing persistence/action/usage integration suites

Preserve claim replay, lease expiry, attempt ownership, cancellation fencing, and
stale-output rejection. Change admission and eligibility, not the fleet protocol's
security boundary.

## Branch 4 study targets

- `backend/src/rate-limits/`
- `backend/src/http/security.module.ts`
- route-specific decorators/guards in auth, jobs, users, and admin controllers
- `backend/src/admin/admin-permissions.ts` and audit operations
- user/account status checks in `backend/src/auth/auth.guard.ts`
- dashboard user search/detail and new abuse filters
- environment validation and safe example files

Reuse hashed Redis keys. Do not store email, Firebase UID, IP address, or device ID
as plaintext Redis key material. Abuse records must be compact and bounded for the
Atlas Free 0.5 GB ceiling.

## Branch 5 study targets

- `backend/src/users/account-recovery-policy.ts`
- `backend/src/users/account-deletion.service.ts`
- `backend/src/users/account-deletion-cleanup.service.ts`
- `backend/src/users/account-deletion-maintenance.service.ts`
- `backend/src/users/account-recovery.service.ts`
- job deletion, storage cleanup, notifications, devices, and Firebase identity
- account deletion integration suites
- Android and iOS account-deletion stores/lifecycle UI
- dashboard account recovery screens and public deletion/privacy copy

Preserve recent-authentication, identity ownership fence, leased cleanup, and
retryability. Replace the delay and make the new quota/restriction records part of
the purge and recovery tests.

## Schema and index rules

- Prefer compact per-account/per-period documents with unique compound indexes.
- Do not append unbounded event arrays to a user document.
- Declare only indexes used by period lookup, queue eligibility, expiration,
  cleanup leasing, and admin filtering.
- Use TTL only for disposable records; never TTL durable account/job truth or S3
  objects indirectly.
- Local development does not require a production migration framework, but an
  implementation PR must document obsolete local schemas/indexes and provide a
  safe manual cleanup note. It must never drop them automatically in production.

## Documentation that implementation branches must update

- `README.md` when public behavior changes;
- `backend/README.md` for configuration or verification changes;
- `backend/docs/api/audio-processing.md` for mobile contracts;
- `backend/docs/operations/audio-processing.md` for cleanup/operations;
- `docs/account-deletion.md` for the fifteen-day lifecycle;
- backend dashboard API/permission documentation;
- `dashboard/README.md` for new administrator controls;
- Android/iOS guides when client-visible limits or account behavior change;
- this package's task, roadmap, manifest, changelog, and evidence report.
