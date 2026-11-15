# Fifteen-day account deletion and permanent cleanup

## Objective

Replace the current three-calendar-month recovery rule with one exact fifteen-day
contract while preserving recent authentication, identity fencing, resumable
cleanup, and safe recovery.

## State lifecycle

```text
active
  │ accepted deletion request
  ▼
deleting (15-day grace)
  ├── verified recovery before deadline ──> active
  └── deadline reached ──> purging ──> deleted tombstone
```

`recoverUntil = acceptedAt + 15 * 24 hours`. The response and all clients display
the exact timestamp supplied by the backend.

## Request rules

- Require the existing authenticated owner and recent-authentication policy.
- Use request idempotency so an uncertain repeated delete returns the same request
  and deadline.
- Fence Firebase identity/account ownership as the current implementation does.
- Atomically mark the user deleting and prevent new costly operations.
- Do not immediately destroy data during the grace period.

During grace, allow only authentication/session handling required by the existing
security model, deletion status, recovery, and safe support actions. Do not issue
job, upload, retry, worker, or media-download grants.

## Recovery rules

- Recovery is accepted only before `recoverUntil` and with the existing ownership
  and identity checks.
- Restore the same account ID and its current durable jobs/data.
- Preserve current-month used/reserved/released counters and active override unless
  it independently expired.
- Do not grant another 120 minutes, duplicate jobs, recreate uploads, or clear abuse
  history/restrictions.
- Reconcile any work cancelled/fenced by the deletion request; do not revive stale
  worker ownership.
- Repeated recovery is idempotent.

## Purge inventory

At or after the deadline, the leased cleanup workflow removes or de-identifies:

1. in-flight worker ownership and eligible jobs;
2. every verified exact input/output/stale-attempt S3 version owned by the account;
3. job history and safe job errors;
4. usage periods, reservations, adjustments, and policy override;
5. abuse events and restriction records;
6. notification/outbox/push data;
7. installation ownership and account-linked sessions;
8. account-recovery records and other personal support data;
9. personal profile data;
10. Firebase identity through the existing provider boundary.

Before implementation, search all collections for account/user foreign keys and
record the final inventory in branch evidence. Do not assume this list is complete
if a preceding branch adds a new account-owned schema.

## Cleanup behavior

- One leased owner performs a bounded page at a time.
- Each phase has a durable cursor/status and may resume after process restart.
- Exact-object missing is success; provider timeout is retryable.
- A lease token and account state fence every mutation.
- No provider error logs personal details, object keys, credentials, or raw UID.
- Cleanup does not use broad database, bucket, or Redis deletion commands.
- Account recovery cannot race after irreversible purge begins.
- Completion is set only after all mandatory phases are reconciled.

## Minimal tombstone

After purge, retain only what is required to make cleanup/repeated requests
idempotent and demonstrate completion. It may include a random deletion operation
ID, completion time, phase/version, and non-personal outcome codes.

It must not include email, display name, raw Firebase UID, installation/device ID,
IP, media name, S3 key, checksum, job metadata, quota history, abuse details, or
free-text admin notes.

## Client and administrator behavior

Android and iOS show:

- deletion accepted;
- exact recovery deadline;
- restricted grace-period state;
- recover action before the deadline;
- clear permanent-deletion warning.

The dashboard shows request phase, deadline, bounded safe failure status, and
existing authorized recovery/support actions. It must not provide a shortcut that
skips recent-authentication/permission/audit rules or directly edits deletion
fields.

Update public deletion/privacy copy to fifteen days. Provider/manual operations are
documented separately and never claimed complete from local tests.
