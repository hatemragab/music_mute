# Audio processing operations and external worker handoff

This backend stores durable jobs and coordinates one external Z440 supervisor.
It does not install or run the Windows separator, download models, implement a
mobile client, or prove that the returned audio contains only voice.

## Enablement

`AUDIO_PROCESSING_ENABLED=false` preserves the existing auth-only startup path.
Set it to `true` only after supplying `PROCESSING_WORKER_KEY_SHA256` as the
lowercase SHA-256 hex digest of a strong worker bearer secret. Keep the raw secret
on the worker and transmit it only over HTTPS. Rotation takes effect after the
API configuration is refreshed/restarted. Never put it in a URL or worker DTO.

Enabled startup does not require the Z440 to be online. Safe startup diagnostics
identify these prerequisite failures without printing provider errors or secrets:

- `Audio processing MongoDB capability check failed`: the MongoDB capability
  command could not complete.
- `Audio processing requires a writable MongoDB replica set with sessions`:
  MongoDB responded but does not meet the processing transaction prerequisites.
- `Audio processing schema initialization failed`: collection/index initialization
  failed. Investigate privileges and index conflicts without deleting existing data.
- `Storage bucket preflight failed`: S3 inspection failed or bucket configuration
  does not meet the requirements below. This occurs before any user audio upload.

Older builds can report these failures only as `Unexpected startup error`; that
generic message cannot distinguish MongoDB from S3.

Dependency diagnostics include the failed S3 operation and an allowlisted provider
code/HTTP status, or a MongoDB numeric error code. For example:
`Storage bucket preflight failed: GetBucketVersioning (AccessDenied, HTTP 403)`.
Successful S3 inspection with an invalid setting instead identifies the requirement,
such as `versioning must be Enabled` or `lifecycle expiration rules are not allowed`.
Raw provider messages, connection strings, credentials and bucket identifiers are
not logged. Unrecognized provider codes remain classified as an unknown provider
error rather than being copied into logs.

Other settings:

| Setting                       | Default  | Meaning                                                                 |
| ----------------------------- | -------- | ----------------------------------------------------------------------- |
| `PROCESSING_LEASE_SECONDS`    | 90       | Lease duration, configurable from 60 through 600 seconds                |
| `PROCESSING_URL_SECONDS`      | 900      | Presigned grant lifetime, 60 through 900 seconds                        |
| `PROCESSING_OUTPUT_MAX_BYTES` | 30000000 | Exclusive output byte ceiling; configurable from 1024 through 100000000 |

Input bytes must be strictly below 30,000,000 and actual audio duration strictly
below 600 seconds. There are no daily/outstanding-job quotas. Ordinary request
abuse limits still apply. S3 objects, jobs, attempts, receipts, errors, and
notification records have no automatic TTL. Explicit user deletion now schedules
scoped artifact cleanup; it does not enable age-based deletion of other media.

## MongoDB prerequisites and rollout

Processing requires a writable replica set with logical sessions and transactions.
Enabled startup runs the replica check, initializes registered schema indexes,
and awaits the S3 preflight. Standalone MongoDB is suitable only while processing
is disabled. Use a separate authorized environment to verify the deployment's
transaction privileges and majority write availability before enabling processing.

The new collections are additive: `audio_jobs`, `audio_job_attempts`,
`audio_job_receipts`, `audio_queue_counters`, `audio_worker_control`,
`audio_job_errors`, `device_installation_owners`, `push_registrations`, `audio_notification_outbox`, and
`audio_notification_deliveries`, and `client_errors`. No existing auth/device documents are rewritten.
Unique indexes protect user request IDs, callback IDs, attempt IDs, push ownership,
terminal outbox events, and delivery targets. Resolve pre-existing conflicting
records explicitly; startup must not drop indexes or delete records to proceed.

Queue sequence allocation and claiming use Mongo transactions. Redis continues
to provide the existing request limits; it is not the authority for audio jobs.
Multiple API instances contend on the same singleton `z440` control document.

## S3 prerequisites

The configured bucket must match `AWS_REGION`, have versioning enabled, all four
public-access-block settings enabled, private ACL/policy state, and no configured
current/noncurrent expiration rules. Preflight fails closed on missing permissions,
ambiguous state, or outages. A successful preflight is cached briefly, which bounds
how quickly the API rechecks bucket configuration before issuing new grants.

Grant the API bucket inspection permissions `s3:GetBucketLocation`,
`s3:GetBucketVersioning`, `s3:GetBucketPublicAccessBlock`,
`s3:GetBucketPolicyStatus`, `s3:GetBucketAcl`, and `s3:GetLifecycleConfiguration`.
Restrict `s3:PutObject`, `s3:GetObject`, and `s3:GetObjectVersion` to the managed
object prefixes. With SSE-KMS, checksum HEAD requests also require the applicable
KMS decrypt/data-key permissions. Workers receive presigned capabilities, never
AWS credentials or bucket listing/deletion privileges.

Clients upload directly through the returned POST URL and fields. Policies bind
the server-selected key, exact byte length, content type, SHA-256 algorithm and
checksum. The API HEADs the object, pins its version ID, and verifies that version
before enqueueing or publishing it. An ETag alone is not verification. Reusing a
POST can create another retained version but cannot change an accepted input.
The API also rejects S3's literal `null` version, which can be overwritten while
versioning is suspended. See [AWS suspended-version behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/AddingObjectstoVersionSuspendedBuckets.html).

Download links always name the accepted version. Logout/cancellation does not
revoke issued capabilities; they expire at their deadline unless AWS authorization
or credential changes invalidate them sooner. HTTP grant responses and S3 GET
responses use `no-store`. Configure bucket CORS for the actual authorized web
client origins separately; the backend does not mutate bucket configuration.

## Windows supervisor obligations

1. Enforce a machine-wide singleton and one separator child/process tree at a time.
2. Generate a UUIDv4 session ID per supervisor boot. Claim work and persist the
   assignment selectors. No work returns 204 with `Retry-After: 15`. A repeated
   live same-session claim returns its assignment; a competing or stale claim
   returns 409 and `previousAttemptId` for reconciliation.
3. Heartbeat well inside the returned deadline. Stop the process tree on lost
   authority or cancellation. A lease fences backend writes; it cannot prove a
   disconnected remote process stopped.
4. Decode and validate input independently with byte, duration, and resource
   bounds. Report playable audio and actual duration before separation. Reject
   duration at or above 600 seconds even if container/client metadata claims less.
5. Produce playable voice-only MP3. Report exact bytes, SHA-256, and duration when
   reserving output; upload only through the returned grant. Voice-only/playable
   claims are trusted-worker attestations; S3 HEAD proves integrity, not acoustics.
6. Use stable event UUIDs when retrying stage, output, completion, stopped failure,
   or cancellation callbacks. Reusing an event ID with different content conflicts.
   An HTTP timeout is an unknown outcome, not evidence that a callback failed.
7. On startup/reconnection, stop old subprocesses before reconciling the previous
   attempt. Reconciliation first honors cancellation, then adopts verified uploaded
   output, then starts a fresh attempt on the same job only if no valid output exists.

Lease expiry preserves the occupied slot, input, queue order, and attempt history.
Maintenance records one interruption per attempt; mutation checks enforce expiry
even between sweeps. There is no timeout-based force unlock. A permanently lost
Z440 requires a deliberate operator recovery decision after confirming old work
cannot run; no automatic destructive repair is included.

## Failures and notifications

Worker failure payloads contain allowlisted codes/stages and an optional bounded
exit code, never stdout, personal paths, URLs, tokens, arbitrary messages, or stack
traces. The API chooses a safe user message and retains the operational error.
Cancellation is not an error, although a genuine associated worker failure may be
recorded while the terminal state remains cancelled. User retries create a new job
at the queue tail. Invalid-media failures require corrected input instead.

Ready/failed transitions insert an outbox row in the same transaction as the job,
attempt, and released slot. Event-bearing terminal callbacks also store a receipt;
reconciliation replays through the retained attempt/job state. Notification failure never changes ready back
to failed or re-runs separation. Dispatch checks current user/session/binding
eligibility and uses generic data-only payloads without URLs or audio metadata.
Push may be duplicated around a send/ack crash and delivery is not guaranteed.
Clients must deduplicate its event ID and obtain authoritative state from owner history. External send and account
switch cannot be one atomic transaction, so payloads contain no private result.

Accepted device sign-in establishes a global current installation owner while
retaining per-user device history. Push registration and delivery require that
owner, so switching accounts does not depend on the new account registering a
token first. Ownership uses Firebase authentication time to reject delayed older
claims. Conflicting account claims with the same authentication second invalidate
ownership and return a device conflict; obtain a fresh sign-in before retrying.

## Validation boundary

### Audio experience rollout and cleanup

Metadata/timing fields are additive and legacy records need no backfill. The new
client-errors owner/event index and jobs cleanup index are created through the normal
registered-schema initialization. No index drops or live document rewrites are needed.
No Z440 protocol/algorithm update is required: existing stage/output/terminal/heartbeat
events drive processing timing.

User DELETE creates a tombstone immediately and disables pending outcome notifications.
Cleanup begins no earlier than `PROCESSING_URL_SECONDS + 300` seconds after deletion,
allowing previously issued upload grants a grace period. The existing API maintenance
tick leases one job and at most ten attempt records per sweep. Transient cleanup failures
back off from 30 seconds up to one hour; state survives restarts. `cleanupAttempts`,
`cleanupNextAt`, and `cleanupCompletedAt` distinguish pending/retrying/completed cleanup.

The API identity additionally needs `s3:ListBucketVersions` scoped by managed prefixes
and `s3:DeleteObjectVersion` scoped to managed objects. The API lists by the exact
reserved key prefix but deletes only entries whose full key matches, with explicit
version IDs (including delete markers). Sibling keys are never deleted. Shared retry
inputs stay until the last undeleted referencing job is removed. Insufficient storage
permissions leave hidden tombstones pending for retry; this release does not change
IAM or touch real stored objects during development.

Find a user-visible Job ID in `audio_jobs`, then use its owner and requestId to query
`client_errors` by userId/operationId; that also finds failures from before reservation.
Worker diagnostics remain in `audio_job_errors`. Use receivedAt for server ordering,
not the client occurredAt. Job names are cleared on deletion; minimal IDs, timestamps,
request hashes, and diagnostic codes remain for support. Do not expose these operational
queries as an unauthenticated HTTP route or copy raw credentials into support logs.

### Test evidence boundaries

`npm run verify`, `npm run test:integration`, `npm run test:auth:integration`, and
`npm run test:processing:integration` exercise local code and isolated services.
The processing fixture uses a real Mongo replica set, Redis, Firebase Auth
Emulator and HTTP guards, with fake S3 and messaging. It does not contact a real
AWS/Firebase project, send real pushes, or create real user accounts.

Separate live acceptance requires authorization: deployment replica/permissions,
retained sandbox S3 checksum-policy/version verification, the actual Windows
supervisor and separator, and mobile notification delivery. None is inferred from
local tests or builds. No deployment or live object mutation is part of this change.
