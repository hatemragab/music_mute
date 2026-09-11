# Audio experience API additions

Implemented additions to [audio processing](audio-processing.md). Paths are relative
to `/api/v1`. Normal Firebase account authentication applies. Only the existing
create/upload/retry operations need processing-access installation headers; rename,
delete, history, and diagnostics do not add such a requirement. Unknown fields are
rejected. Dates use UTC ISO strings and IDs follow the existing ObjectId/UUIDv4 contract.

## Source metadata and identity

`POST /jobs` accepts optional top-level `sourceTitle` (trimmed, 1–200 Unicode
characters without control characters), `sourceKind` (`url` or `file`), and
`clientStartedAt` (UTC ISO date ending in `Z`, with at most three fractional digits).
Omit missing fields rather than supplying null. Source URLs/local paths are not
metadata fields. `requestId` is the mobile operation reference created before
download/import, and is now returned with the reservation response.

Metadata participates in the immutable request hash. Replay the original normalized
metadata after an uncertain response. Clients omitting metadata keep their existing
hash behavior. A later rename does not change the create hash. Replay of a deleted
reservation returns 404 and never recreates it. Initial `displayName` is `sourceTitle`;
clients with an earlier local rename apply PATCH after reservation.

## Job projection

List/detail return these additional fields, alongside all existing fields:

```json
{
  "requestId": "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
  "sourceTitle": "Interview",
  "displayName": "My interview",
  "sourceKind": "url",
  "serverTime": "2026-09-10T12:04:00.000Z",
  "timing": {
    "processingElapsedMs": 20000,
    "processingElapsedApproximate": false,
    "totalElapsedMs": 70000,
    "totalElapsedApproximate": true
  },
  "stages": {
    "validatingAt": "2026-09-10T12:03:25.000Z",
    "processingStartedAt": "2026-09-10T12:03:30.000Z",
    "processingFinishedAt": "2026-09-10T12:03:50.000Z",
    "uploadingResultAt": "2026-09-10T12:03:50.000Z"
  }
}
```

Names/source kind and unavailable stage dates are null for legacy records.
Processing timing is null if the full job was not measured by this version; otherwise
it sums separation intervals and excludes queueing, validation, output upload, and
worker downtime. An active interval is extrapolated using `serverTime` only while its
lease is live. Interruption uses the last observation and marks the value approximate.

Total elapsed is approximate because it starts at `clientStartedAt`. It is null if
that timestamp is missing, ahead of job creation, or more than seven days before
creation. The originating app can keep its local elapsed timer. Audio playback duration
(`input.durationSeconds`) is distinct. Dates never govern queue order or leases.

## Rename: PATCH /jobs/:id

Body: `{ "displayName": "My interview" }`. Returns 200 with the safe job projection.
Allowed for active and terminal jobs owned by the user. Names follow the same 1–200
Unicode-character limit; duplicate display names are allowed. Source title, object keys,
and request hash remain unchanged. Retry jobs inherit the latest name.
Missing/deleted/foreign jobs return `404 JOB_NOT_FOUND`.

## Delete: DELETE /jobs/:id

No body or `{}`. Returns 204 without a body for an owned ready/failed/cancelled job,
including repeat owner deletion. Active jobs return `409 JOB_ACTIVE` and must be
cancelled first. Missing/foreign jobs return `404 JOB_NOT_FOUND`.

Deleted jobs disappear from history, return 404 on detail, and cannot be renamed,
retried, or granted new artifacts. A tombstone preserves request/diagnostic identity;
private S3 media cleanup is durable and retryable. A live retry protects its shared
pinned input. Existing signed grants are not instantly revoked; their expiry or actual
version removal ends access. External saved/shared copies are outside this operation.

Clients evict cached job media after acknowledgement and reconcile cached detail after
another device deletes an item. Absence from only one paginated page is not evidence of
deletion. Originals imported from Files/another app are not deleted by the client.

## Diagnostics: POST /client-errors

Available with normal authenticated account access, even if processing is disabled.
Returns 201 with `{ "eventId": "<same-event-uuid>" }`.

```json
{
  "eventId": "bba62714-ab09-4c79-9453-ccae688c092c",
  "operationId": "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
  "stage": "DOWNLOADING_SOURCE",
  "code": "NETWORK",
  "retryable": true,
  "platform": "android",
  "appVersion": "1.0.0",
  "osVersion": "15",
  "occurredAt": "2026-09-10T12:00:00.000Z",
  "httpStatus": 503
}
```

`jobId` is optional. When supplied, both ownership and that job's `requestId` must
match `operationId`. `httpStatus` is optional (100–599), `appVersion` 1–32 printable
characters, `osVersion` 1–64, `occurredAt` UTC ISO. The server owns `receivedAt` and
the authenticated user ID. Retry the same event/payload after a timeout; conflicting
reuse returns 409. Reports are limited to 30 requests per owner per minute; excess
requests (including repeated events) return 429 with `Retry-After`.

Stages: UNKNOWN, SOURCE_INTAKE, DOWNLOADING_SOURCE, PREPARING_INPUT, RESERVING_JOB,
UPLOADING_INPUT, CONFIRMING_UPLOAD, REFRESHING_JOB, CANCELLING, RETRYING,
FETCHING_OUTPUT, PLAYBACK, EXPORTING.

Codes: UNKNOWN, NETWORK, TIMEOUT, AUTHENTICATION, INVALID_MEDIA, SOURCE_UNAVAILABLE,
STORAGE, SERVER, JOB_NOT_FOUND, JOB_CONFLICT, CHECKSUM_MISMATCH, LOCAL_IO.

Map unrecognized exceptions to UNKNOWN, and share/export errors to EXPORTING. The
endpoint rejects raw messages, exceptions, tokens, URLs, audio bytes, local paths, and
client-supplied owner/receivedAt. Reports never change job state or overwrite worker
errors. Before-reservation reports remain linked through owner plus operationId,
returned later by job detail as requestId. Normal cancellation/share dismissal is not
an error. There is no public diagnostic listing endpoint.
