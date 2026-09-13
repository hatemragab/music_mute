# Audio processing API

This document describes the implemented HTTP contract for audio jobs, the Z440
worker, and push registration. All paths are relative to `/api/v1`. Audio
processing routes return `503` while `AUDIO_PROCESSING_ENABLED` is false.

The implemented [audio experience additions](audio-experience.md) cover optional
source metadata, preserved/renamed names, request references, processing timing,
terminal-job deletion, and authenticated mobile error reports. `/client-errors`
remains available independently of processing enablement. Job projections have
additive fields, but upload clients must migrate with the API because upload
grants now use immutable, checksum-bound `PUT` requests instead of form posts.

Requests and responses use JSON unless an S3 grant says otherwise. Unknown body
fields are rejected. UUIDs are version 4 and are normalized to lowercase. Job
IDs are 24-character MongoDB object IDs. Dates are ISO 8601 strings.

## Authentication

User routes require a current Firebase ID token:

```http
Authorization: Bearer <firebase-id-token>
```

Routes that create work or renew/confirm an upload also require an installation
that belongs to the authenticated user and currently satisfies processing
policy:

```http
X-Installation-Id: <installation-uuid>
```

Those routes are `POST /jobs`, `POST /jobs/:id/upload-url`,
`POST /jobs/:id/upload-complete`, and `POST /jobs/:id/retry`.

Worker routes accept only the configured worker secret. The API stores its
lowercase SHA-256 digest and never treats the secret as a Firebase user token.

```http
Authorization: Bearer <worker-secret>
```

Only one Authorization header is accepted. Malformed, repeated, or oversized
credentials return `401`.

## Media and transfer contracts

Input declarations accept these exact extension/content-type pairs:

| Extension     | Content type |
| ------------- | ------------ |
| `m4a`, `mp4`  | `audio/mp4`  |
| `webm`        | `audio/webm` |
| `opus`, `ogg` | `audio/ogg`  |
| `aac`         | `audio/aac`  |
| `mp3`         | `audio/mpeg` |

Input `bytes` is an integer from 1 through 29,999,999. `durationSeconds` must be
finite, greater than zero, and less than 600. `sha256` is the canonical padded
base64 encoding of exactly 32 digest bytes.

An upload grant has this shape:

```json
{
  "method": "PUT",
  "url": "https://private-bucket.example/server-owned-object-key",
  "headers": {
    "Content-Type": "audio/mpeg",
    "x-amz-checksum-sha256": "base64-sha256",
    "If-None-Match": "*"
  },
  "expiresAt": "2026-09-09T12:15:00.000Z"
}
```

Submit the raw file with the returned method and headers directly to `url`.
The signature fixes the exact byte count, content type, checksum, conditional
create and server-owned key. A download grant contains only `url` and
`expiresAt`. Grants are temporary and must not be stored as durable identifiers.

## User job routes

### `POST /jobs`

Creates an idempotent upload reservation. The request needs processing access.

```json
{
  "requestId": "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
  "sourceTitle": "Interview",
  "sourceKind": "url",
  "sourceUrl": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "clientStartedAt": "2026-09-10T12:00:00.000Z",
  "input": {
    "extension": "mp3",
    "contentType": "audio/mpeg",
    "bytes": 1234567,
    "durationSeconds": 245.5,
    "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  }
}
```

Source metadata is optional for compatibility with existing clients and jobs.
When supplied, `sourceUrl` is accepted only with `sourceKind: "url"` and must be
the canonical HTTPS form `https://www.youtube.com/watch?v=<11-character-id>`.
The durable job retains that URL for authorized dashboard inspection; retry jobs
inherit it and user deletion clears it with the source title.

Returns `201` with `{ "id", "status", "upload" }` for a new
`awaiting_upload` job. Repeating the same request ID and declaration returns the
same reservation state, including the `requestId`. Reusing the request ID for different input or metadata returns
`409 IDEMPOTENCY_CONFLICT`.

### `POST /jobs/:id/upload-url`

Renews the input upload grant for an owned `awaiting_upload` job. The body must
be `{}`. Returns `200` with an upload grant.

### `POST /jobs/:id/upload-complete`

The body must be `{}`. The API verifies the latest private S3 object, pins its
version, exact length, content type, and checksum, then transactionally enqueues
the job. Returns `200`:

```json
{ "id": "68c000000000000000000001", "status": "queued" }
```

An absent or mismatched object returns `409 UPLOAD_NOT_READY`.

### `GET /jobs`

Returns authenticated owner history newest first. Optional query fields are
`limit` (`1..100`, default `20`), opaque `cursor` (maximum 512 characters), and
`status`. Status is one of:

`awaiting_upload`, `queued`, `validating`, `processing`, `uploading_result`,
`interrupted`, `cancel_requested`, `ready`, `failed`, or `cancelled`.

```json
{
  "items": [
    {
      "id": "68c000000000000000000001",
      "status": "ready",
      "createdAt": "2026-09-09T12:00:00.000Z",
      "updatedAt": "2026-09-09T12:04:00.000Z",
      "queuedAt": "2026-09-09T12:01:00.000Z",
      "finishedAt": "2026-09-09T12:04:00.000Z",
      "retryOfJobId": null,
      "input": {
        "extension": "mp3",
        "bytes": 1234567,
        "durationSeconds": 245.5
      },
      "error": null,
      "canDownloadInput": true,
      "canDownloadOutput": true
    }
  ],
  "nextCursor": null
}
```

### `GET /jobs/:id`

Returns the same safe job projection plus `workerAvailable: boolean`. It never
returns S3 keys, object versions, worker data, push tokens, or diagnostics.

### `POST /jobs/:id/download-url`

Request body:

```json
{ "artifact": "input" }
```

`artifact` is `input` or `output`. Input is available after upload verification;
output is available only for a `ready` job. Returns `200` with a download grant.

### `POST /jobs/:id/cancel`

The body must be `{}`. Returns `200` with `{ "id", "status" }`. Pending or
queued work becomes `cancelled`; active work becomes `cancel_requested` until
the worker acknowledges that its process stopped. Repeats are idempotent.

### `POST /jobs/:id/retry`

Creates a new FIFO job from a retryable failed job and its pinned input. The
request needs processing access.

```json
{ "requestId": "3b053c0f-81d4-4fb8-bd5b-4d1b70f9eb72" }
```

Returns `201` with `{ "id", "status", "retryOfJobId" }`. Failures caused by
invalid input require a new upload and return `409 NEW_INPUT_REQUIRED`.
Retry jobs inherit the source title, source URL, and current display name. A
deleted source cannot create another retry; replay of an already-created live
retry remains idempotent. See the additions for shared-input retention and
deletion behavior.

## Push registration routes

The installation UUID is supplied in the path and must belong to the
authenticated user. Its latest accepted device sync must also identify that
user as the installation's current owner. A delayed sync authenticated before a
newer account binding cannot reclaim ownership. An equal-auth-time cross-account
race invalidates ownership and push delivery until one account completes a
device sync with a freshly authenticated token.

### `PUT /devices/:installationId/push`

Registers, refreshes, rotates, or rebinds the installation's current FCM token.
The token is an opaque visible-ASCII string from 1 through 4096 characters.

```json
{ "token": "opaque-fcm-registration-token" }
```

Returns `200` without the token or its hash:

```json
{
  "installationId": "d7ea7de6-52e9-4b96-8834-3b517941bdb0",
  "active": true,
  "bindingRevision": 4
}
```

Only one active installation owns a token. An account switch deactivates the old
destination. A registration authenticated at or before the user's logout-all
cutoff is not eligible for delivery; a later authenticated registration restores
eligibility.

### `POST /devices/:installationId/push/deactivate`

The body can be `{}` for legacy clients, or include the revision returned by the
client's successful registration:

```json
{ "expectedBindingRevision": 4 }
```

`expectedBindingRevision` is optional and must be a positive safe JSON integer
(`1..9007199254740991`). Explicit `null`, strings, fractions, out-of-range values
and unknown fields return `400 INVALID_INPUT`.

When supplied, deactivation applies only to that authenticated owner's matching
active binding revision. A stale revision returns `204` without changing the
newer binding. Clients should retain the registration revision and include it
when deactivating during logout, so a delayed request cannot disable a newer
registration. An omitted revision preserves the legacy behavior of deactivating
the authenticated owner's current active binding.

The action is idempotent and returns `204` with no body, including when its
binding is already inactive or its revision no longer matches. Registration
history is retained.

## Mobile outcome notifications

Ready and failed outcomes use one visible FCM notification with generic text and
these unchanged string data keys:

```json
{
  "type": "audio_job_outcome",
  "jobId": "68c000000000000000000001",
  "eventId": "68c000000000000000000002",
  "outcome": "ready"
}
```

The title is `Vocal`. Ready body: `Your audio is ready. Open Vocal to listen.`
Failed body: `Audio processing could not finish. Open Vocal for details.`
No input names, media URLs, account identity, worker diagnostics or credentials
are included in visible content or data. The destination token exists only in the
server-to-FCM addressing field.

- Android: `android.priority=normal`, `android.notification.channelId=audio_processing_outcomes`,
  `sound=default`, and `tag=eventId`. Create that channel at app initialization
  with default importance, before registration/delivery; respect the user's channel
  and permission settings. The tag replaces an existing tray entry for the same
  event. Transport priority does not set channel importance.
- Apple: `apns-push-type=alert`, `apns-priority=5` (nonurgent outcome update),
  `apns-collapse-id=eventId`, and explicit `aps.alert` title/body with
  `aps.sound=default`. This is an alert, without silent background delivery flags.
  Firebase maps the registered Apple destination; no hardcoded topic or environment
  is supplied. Collapse identifiers reduce duplicate pending alerts, but do not
  guarantee exactly-once display after prior delivery.

The common `notification` object and platform overrides form a single message.
Background clients let FCM/APNs display it; do not schedule a second local alert.
Foreground clients refresh state without generating a local alert; iOS foreground
presentation should also be suppressed for this event type. A tap carries only a
refresh hint: deduplicate `eventId`, authenticate the current session and fetch the
owner-scoped job before navigation. Never switch accounts based on notification
contents. Denied/delayed push must not block foreground/manual refresh.

The durable outbox, frozen destination bindings, eligibility checks, bounded
retries, invalid-token handling and stable event IDs are unchanged. Delivery
remains at least once; clients must tolerate repeated hints. Real Firebase/APNs
configuration, signing, permissions and device delivery need separate validation;
payload tests and simulator injection do not prove live delivery.

Platform references: [Firebase cross-platform messages](https://firebase.google.com/docs/cloud-messaging/customize-messages/cross-platform),
[Android channel and tag fields](https://firebase.google.com/docs/reference/admin/node/firebase-admin.messaging.androidnotification),
[Apple APNs request headers](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

## Worker routes

The worker creates a new UUID `sessionId` for each supervisor boot. An assignment
is selected by `jobId`, `attemptId`, `sessionId`, and integer `generation`. These
selectors do not authenticate a request; every call still needs the worker
Authorization header.

Event-bearing operations add a fresh UUID `eventId`. Repeating the same event
with the same body returns its stored outcome. Reusing an event ID with a
different body returns `409 IDEMPOTENCY_CONFLICT`.

### `POST /worker/claim`

```json
{ "sessionId": "8bc7d085-2376-4bc7-8fe6-1c5433ec0d7b" }
```

An optional `waitSeconds` accepts a JSON integer from `0` through `25`, default
`0`. Explicit `null`, strings, fractions and out-of-range values return
`400 INVALID_INPUT`. This field belongs only to claim, not heartbeat, stage or
other assignment callbacks.

An omitted or zero wait preserves immediate claims: with no queued work,
returns `204` and `Retry-After: 15`. A positive wait checks MongoDB immediately,
then rechecks at intervals of at most one second until work is available or the
wait expires. Each check completes its transaction before waiting; MongoDB FIFO
and the single active assignment remain authoritative across API instances.
An empty completed wait returns `204` and `Retry-After: 0`, so the worker can
immediately open another wait. For example:

```json
{ "sessionId": "8bc7d085-2376-4bc7-8fe6-1c5433ec0d7b", "waitSeconds": 25 }
```

The API permits eight simultaneous positive waits per API process; further
requests return `429 RATE_LIMITED` with `Retry-After: 1`. Existing request rate
limits also apply. Client disconnect and API shutdown cancel wait timers and
remove listeners. A claim already executing may still commit when its client
disconnects; it remains assigned and is recovered by repeating the same session
or using the normal stopped-process reconciliation protocol. A disconnect never
unlocks or requeues an assignment.

Set client and reverse-proxy response timeouts above the requested wait plus
database/grant and network overhead (the Windows client uses `15 + waitSeconds`
seconds, or 40 seconds for a 25-second wait). Deploying the API first lets old
workers keep using immediate claims. New workers fall back to a claim without
`waitSeconds` if an older API rejects that field with `400`; they retain the
one-second idle delay in fallback mode. Claim again immediately after a completed
job; a successful assignment never needs an extra idle delay.

Available work returns `200` with the assignment and a fresh pinned input download grant:

```json
{
  "jobId": "68c000000000000000000001",
  "attemptId": "50f65d3b-0d9d-44cd-8fa1-a8ebfb02c47c",
  "sessionId": "8bc7d085-2376-4bc7-8fe6-1c5433ec0d7b",
  "generation": 7,
  "status": "validating",
  "cancelRequested": false,
  "leaseExpiresAt": "2026-09-09T12:01:30.000Z",
  "input": {
    "extension": "mp3",
    "contentType": "audio/mpeg",
    "bytes": 1234567,
    "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "durationSeconds": 245.5,
    "download": {
      "url": "https://private-bucket.example/object",
      "expiresAt": "2026-09-09T12:15:00.000Z"
    }
  }
}
```

A same-session repeat returns its live assignment. When a previous assignment
must be recovered, claim returns `409` with `code: WORKER_RECOVERY_REQUIRED`,
`previousAttemptId`, and `canRecover`. The boolean is true only when the request's
session owns the current attempt. A worker that persisted its installation
session before claiming may use this confirmation to recover a lost claim
response even when its assignment journal was never written. A different session
receives false and cannot infer that another installation has stopped.

The worker must stop every contained process from that attempt before calling
reconcile, including when `canRecover` is true. The flag is ownership information,
not proof of process termination; stopped attestation and generation fencing
remain mandatory. Preserve the installation session on disk and never copy it
to another machine.

### `POST /worker/heartbeat`

Accepts the four assignment selectors. Returns `200` with `status`,
`cancelRequested`, and a renewed `leaseExpiresAt`. Send heartbeats every 20
seconds; the configured lease is 90 seconds by default. A stale or expired
assignment returns `409 STALE_ATTEMPT`.

### `POST /worker/stage`

Reports successful input validation and entry into processing:

```json
{
  "jobId": "68c000000000000000000001",
  "attemptId": "50f65d3b-0d9d-44cd-8fa1-a8ebfb02c47c",
  "sessionId": "8bc7d085-2376-4bc7-8fe6-1c5433ec0d7b",
  "generation": 7,
  "eventId": "66315840-cc9d-4af2-a815-f1d21cd68818",
  "stage": "processing",
  "durationSeconds": 245.5,
  "decodable": true,
  "hasAudio": true
}
```

Returns `200` with `{ "status": "processing" }`.

### `POST /worker/output-url`

Reserves the voice-only MP3 output and returns its direct S3 upload grant. The
body contains the assignment selectors and `eventId`, plus:

```json
{
  "bytes": 654321,
  "durationSeconds": 245.5,
  "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "contentType": "audio/mpeg",
  "playable": true,
  "voiceOnly": true
}
```

All fields are combined in one JSON object. `bytes` must be positive and below
`PROCESSING_OUTPUT_MAX_BYTES` (30,000,000 by default); duration is positive and
below 600. Returns `200` with `{ "status": "uploading_result", "upload": ... }`.

### `POST /worker/complete`

Accepts the assignment selectors and `eventId`. The API verifies and pins the
reserved output before durably completing the job. Returns `200` with
`{ "status": "ready" }`.

### `POST /worker/fail`

Accepts the assignment selectors and `eventId`, `stopped: true`, a `stage` of
`validating`, `processing`, or `uploading_result`, an optional integer `exitCode`
from -2147483648 through 4294967295, and one allowlisted `code`:

`INVALID_AUDIO`, `INPUT_TOO_LONG`, `INPUT_CHECKSUM_MISMATCH`,
`SEPARATOR_FAILED`, `OUTPUT_INVALID`, `DOWNLOAD_FAILED`, or
`OUTPUT_UPLOAD_FAILED`.

Returns `200` with `{ "status": "failed" }`, or `cancelled` if cancellation was
already pending. Arbitrary messages and process output are not accepted.

### `POST /worker/cancelled`

Accepts the assignment selectors and `eventId` with `stopped: true`. Returns
`200` with `{ "status": "cancelled" }` when cancellation was pending.

### `POST /worker/reconcile`

```json
{
  "sessionId": "8bc7d085-2376-4bc7-8fe6-1c5433ec0d7b",
  "previousAttemptId": "50f65d3b-0d9d-44cd-8fa1-a8ebfb02c47c",
  "stopped": true
}
```

`stopped: true` is a trusted-worker attestation that the previous separator
process and its descendants have stopped. The API cannot verify the remote
process tree. The worker must never send this assertion while old processing can
still write output.

Reconcile first resolves pending cancellation, then adopts a valid already
uploaded result when present, otherwise replaces the attempt on the same job.
Returns `200` with either a normal assignment or `{ "jobId", "status" }` for a
durable `ready`, `failed`, or `cancelled` outcome. Repeating reconcile returns the
same replacement assignment or terminal outcome. Recovery storage uncertainty
returns `503`; it never proves an output absent.

## Error responses

Errors use a safe JSON envelope:

```json
{
  "statusCode": 409,
  "code": "JOB_STATE_CONFLICT",
  "message": "This action is not available for this job"
}
```

Common statuses are `400 INVALID_INPUT`, `401 UNAUTHENTICATED`, `403` for
account or processing-policy denial, `404 JOB_NOT_FOUND`, `409` for state,
idempotency, upload, stale-attempt, and recovery conflicts, `429 RATE_LIMITED`,
and sanitized `503 SERVICE_UNAVAILABLE`. Internal diagnostics, tokens, object
keys, and provider errors are never returned.

See [media policy v2 and shared allowance](media-policy-v2.md) for additive policy, admission, worker evidence, and admin contracts.
