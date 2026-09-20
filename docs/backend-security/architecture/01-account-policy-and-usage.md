# Account policy, monthly usage, and administrator controls

## Objective

Provide one backend-owned standard-plan policy and one understandable monthly
account-usage model. Remove the old rolling 60-minute behavior and temporary
allowance controls instead of running both systems together.

## Policy model

One global policy document is the authoritative launch configuration. It has a
stable ID, plan key `standard`, monotonic revision, the accepted limits, updated
time, administrator identity, and audit reference.

Required policy fields include:

- monthly processing seconds;
- maximum duration and prepared bytes;
- daily/monthly upload grants and monthly confirmed upload bytes;
- maximum waiting/processing jobs;
- infrastructure and client/input attempts;
- monthly download grants and estimated bytes;
- retained output and service outbound ceilings;
- signed URL validity;
- deletion grace period.

Only the fields implemented by an accepted branch are enforced. Later branch
activation must be explicit so adding the policy document cannot accidentally
enable unfinished behavior.

Every update validates the complete document, increments the revision, records a
reason and admin audit event, and returns the effective stored version. Concurrent
updates use the expected revision and reject stale writes.

## Per-account override

Store at most one active override record per account:

```text
accountId
replacement fields (partial)
expiresAt (optional)
reason
createdBy / updatedBy
createdAt / updatedAt
revision
```

Resolution is deterministic:

1. load the global standard policy;
2. load the account override;
3. ignore the override when expired;
4. replace only explicitly supplied fields;
5. return effective values, global revision, override revision/source, and expiry.

There are no additive bonuses, stacked overrides, device overrides, or raw-counter
edits. Clearing the record returns the account to global policy.

## Monthly usage model

Use one compact record per account and UTC period, protected by a unique index on
`{ accountId, periodKey }`. The current record contains aggregate values needed by
all five branches, not request logs:

```text
periodStart / periodEnd
processingUsedSeconds
processingReservedSeconds
processingReleasedSeconds
uploadGrants
confirmedUploadBytes
downloadGrants
estimatedDownloadBytes
lastMutationAt
revision
```

If implementation quality is clearer with related subdocuments or separate
reservation records, keep the same invariants and bounded cardinality. Do not put
an unbounded array of jobs or events inside the monthly record.

Closed monthly summaries are retained for twelve months by default for support and
cost review, then removed through an explicit bounded retention mechanism. Active
job reservations remain independently reconcilable even if a summary cleanup job
runs. This retention is an engineering default and remains configurable.

## Processing reservation lifecycle

```text
confirmed media
    │ atomic account/month capacity check
    ▼
reserved ── infrastructure retry ──> same reservation
    │
    ├── successful exact finalization ──> used
    ├── cancellation before charge point ──> released
    └── terminal infrastructure failure ──> released
```

Rules:

- reservation ID is the durable job ID;
- duplicate reservation returns the existing result;
- `used + reserved + requested <= effectiveLimit` must hold atomically;
- success moves the same number from reserved to used once;
- release moves the same number out of reserved once and records released total;
- a crash between job and usage writes cannot leave an unexplained charge;
- reconciliation detects a reservation whose job reached a terminal state;
- a new month does not make an old in-flight reservation disappear. Its policy
  snapshot and accounting period stay attached to the job until settlement.

## Public contracts

Keep the existing authenticated `GET /processing-usage` route but replace its
payload with a versioned account-period contract containing:

- plan and policy revision;
- period start/end and next reset;
- processing limit, used, reserved, released, and remaining seconds;
- effective-policy source and override expiry when relevant;
- later-branch upload/download/storage summaries;
- safe availability reason when new work is blocked.

Keep `GET /processing-policy` as the client media-policy route. It exposes only
safe client limits and a schema revision, never admin audit information or abuse
rules.

## Administrator contracts

Replace the old allowance/settings routes and UI with one cohesive surface:

- `GET /admin/settings/account-policy`
- `PUT /admin/settings/account-policy` with expected revision and reason
- `GET /admin/users/:id/account-usage`
- `PUT /admin/users/:id/account-policy-override`
- `DELETE /admin/users/:id/account-policy-override`

The exact controller organization may follow existing module conventions, but the
old processing-allowance and clear-allowance behavior must be removed after all
callers migrate.

The user detail page shows global/effective limits, source, expiry, period, used,
reserved, released, and remaining values. It cannot edit counters. Global and
account changes require existing admin permission checks, recent authentication
where currently required, reason validation, optimistic revision, and audit.

## Boundary behavior

- A new account receives the full current UTC month's limit.
- A month boundary is resolved on access; no bulk reset cron is required.
- Decreasing a limit below current usage produces zero remaining capacity without
  mutating history or cancelling accepted jobs.
- Expiry during an in-flight job does not change its accepted snapshot.
- Two simultaneous reservations cannot both spend the same remaining seconds.
- The same request/job cannot reserve or settle twice.
- Devices attached to the account neither split nor multiply usage.

## Migration in local development

No production migration framework is required. The branch may replace disposable
local schemas and fixtures, but it must not automatically drop collections or
indexes. Document obsolete fields/indexes and a manual local-reset procedure.
Tests start from isolated empty databases and prove only the new engine is active.
