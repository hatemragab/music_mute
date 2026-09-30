# MongoDB retention

Implemented on 2026-09-30. These are source policies; deployment and measured
production storage savings are separate checks. Audio bytes remain in private R2.

| Collection                                                          | Retention                                   | Safety condition                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `client_errors`                                                     | 30 days from server `receivedAt`            | Client-supplied occurrence time cannot extend retention.                                                         |
| `audio_notification_deliveries`, `notification_campaign_deliveries` | 30 days after parent completion             | Pending deliveries do not receive an expiry. Parent completion/replay evidence remains.                          |
| `notification_campaigns`                                            | 365 days after completion                   | Partial TTL excludes active campaigns. Final per-device counters are saved before detailed records expire.       |
| Inactive `push_registrations`                                       | 30 days after deactivation                  | Partial TTL excludes active bindings; reactivation clears expiry. Installation ownership/security fences remain. |
| Resolved `admin_alerts`                                             | 90 days after resolution                    | Partial TTL excludes active incidents.                                                                           |
| `audio_job_errors`                                                  | 90 days after finalization                  | Terminal job, no active attempt/execution, and all notification events finished.                                 |
| `admin_audit_events`                                                | 365 days from `at`                          | Compact administrator operation receipts retain command replay protection.                                       |
| New `worker_diagnostics`                                            | 7 days                                      | Existing diagnostic records keep their original expiry, at most 14 days from creation.                           |
| Already-deleted `audio_jobs` and dependent attempts/details         | Eligible 30 days after `cleanupCompletedAt` | Coordinated cleanup, never a plain job TTL; see safeguards below.                                                |

Successful Library media and active jobs/imports are retained. Existing URL-import
(7 days), completed cleanup-task (30 days), abuse detail (90 days), daily usage
(35 days after day end), grant receipt and settled reservation (12 months after
month end) policies remain. Outstanding reservations and unfinished R2 cleanup
never receive a new expiry.

## Coordinated cleanup

Deleted-job maintenance checks execution/slot ownership, outstanding grants and
reservations, pending storage tasks, notification completion, and live logical
root/retry/shared-object references. It sweeps remaining attempt artifact keys
before atomically removing the MongoDB job, attempts, errors and notification
details. Blocked candidates are deferred so they do not monopolize maintenance.

An account-scoped `audio_purged_job_requests` receipt retains only request identity,
hash, deleted job ID and purge time. It preserves the original permanent rejection
of an already-deleted request ID without retaining full job history. Matching
requests still return `JOB_NOT_FOUND`; changed payloads conflict. Account deletion
removes these receipts. Administrator command receipts are also kept for replay
safety; neither receipt collection has a time-based expiry.

Explicit job deletion finalizes pending notification deliveries as ineligible.
Maintenance also handles legacy deleted-job notification records. This prevents
undispatchable pending deliveries from blocking cleanup forever.

Monthly usage transfer writers preserve `purgeAt`. Only outstanding processing
holds clear it. A non-overlapping maintenance pass repairs up to 100 closed
periods/minute, verifying both counters and the reservation ledger in transactions.
An index restricted to zero-hold, missing-expiry candidates keeps retained history
out of this scan. The cursor advances past failed/contended records and retries
them after wrapping.

Notification maintenance assigns expiry to existing eligible details and inactive
registrations in bounded batches. Completed campaigns retain saved aggregate
counts after detail/account cleanup. Counts already lost through account cleanup
before this policy cannot be reconstructed. Completed parents with pending children
are deferred for one hour, allowing other eligible parents to progress.

Audit history reads pin the existing chronological compound index. The new
single-field audit TTL index cannot provide the cursor's timestamp/ID ordering;
isolated query-plan checks verify pagination without a blocking sort.

## Rollout and verification

API startup creates missing declared indexes without dropping or rewriting
existing indexes. New TTL indexes can immediately make old error/audit/resolved
alert records eligible for deletion. Schedule rollout during a suitable traffic
window and inspect collection document counts, logical/storage/index sizes and
expiry coverage first. No production database or deployment was changed while
implementing this policy. Mongo TTL is asynchronous and disk allocation may remain
available for reuse after documents are removed.

From `backend/`, run `pnpm run verify`, then `pnpm run test:retention:integration`.
The latter builds and runs these isolated fixture checks:

```sh
node --test --test-concurrency=1 test/mongodb-retention.integration.mjs test/mongodb-storage-indexes.integration.mjs test/processing-usage.integration.mjs test/job-retention.integration.mjs test/notifications.integration.mjs test/admin-notifications.integration.mjs test/push-registrations.integration.mjs
```

The TTL test changes the monitor interval only inside its owned loopback mongod.
Fixtures establish local behavior, not Atlas/R2/FCM production health or savings.

Validation on 2026-09-30: `pnpm run verify` passed formatting, lint, type checking,
secret checks, 1,021 unit tests, 158 HTTP tests and the native build. The retention
integration command passed 28 tests, including the actual TTL monitor,
multi-replica notifications, replay protection, cleanup blockers and indexed
pagination/usage repair.

Six additional regression fixtures passed for native API startup/dependency
recovery, transactional persistence, job cancellation, account deletion, realtime
feeds and administrator command/audit fencing:

```sh
node --test --test-concurrency=1 test/infrastructure.integration.mjs test/processing-persistence.integration.mjs test/job-actions.integration.mjs test/account-deletion.integration.mjs test/realtime.integration.mjs test/admin-audit.integration.mjs
```

API preflight read the current [official Zalando source](https://github.com/zalando/restful-api-guidelines)
on 2026-09-30 after the published site was unavailable. Rules 106 (compatibility)
and 229/231 (idempotency and secondary request keys) shaped receipt preservation;
routes and response schemas are unchanged.
