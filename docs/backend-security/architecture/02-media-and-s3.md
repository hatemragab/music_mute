# Unified media, private R2 lifecycle, and cost accounting

This document describes the R2 storage boundary. The filename is retained for
existing links; the old AWS bucket/versioning/tiering design is superseded by
[the current R2 guide](../../r2-storage/README.md). Quota values come from the
backend's effective policy; this migration does not change quotas or scheduling.

## Admission and transfers

The backend authorizes account/job/attempt ownership, validates declared size,
content type, canonical SHA-256 and measured duration, and reserves capacity before
issuing an upload grant. Clients can reject obvious invalid files but do not own
counters or limits. Idempotent replay returns the same valid reservation; a new
grant is counted according to existing account/service budgets.

Media transfers remain direct between the client/worker and private R2. The
backend uses the S3-compatible SDK to sign locally; no separate Cloudflare service
or large-media proxy is introduced. URL-import audio still arrives through the
private adapter for independent NestJS probing and validation before a single
bounded R2 PUT and normal job submission.

## Object identity

Preserve existing owner/job/attempt key families:

```text
users/<account-id>/jobs/<job-id>/input/<random>.<extension>
users/<account-id>/jobs/<job-id>/attempts/<attempt-id>/vocals.mp3
```

Each key is reserved once and never reused. MongoDB stores key, opaque quoted
ETag, bytes, canonical padded base64 SHA-256, type and ownership. It stores neither
permanent provider URLs nor presigned URLs. R2 has no required AWS version ID.
The owner approved fresh MongoDB and an incompatible `version_id` → `etag` worker
contract; old records and old workers are not supported by a migration bridge.

The signed PUT includes approved Content-Type, matching
`x-amz-checksum-sha256`/`x-amz-meta-sha256` and `If-None-Match: *`. R2 verifies the
actual upload checksum. One confirmation HEAD validates size, content type,
ETag and signed checksum metadata, plus returned checksum when present. ETag is
not a substitute for SHA-256. A conflicting object is rejected and never queued.

Attempt/session fencing, transaction receipts and quota accounting still protect
confirmation, recovery and completion. An already-confirmed output reused after
an uncertain response retains its original verified identity instead of rewriting
the key. Downloads authorize the current owner and exact confirmed key/identity;
no repeat existence HEAD is needed just to sign another download grant.

## Signed grants and metering

Preserve existing bounded URL expiration settings and exact required headers.
Signed URLs are bearer capabilities and can be replayed until expiry; do not claim
one-time access. Only create-only conditional uploads prevent replacement of an
existing key. Never attach Firebase/worker bearer credentials to R2 requests.

Download-grant accounting uses verified stored bytes and the existing user/service
policy. It is an estimate, not invoice-perfect byte metering: a URL can be reused
and the API cannot observe every direct read. Cached local playback does not need
a new grant. Worker input grants retain their current service-accounting behavior.

## Retention and deletion

Successful originals and outputs remain for Original/Voice playback until
job/account deletion. Temporary invalid, failed, cancelled, abandoned and stale
attempt objects use existing durable leased cleanup by exact key. Wait through the
recorded grant deadline plus one hour, perform exact DELETE
and record durable `firstDeletedAt`, then repeat exact DELETE two hours later
before completion to catch delayed uploads. Resume the persisted stage after
restart/replica contention; both DELETEs are free and require no HEAD/list.
This is an application settlement policy, not a universal R2 transfer deadline.
Retry uncertain deletion and reconcile missing objects idempotently. Do not list
an account or bucket prefix during routine cleanup.

Manual retry after committed input cleanup requires a new input; never reuse an
old upload key. Account purge removes completed key records without retaining
long-term object tombstones. Deletion still decrements retained usage only when the
existing durable cleanup contract permits it. An invalid upload is not counted as retained output. Account
deletion obtains exact keys from owned database records and fences concurrent
uploads; it does not rely on deleting all bucket-prefix matches.

## Cost and provider setup

All objects use R2 Standard. No Intelligent-Tiering, Infrequent Access, acceleration,
ACL/versioning API checks or `s3:signatureAge` bucket policy is required.
One HeadBucket startup request checks connectivity. Health snapshots use cached
startup/transfer observations; they do not poll R2 or repeatedly inspect bucket
settings. Stale successful observations become unknown instead of claiming current
health;
failed observations remain unavailable until a later success.

Local signing makes no R2 request. Accepted uploads each require one identity
HEAD; direct GETs/HEADs are still metered Class B operations even though R2 egress
is free. Exact-key DeleteObject is free. Ordinary uploads use single PUTs. Keep
retention and access safety intact; do not add a global expiry rule for completed
media just to lower storage cost.

The operator configures private bucket access, explicit browser CORS and scoped
backend credentials using [the provider runbook](../runbooks/PROVIDER-CONSOLE-CHANGES.md).
Local mocks do not prove R2 permissions, CORS, checksum behavior, real transfer
performance or invoice amounts.
