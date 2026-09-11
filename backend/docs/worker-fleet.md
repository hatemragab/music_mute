# Worker fleet ownership foundation

The API supports two explicit authentication modes. `PROCESSING_WORKER_AUTH_MODE=legacy`
is the default and accepts only the configured `PROCESSING_WORKER_KEY_SHA256` for
`z440`. `fleet` resolves each bounded bearer digest through `audio_workers`; it
does not fall back to the environment digest. Neither mode registers workers from
HTTP claims, changes credentials at startup, or migrates documents automatically.

`POST /api/v1/worker/identity` accepts an empty body and returns
`{workerId,state,protocolVersion:2}` with `Cache-Control: no-store`. Worker IDs and
credentials come from authentication, never request body fields or identity headers.
Every returned assignment includes `workerId`. The existing selector fields and
event request hashes are preserved.

Each registration has a matching `audio_worker_control` row. Claims, recovery,
event receipts and grant issuance recheck the current credential/state and touch
the same control's `controlRevision` inside their MongoDB transaction. Administrative
state/key changes must call `WorkerRegistryService.touchControl(control, session)`
in the transaction that updates registration. Reading registration alone is not
sufficient. Rotation is an idle-only administrative operation; revocation leaves
unfinished ownership reserved. Issued S3 URLs cannot be recalled, so the final
attempt and credential checks still apply before publication.

New attempts require `workerId`; jobs preserve their latest assigned owner for
history. Only legacy mode interprets missing historical ownership as `z440`.
Expired attempts retain their per-machine slot until verified stopped recovery.
Other registered machines continue claiming the oldest eligible queued jobs.
A draining worker finishes existing work and receives no new assignment. When
stopped reconciliation releases its interrupted job, the job keeps its FIFO order
and the reply is `{status:'released',previousAttemptId}`. Repeating that recovery
returns the same release result. Windows clients must understand protocol 2 and
this reply before fleet mode is enabled.

Long polls allow one pending request per worker per API process. The validated
`PROCESSING_WORKER_MAX_WAITERS` default is 32, range 1–1024. Duplicate/capacity
requests return 429 with `Retry-After: 1`; disconnects, credential changes, errors
and shutdown release admission. The existing IP/global rate limits still apply:
operators must review the effective shared-NAT budget before enabling several
machines. No new fleet-wide rate budget was introduced.

The mobile `workerAvailable` field remains a Boolean. Assigned jobs reflect the
actual owner's recent liveness and enabled/draining state. Unassigned jobs report
whether an enabled worker is recently online, including a busy worker. Registry
IDs, labels, counts and key digests are not added to mobile responses.

## Explicit legacy-to-fleet migration

The migration is an operator-only command; it never runs during API startup. With
the backend runtime environment supplied, inspect the exact production database:

```sh
npm run worker:fleet:migrate -- --dry-run
```

The dry run opens MongoDB without model/index initialization and reports only safe
counts and decisions. It never prints digests or row payloads and performs no
writes. `canApply` concerns the database snapshot only; it does not prove that the
worker is upgraded or stopped.

After verifying the legacy worker is idle and stopping its process, apply while
every API replica is still in `legacy` mode:

```sh
npm run worker:fleet:migrate -- --apply
npm run worker:fleet:audit
```

Apply imports the configured legacy digest into `z440`, creates only a missing
control slot, preserves an existing slot's session/generation/liveness fields,
and backfills historical job and attempt ownership in bounded batches. It is
idempotent and resumable. It refuses active work, conflicting ID/digest mappings,
non-legacy ownership, orphaned fleet rows, invalid registrations, and owned queued
jobs. It does not create or modify indexes.

Only continue when apply reports `canEnableFleet:true` and the follow-up audit
reports `canEnableFleet:true`. Then set `PROCESSING_WORKER_AUTH_MODE=fleet` on all
API replicas together, restart the API, verify `/api/v1/worker/identity` using the
upgraded client, and restart the worker. If Atlas only permits the CapRover host, execute
these commands in a temporary service command using the already deployed backend
image and immediately restore the normal API command afterward.

Rollback requires every non-legacy machine to have no unfinished assignment.
Never deploy the old singleton API while another machine owns work.

Local validation uses synthetic inputs and isolated MongoDB/Redis. The fleet
integration covers twenty identities over two API service instances, credential
races, cross-worker event/receipt/grant denial, draining recovery, HTTP identity
forwarding and audit non-mutation. No physical Windows or live S3 fleet proof is
claimed.

## Administrator controls

`/api/v1/admin/workers` exposes the bounded fleet registry and its actual control slots. Management writes are available only with `PROCESSING_WORKER_AUTH_MODE=fleet`; use the trusted migration procedure before changing production mode. Registration, key rotation, revocation and stopped recovery require fresh Google administrator authentication. Ordinary drain/enable/label changes require worker management permission. All writes use an operation ID, audit transaction and control revision; active worker traffic may make a displayed revision stale.

A registration or idle rotation returns `{worker,rawKey}` once. Retrying that same operation returns only its non-secret operation receipt. Inspect the receipt after a lost response, then explicitly rotate with a new operation ID while idle. There is no key reveal endpoint. Draining workers finish existing work but cannot take new assignments. Emergency revocation disables the identity while preserving its active slot, and revoked registrations cannot be enabled again.

Release-stopped requires the exact current assignment and an operator statement identifying observed process termination. For example, `Observed worker process PID 422 exit and verified it stopped.` Include the UTC time that termination was observed; it must be no earlier than the attempt or its latest worker activity. Offline status, a lost heartbeat or a process that stopped responding is insufficient. The API validates the attestation and selectors; it does not contact the machine to prove termination. Evidence is bounded plain text in the audit event and never executed. A successful release retains attempt/media history and original queue order, or finalizes an already requested cancellation.
