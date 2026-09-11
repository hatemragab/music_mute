# Backend audio processing specification

Date: 2026-09-09. Status: agreed product requirements; implementation not started.

This document records the discussion with the owner and the engineering defaults
needed to implement the backend. It authorizes no deployment or production data
change. Read the [implementation plan](../plans/2026-09-09-audio-processing.md) and
[task tracker](../../tasks/audio-processing.md) together with this specification.

## 1. Confirmed requirements and scope

- Android/iOS download the source audio themselves, then transfer it directly to
  private S3 storage using backend-issued presigned access.
- Input duration is strictly less than 600 seconds. Input size is strictly less
  than 30,000,000 bytes; zero-length or unreadable audio is rejected.
- Output is one voice-only MP3. Do not publish an instrumental track.
- MongoDB stores job metadata and S3 object keys/identities, not presigned URLs.
- Retain files, job history, and error records indefinitely. No automatic object
  deletion, TTL deletion of business records, lifecycle expiration, or cleanup
  process is part of this feature. Cancelled and failed artifacts are retained.
- Users may submit unlimited jobs and retain unlimited history. Paginate reads;
  retain existing request-abuse throttles, without daily or outstanding-job quotas.
- FIFO begins when a completed upload is verified and its enqueue transaction
  commits. A pending upload has no queue position.
- Exactly one job may occupy the global execution slot, including validation,
  output upload, interruption, and cancellation awaiting acknowledgment.
- The personal Windows Z440 may shut down at any point. Preserve queued and
  interrupted work until it returns; do not depend on continuous availability.
- Users can cancel unfinished jobs. Workers report processing errors as failures,
  with a safe user-facing explanation and an error record in MongoDB.
- Processing failures are not automatically requeued. A user-requested retry
  creates a new job at the end of the queue. An interrupted job recovers in its
  existing slot before another job starts.
- Notify the user through FCM after durable completion; job history remains the
  source of truth if notification delivery fails or is disabled.
- Implement only the NestJS backend. Mobile changes and installation, model
  choice, CLI execution, process supervision, and performance tuning on the Z440
  are outside scope. Document the required external worker protocol.
- Do not commit, push, publish, deploy, change real configuration, or delete data
  as part of implementing this plan without a separate explicit request.

The worker uses [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator).
The backend neither imports that package nor accepts executable commands or model
paths from clients.

## 2. Existing architecture and implementation boundary

The current backend provides Firebase authentication, MongoDB users/devices,
processing-access policy, shared Redis abuse limits, and an AWS S3 client. Its
`/api/v1` prefix, strict DTO validation, safe exception filter, ESM `.js` imports,
and awaited Mongoose index initialization remain authoritative.

Add cohesive jobs, worker-control, error-log, storage-transfer, and notification
modules. MongoDB is the business queue. Redis continues to serve existing abuse
limits; do not restore BullMQ or create a local audio worker process.

Backend API instances may run small, restartable maintenance loops for expired
leases and notification dispatch. MongoDB coordinates those loops across API
replicas. No audio bytes pass through an API upload/download endpoint.

The repository-root README still describes the removed BullMQ starter. Treat
`backend/README.md` and this specification as current for this feature; do not
restore legacy code on the strength of that historical description.

## 3. Defaults and prerequisites

These are engineering defaults, not additional submission quotas:

| Setting                            | Initial value / rule                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `AUDIO_PROCESSING_ENABLED`         | `false`; explicit opt-in preserves existing auth-only startup                                                            |
| Upload/download signature lifetime | 900 seconds; renewable after authorization                                                                               |
| Worker identity                    | One configured worker, `z440`                                                                                            |
| Worker authentication              | At least 32 random bytes in a bearer secret; backend stores a SHA-256 digest in secret configuration and compares safely |
| Worker heartbeat interval / lease  | 20 seconds / 90 seconds                                                                                                  |
| Empty-queue polling hint           | 15 seconds; worker adds jitter                                                                                           |
| Maintenance interval               | 15 seconds; correctness must not depend on an exact timer firing                                                         |
| History pagination                 | Default 20, maximum 100, stable opaque cursor                                                                            |
| Output size guard                  | Strictly less than 30,000,000 bytes, configurable independently of the fixed input limit                                 |
| Output contract                    | `audio/mpeg`, one MP3 vocals file, positive playable duration below 600 seconds; bitrate is the external worker's choice |
| Notification dispatch              | Lease 60 seconds, external send timeout 10 seconds, at most 8 transient attempts per target                              |

Processing requires a transaction-capable MongoDB replica set (Atlas already
supports this deployment shape; the actual deployment must be checked). Use
primary reads and majority write concern for coordination. Add an opt-in isolated
single-node replica set to tests; preserve the existing standalone test defaults.

Storage preflight must verify the configured bucket is versioned and private,
uses the expected AWS region, and has no configured lifecycle expiration that
conflicts with retention, including noncurrent versions. Lack of permission to
verify is not proof of compliance. Do not create or modify the bucket/policies.
When enabled, processing fails closed until preflight succeeds; when disabled,
new processing routes refuse work and existing auth behavior remains unchanged.

No worker-online requirement belongs in API liveness/readiness. An offline Z440
is an expected business state, not an unhealthy API. Recheck storage requirements
before issuing transfer grants; bounded caching may last at most 60 seconds.

## 4. Collections and invariants

All collections use strict schemas and explicitly named indexes. Await model
initialization before accepting processing traffic. No production index dropping,
rewriting, document migration, or destructive startup repair.

| Collection                      | Responsibility and principal fields                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio_jobs`                    | `_id`, `userId`, `requestId`, request hash, optional `retryOfJobId`, status, immutable input reservation, pinned input/output identities, queue order, attempt/session/generation, stage, safe last error, timestamps, revision |
| `audio_worker_control`          | Singleton `_id: z440`, active job/attempt/session, increasing generation, last heartbeat, lease deadline; idle still retains worker last-seen state                                                                             |
| `audio_queue_counters`          | Singleton sequence allocated transactionally; represent the persisted sequence with BSON int64 and expose it only as a string if needed                                                                                         |
| `audio_job_attempts`            | One document per attempt: job, worker session, generation, start/end/interruption timestamps and outcome; no unbounded embedded history                                                                                         |
| `audio_job_errors`              | Durable deduplicated events with job/attempt, stage, allowlisted code, safe message, diagnostic classification and timestamp                                                                                                    |
| `audio_job_receipts`            | Worker operation/event ID, request hash and accepted outcome, allowing safe repeated callbacks without repeating mutations                                                                                                      |
| `push_registrations`            | Authenticated user/installation binding, private FCM token, token hash, binding revision, auth time, active status, timestamps                                                                                                  |
| `audio_notification_outbox`     | Unique job/outcome event, user, dispatch status and recipient traversal cursor                                                                                                                                                  |
| `audio_notification_deliveries` | One target/binding revision per event, delivery status, attempts and next-attempt time; no unbounded embedded target list                                                                                                       |

Required indexes include owner/request uniqueness, `(userId, createdAt, _id)`
history, `(status, queueOrder)` dequeue ordering, unique attempt ID, unique
`(jobId, eventId)` receipt/error events, unique outbox outcome event, unique
`(outboxId, registrationId, bindingRevision)` delivery, unique token hash, and a
unique installation binding. Do not use TTL indexes on these records.

The single worker-control document is the serialization point. A claim transaction
must both acquire its empty slot and transition the oldest queued job. If either
write loses a race, retry the transaction and reread; never return a claim from
an aborted transaction. A queue-sequence update similarly serializes enqueue
transactions. Use short transactions: S3 and FCM calls happen outside them.

Every externally visible transition updates `revision` and compares expected
status/attempt/generation as appropriate. Error/outbox writes occur in the same
transaction as the associated final state. DB failure must not be reported as
accepted cancellation, completion, or failure.

## 5. Upload lifecycle and storage security

1. Authenticated creation checks the existing processing-access guard. Validate
   integer byte count `1..29,999,999`, finite positive duration `< 600`, supported
   audio container and base64 SHA-256. Treat client media metadata as untrusted.
2. Generate the user ID from the authenticated MongoDB user, and generate job and
   upload IDs on the server. Use `users/{userId}/jobs/{jobId}/input/{uploadId}.{ext}`.
   Allow only `m4a`, `mp4`, `webm`, `opus`, `ogg`, `aac`, and `mp3` input containers;
   the worker must still reject video streams, malformed media, or unsupported codecs.
3. Persist `awaiting_upload` before issuing the grant. `requestId` is a UUIDv4
   idempotency value scoped to the owner. Same ID/different payload is a conflict.
4. Issue a presigned POST with exact bucket/key, exact declared content length
   within the input cap, approved content type, SHA-256 algorithm/checksum fields,
   and expiration. Never sign a user-supplied URL, bucket, prefix or arbitrary key.
   Do not grant list, delete or unrelated-object permissions.
5. On upload confirmation, HEAD the server-selected key, pin the returned S3
   version ID and verify that version's size/checksum against the reservation.
   Client metadata and an ETag alone are not integrity proof. Missing version or
   checksum is a refusal, not permission to fall back to an unpinned GET.
6. In a transaction, compare `awaiting_upload`, save the verified object identity,
   allocate queue order, set `queuedAt`, and change to `queued`. If cancellation
   won during the S3 calls, do not enqueue. Repeat confirmations are idempotent.
7. Later presigned GETs always include the pinned version ID. A repeated POST may
   create another retained version, but cannot change the accepted input. Short
   grant lifetimes and exact checksums constrain that capability; a presigned POST
   is not a one-use authorization. Do not promise immediate revocation at S3.

The 10-minute rule is enforced independently by the trusted worker before
separation. The backend enforces upload bytes, reported metadata and worker
attestations, but cannot prove playable duration through HEAD. The external worker
must inspect/decode with byte/time/resource limits and reject actual duration
`>= 600`, regardless of declared duration or container metadata.

Upload grants can expire without deleting or automatically failing the job.
Renew only while `awaiting_upload` with identical reserved content. Files arriving
after cancellation remain private and retained but never become queued.

Presigned responses use `Cache-Control: no-store`. Links are bearer capabilities:
short lifetime is the access boundary after issuance, including after logout or
cancellation. Do not write links to database documents, FCM payloads, or logs.

## 6. States, cancellation, failures, and retry

| Current state                  | Permitted next state / condition                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `awaiting_upload`              | `queued` after verified enqueue; `cancelled` on owner request                                           |
| `queued`                       | `validating` on atomic claim; `cancelled` on owner request                                              |
| `validating`                   | `processing` after valid worker report; `failed` for invalid media; `interrupted`; `cancel_requested`   |
| `processing`                   | `uploading_result`; `failed`; `interrupted`; `cancel_requested`                                         |
| `uploading_result`             | `ready` after verified completion; `failed`; `interrupted`; `cancel_requested`                          |
| `interrupted`                  | Resume output finalization or start a new `validating` attempt after reconciliation; `cancel_requested` |
| `cancel_requested`             | `cancelled` only after worker confirms all subprocesses stopped                                         |
| `ready`, `failed`, `cancelled` | Terminal; repeated matching operations return the stored result                                         |

Input validation errors are `failed` with a specific code such as
`INPUT_TOO_LONG` or `INVALID_AUDIO`, not a second redundant rejection status.
Retrying invalid media with the same bytes is refused with `NEW_INPUT_REQUIRED`;
the user must submit a corrected input. Other failed jobs may create a new retry
job referencing the same owner's pinned input, with a new enqueue sequence.

User cancellation is not an error. A worker failure may release the slot only
when it confirms its subprocesses stopped. If cancellation already won, the
worker's stopped acknowledgment finalizes `cancelled`; any genuine associated
failure can still be logged without changing the terminal outcome.

Cancellation/completion race: whichever state transition commits first wins.
Completion must compare status and current attempt again after verifying S3.
Cancelling `ready` returns a conflict and does not hide/delete the result.

## 7. Worker protocol and personal-computer recovery

The worker authenticates only to the backend and S3 presigned endpoints. It
receives no MongoDB credentials, AWS keys, Firebase Admin credentials, user tokens,
or notification destinations. An explicit worker-route authentication mode must
not make endpoints public or weaken the global user guard on other routes.

Each CLI supervisor boot creates a UUID session ID. Each assigned execution gets
an attempt ID and increasing generation. Every heartbeat, stage, upload-grant,
failure and completion request compares the authenticated worker plus those IDs
against the active slot. The worker bearer credential authorizes the protocol;
attempt IDs are ownership selectors, not standalone authentication credentials.

Claim with no work returns `204` and a polling hint. A repeated claim from the
current session returns its existing assignment, including after a lost response.
A competing session receives recovery-required while a slot is occupied; it
never gets a second job. A refreshed download grant still targets the pinned input.

Lease expiry marks the job interrupted but retains its slot. Expired attempts
cannot extend their lease, change stages, obtain new grants, or publish results.
On every mutation enforce the deadline even if maintenance has not yet run.
After an uncertain callback, the worker queries/reconciles its assignment; it
does not assume a timeout means the backend accepted the action.

Reconciliation requires the registered worker to acknowledge that prior separator
subprocesses are stopped. If cancellation is pending, finalize cancellation. If a
result-upload reservation exists, inspect its expected pinned/checksummed object:
adopt and finalize the valid output before deciding to restart. Otherwise allocate
a new attempt/generation on the same job and restart validation. Retain queue
order, input, attempt history and all prior output objects. Never reuse an old
attempt's writable output key for a new attempt.

A same-session network reconnection also reconciles after lease loss. A lost
completion response for an already-finalized attempt returns its durable receipt
without needing the now-released slot. Same event ID with a different request
hash is a conflict.

External worker requirements: machine-wide singleton, one separator child at a
time, process-tree supervision, stop on cancellation/lost authority, and recovery
before a new claim. A DB lease fences accepted writes; it cannot prove a remote
process stopped. Do not claim physical exactly-once execution under arbitrary
partitions. Prefer waiting for explicit stopped acknowledgment over overlapping
work. A permanently unavailable machine requires explicit operator recovery; no
automatic force-unlock is allowed.

## 8. Output and errors

Only the current `processing` attempt may reserve its output. Reserve the exact
size, SHA-256 and MP3 metadata; use
`users/{userId}/jobs/{jobId}/output/{attemptId}/vocals.mp3`. The transaction moves
to `uploading_result`; issue a scoped POST afterward. Renew only for that current
reservation. Bound output size independently with the default in section 3.

The worker reports that the file is playable voice-only MP3 and its actual
duration. HEAD verifies byte integrity and the S3 version; it does not prove the
file's acoustic content. This is a trusted-worker contract and must be labelled
as such in tests and handoff documentation. Publish exactly one result descriptor.

Finalize ready, release the active slot, close the attempt, save the idempotency
receipt, and insert the ready outbox event in one transaction. Unexpected S3/DB
outages return sanitized retryable API errors; they do not silently mark the
audio job failed or run separation again.

Failure reports use a stable event ID and allowlisted code/stage, for example
`INVALID_AUDIO`, `INPUT_TOO_LONG`, `INPUT_CHECKSUM_MISMATCH`, `SEPARATOR_FAILED`,
`OUTPUT_INVALID`, `DOWNLOAD_FAILED`, or `OUTPUT_UPLOAD_FAILED`. Store a safe
message from a backend-owned mapping, attempt/generation, timestamp, and bounded
diagnostic fields such as exit code. Do not accept/store raw CLI stdout, stack
traces, arbitrary messages, local personal paths, headers, tokens, or URLs.
Interruption events and notification failures have separate classifications.
Users see their own safe last error; detailed operational records are never
returned through user history endpoints.

## 9. FCM and history

Register a push destination only for an authenticated, owned installation.
Use a unique token hash and a single current binding per installation. Rebinding
on account switch deactivates the old destination; never notify both accounts.
Keep tokens in server-only projections and exclude them from error logs.

Reuse the existing managed Firebase Admin app to expose a messaging provider.
Do not initialize an unrelated second app or change existing auth lifecycle.
Logout-all invalidates registration eligibility using the existing user session
cutoff; a fresh authenticated registration is required afterward. Logout does not
cancel accepted jobs. Existing account-disabled authentication rules still deny
new user requests and download grants; already accepted jobs retain their normal
lifecycle and their output stays private. Provide an
idempotent deactivate endpoint for notification opt-out without deleting history.

The outbox creates durable per-target delivery records after resolving current
active bindings. Recheck binding revision, account active status and session
cutoff before sending. New devices registered after event dispatch obtain state
from history; do not back-send the entire historic outbox.

Send generic ready/failed messages with `jobId` and `eventId`, never file names,
presigned links, raw errors or tokens. An app must refetch the job with its
current authentication before showing private details. Already dispatched pushes
cannot be recalled during account switching. Invalid destinations are deactivated;
transient failures retry at 30 seconds, 2 minutes, 5 minutes, 15 minutes, 1 hour,
4 hours and 12 hours after the initial attempt, honoring longer provider delays.
After eight unsuccessful sends, retain a failed-delivery record. Retry success
for one target must not resend to targets already recorded as successful.

FCM may accept a send before the API crashes while recording its result. Exactly
once device notification is not guaranteed; stable event IDs permit client-side
deduplication. This uncertainty never changes a ready job back to processing.

History is owner-scoped and cursor-paginated with optional status filters. Return
safe job fields, worker availability, and authenticated download actions. Do not
return storage keys, worker secrets, internal diagnostics or other users' queue
details. Allow original download once input is pinned and output download only
when ready. Apply processing-access policy to new uploads/retries, not to reading
history or cancelling work; existing authentication/account rules still apply.

## 10. API surface to implement

All routes are relative to `/api/v1`. Worker and user DTOs are separate. Reject
unknown fields, oversized metadata, invalid UUID/ObjectId values and bad cursors.

| Method/path                                     | Authentication              | Purpose                                        |
| ----------------------------------------------- | --------------------------- | ---------------------------------------------- |
| `POST /jobs`                                    | User + processing access    | Idempotent input reservation and upload grant  |
| `POST /jobs/:id/upload-url`                     | Owner + processing access   | Renew pending input grant                      |
| `POST /jobs/:id/upload-complete`                | Owner + processing access   | Verify object and enqueue once                 |
| `GET /jobs`                                     | User                        | Paginated owner history                        |
| `GET /jobs/:id`                                 | Owner                       | Status, safe failure, worker availability      |
| `POST /jobs/:id/download-url`                   | Owner                       | Fresh pinned input or ready-output GET grant   |
| `POST /jobs/:id/cancel`                         | Owner                       | Immediate cancellation or cancellation request |
| `POST /jobs/:id/retry`                          | Owner + processing access   | New queued job from retryable failed input     |
| `PUT /devices/:installationId/push`             | Owned installation          | Register/refresh current FCM destination       |
| `POST /devices/:installationId/push/deactivate` | Owned installation          | Disable current destination                    |
| `POST /worker/claim`                            | Worker                      | Claim or recover current assignment            |
| `POST /worker/heartbeat`                        | Worker + assignment         | Renew valid lease, observe cancellation        |
| `POST /worker/stage`                            | Worker + assignment         | Validate/advance approved stage                |
| `POST /worker/output-url`                       | Worker + assignment         | Reserve/renew output upload grant              |
| `POST /worker/complete`                         | Worker + assignment/receipt | Verify and finalize output                     |
| `POST /worker/fail`                             | Worker + assignment/receipt | Persist stopped failure and error log          |
| `POST /worker/cancelled`                        | Worker + assignment/receipt | Acknowledge stopped cancellation               |
| `POST /worker/reconcile`                        | Worker                      | Resolve interrupted assignment safely          |

Cross-owner job lookups return the same `404 JOB_NOT_FOUND` as nonexistent IDs.
Conflicts include `JOB_STATE_CONFLICT`, `IDEMPOTENCY_CONFLICT`,
`WORKER_RECOVERY_REQUIRED`, `STALE_ATTEMPT` and `NEW_INPUT_REQUIRED`. Preserve the
existing generic validation and infrastructure-error response envelope.

## 11. Release acceptance and evidence boundaries

Prove concurrency, ordering, crashes, cancellation races, and transactional
failure behavior against isolated real MongoDB with replica-set transactions.
Use isolated Redis and Firebase Auth Emulator fixtures for authenticated HTTP
tests. FCM has no equivalent delivery emulator here; fake the messaging boundary
for automated tests and label that coverage accurately.

Presigner unit/HTTP tests do not establish AWS policy enforcement. A later
explicitly authorized nonproduction S3 check must prove oversized/checksum-tampered
uploads are refused, accepted input cannot be replaced, pinned GETs work, and
output verification works. Test objects must be retained under the no-delete
requirement; never silently use the production bucket for fixtures.

Actual Windows separation, device notification delivery, deployed S3 policies,
and the complete live app workflow are separate, unverified acceptance items.
Do not mark the product live because backend tests pass.

## 12. Primary references reviewed during discussion

- [AWS POST policy](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-HTTPPOSTConstructPolicy.html): exact conditions and byte ranges.
- [AWS presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html): temporary bearer access and reuse.
- [S3 versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html): pinning accepted object versions and retained versions.
- [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/): conditional updates and multi-document transactions.
- [FCM message lifetime](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan): accepted versus delivered messages.
