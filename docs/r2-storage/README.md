# Private Cloudflare R2 storage

This is the current storage setup and contract for MusicMute. The owner approved
an R2-only breaking change on 2026-09-30. The initial plan allowed an owner-managed
fresh database; the subsequent rollout preserves current MongoDB data and worker
pairing. Any database reset remains a separate owner action.
There is no AWS fallback, old-record bridge, migration copy, or database
reset command. Dated AWS/S3 validation records elsewhere describe earlier releases;
they do not establish R2 behavior and their provider setup/acceleration commands
must not be used for this implementation.

The [local validation record](VALIDATION.md) lists executed checks and the
remaining separate fixture, simulator and live verification boundaries.
The [September 30 rollout](ROLLOUT-2026-09-30.md) and
[October 1 continuation](ROLLOUT-2026-10-01.md) record actual deliveries and
remaining publication/distribution gates.

## Repository audit

| Area                     | Storage boundary addressed                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend                  | Required generic R2 configuration, S3-compatible presigning, create-only PUT identity, ETag schemas, owned media downloads, retention/deletion, cached storage health    |
| Android/iOS/web          | Opaque grants and exact signed headers, generic uploader names, no storage credentials; web CSP uses explicit R2 origin                                                  |
| Worker/CLI               | Input integrity and conditional download, output PUT/recovery/completion ETag contract, enrollment/qualification/runtime artifacts without permanent storage credentials |
| Dashboard/releases       | Exact signed APK upload headers and backend identity verification; no browser secret/configuration exposure                                                              |
| Installer/catalog        | Old provider-specific runtime/fixture entries removed; real R2 publication and signature/hash verification required before activation                                    |
| Configuration/deployment | Safe backend env examples updated; Docker/CapRover/CI use runtime configuration, without baked provider secrets or extra storage services                                |
| MongoDB                  | Key/ETag/bytes/checksum/type identities; no migration/reset/copy automation                                                                                              |
| Tests/tools/docs         | R2 fixtures, explicit opt-in dedicated-bucket integration/benchmark, generic credential scanner, current setup/contracts and marked historical evidence                  |

## Architecture

```text
Client / worker / CLI / dashboard
        | authenticate and request an owner-scoped transfer grant
        v
NestJS storage services (backend-only R2 credentials)
        | local S3-compatible presigning
        v
Private R2 Standard bucket
        ^ direct upload/download through temporary opaque URLs
        | client receives only URL, expiry and required request headers
```

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` intentionally remain:
Cloudflare documents these SDKs for its S3-compatible API. `x-amz-*` signing and
checksum headers are protocol names, not AWS provider configuration. Clients must
copy the URL and headers supplied by the backend, never construct bucket URLs or
receive R2 access keys. Do not introduce Cloudflare Workers, an R2 public domain,
or another paid service for ordinary transfers.

## Backend configuration and deployment

Create the private `music-mute` bucket with **Standard** storage. Keep the `r2.dev`
public URL and public custom-domain access disabled. In the Cloudflare dashboard,
create R2 S3 API access credentials with object read/write access scoped to this
bucket. The R2 S3 API credentials differ from a general Cloudflare API token.
Record the Account ID and store the credentials only in an ignored backend env
file or the deployment secret manager.

```env
STORAGE_PROVIDER=r2
STORAGE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_BUCKET=music-mute
STORAGE_ACCESS_KEY_ID=CHANGE_ME
STORAGE_SECRET_ACCESS_KEY=CHANGE_ME
```

`STORAGE_ENDPOINT` is the HTTPS account root, without `/music-mute`, trailing slash, query,
credentials or fragment. Western Europe (`WEUR`) is the bucket location hint;
the signing region remains `auto`. All six values are required at startup. There
is no SDK default credential chain, AWS profile, session token, regional endpoint
fallback, acceleration option, or automatic provider detection.

| Removed storage variable               | Current configuration                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `AWS_REGION`                           | `STORAGE_REGION=auto`                                                        |
| `S3_BUCKET` / `AWS_S3_BUCKET`          | `STORAGE_BUCKET`                                                             |
| `AWS_ACCESS_KEY_ID`                    | `STORAGE_ACCESS_KEY_ID`                                                      |
| `AWS_SECRET_ACCESS_KEY`                | `STORAGE_SECRET_ACCESS_KEY`                                                  |
| `AWS_SESSION_TOKEN` / AWS profile      | Removed; explicit backend R2 credentials                                     |
| `S3_TRANSFER_ACCELERATION_ENABLED`     | Removed                                                                      |
| Regional/accelerated S3 URL assumption | `STORAGE_ENDPOINT` in backend; exact `PUBLIC_MEDIA_ORIGIN` in browser server |
| `PUBLIC_MEDIA_ACCELERATION_ENABLED`    | Removed                                                                      |

CapRover, Compose and direct Node deployments pass these backend runtime values;
do not embed them in Docker image layers, frontend bundles, worker installers,
CLI packages or provider adapters. The browser server's `PUBLIC_MEDIA_ORIGIN` is
only the exact non-secret R2 HTTPS origin allowed by its CSP; it contains no bucket
key or signature. The provider adapter continues returning audio to NestJS and
receives no R2 credentials.

## R2 identity and transfer safety

R2 does not provide the old object-versioning contract. MongoDB now stores the
server-generated key, opaque quoted `etag`, byte length, base64 SHA-256,
content type and existing ownership metadata. Do not treat ETag as SHA-256 or strip
its quotes. Keys remain owner/job/attempt scoped and are never reused. The backend
reserves an upload before granting it and signs a create-only PUT with:

```text
Content-Type: <declared approved type>
x-amz-checksum-sha256: <canonical padded base64 SHA-256>
x-amz-meta-sha256: <the same canonical padded base64 SHA-256>
If-None-Match: *
```

R2 validates the actual PUT checksum. After upload, one HEAD confirms ETag,
size, content type and the signed checksum metadata. If the provider returns
`ChecksumSHA256`, it must also match; an omitted returned checksum is not a reason
to bypass the required PUT checksum or signed metadata. Metadata alone is not an
independent hash of the bytes; it is trustworthy here because the same checksum
was bound to and validated by the create-only signed PUT.

Worker completion and qualification confirmation use `etag` instead of
`version_id`. Stored object grants also expose `etag`; updated workers and backend
must be deployed together. Attempt/session fencing, idempotency, size/type limits,
user ownership checks, quota accounting, signatures and release hashes remain
required. Authorized download grants sign the exact confirmed unique key; the stored ETag
remains its database identity. Create-only keys avoid requiring custom GET headers
for native/browser playback; workers add `If-Match` for their expected object and still verify downloaded
size/SHA-256. No Firebase
or worker bearer token is attached to the object-storage request.

Temporary grants retain their existing bounded expiration settings. Local signing
performs no R2 network call. One HeadBucket request at startup checks connectivity;
health views use cached startup/actual transfer observations. Successful observations become unknown
after five minutes without fresh evidence, without interval storage reads; failures
remain unavailable until a successful operation is observed. Signing a confirmed download does not repeatedly HEAD
the same object; clients still handle a missing object or an expired grant safely.
A successful input/output processing path verifies each uploaded object once.

## Browser CORS

Configure CORS on R2 separately from the API's `CORS_ORIGINS` and the browser
server's CSP. Native applications do not enforce browser CORS. An example for the
current production browser origins is:

```json
[
  {
    "AllowedOrigins": [
      "https://app.music-mute.com",
      "https://dashboard.music-mute.com"
    ],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": [
      "Content-Type",
      "x-amz-checksum-sha256",
      "x-amz-meta-sha256",
      "If-None-Match",
      "Range"
    ],
    "ExposeHeaders": [
      "ETag",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

Add only the exact local browser origins used for development to a development
bucket's policy. Do not use a wildcard origin, public bucket access, client-side
DELETE, or storage credentials to solve a CORS failure. Keep the exact required
signed headers; unsupported/missing headers must fail instead of loosening signing.
Backend HEAD requests do not require browser CORS. Add HEAD only for a separately
verified browser use case. Only the backend deletes objects. Test an actual browser
PUT and ranged GET after manual bucket setup; local HTTP fixtures do not prove the deployed CORS policy.

## Retention, cleanup and billing

Use Standard for media, runtime archives, APKs and qualification fixtures. No
Intelligent-Tiering, Infrequent Access transition, archive tier, transfer
acceleration, or extra metered proxy is enabled. Standard has no minimum storage
duration; Infrequent Access adds retrieval charges and a minimum duration, which
is unsuitable for short-lived processing files.

Local uploads retain private account/job storage: completed originals remain
available for Original/Voice playback and successful results remain until
job/account deletion. New URL imports use
[permanent shared media](../url-imports/shared-media.md) under `shared/url/`.
User jobs reference the same confirmed original and matching recipe output;
worker output is copied once during first publication, never once per user.
Shared files/catalog rows have no TTL and are excluded from job/account deletion
and application cleanup. The storage service rejects shared deletion. Do not
configure bucket lifecycle expiration for this namespace.

Chrome/Mac YouTube guest publication uses
`quarantine/youtube/<contribution ID>/input/source.<extension>` and
`quarantine/youtube/<contribution ID>/output/vocals.mp3` for create-only paired
upload grants. Backend validation publishes each accepted pair into the same
permanent shared catalog, with separate community provenance. Guest declarations
and grants have scoped byte budgets; they create no account job or upload quota
entry. A dedicated exact-key cleanup ledger waits for grant expiry and transfer
settlement before removing quarantine objects. It cannot delete `shared/` objects.
See [YouTube community publication](../url-imports/youtube-community.md) for
capability expiry, producer claims, immutable recovery and validation boundaries.

Invalid, abandoned, cancelled, failed and stale attempt files use existing durable
leased cleanup by exact key. Never scan or delete a bucket prefix during routine
cleanup. Cleanup waits through the recorded grant deadline plus a one-hour transfer
settlement window, performs exact-key DELETE and stores durable `firstDeletedAt`
for general tasks or `cleanupFirstDeletedAt` for job-deletion cleanup.
A second exact-key DELETE two hours later catches delayed PUT completion; only
then is cleanup completed. Both DELETEs are free R2 operations, with no HEAD/list.
Restart and replica contention resume the durable stage; failures retry normally.
R2 may finish a request begun before signed expiry after that expiry; the settlement horizon is a bounded
application policy, not proof of an unlimited external transfer having stopped.
Late PUT/cleanup races require explicit bounded integration verification. Account
purge still removes completed key records; this migration does not add long-term
key tombstones or retain a deleted account's private object metadata. A manual retry
after private input cleanup requires a fresh input rather than reusing the old key.
Do not expire stored originals/results globally just to reduce storage cost. If multipart is introduced later, add narrowly scoped incomplete
multipart cleanup; ordinary media currently uses single PUTs.

Published Standard prices checked in the official documentation on 2026-09-30:

| Usage                                       | Monthly free allowance | Standard rate beyond allowance |
| ------------------------------------------- | ---------------------- | ------------------------------ |
| Storage                                     | 10 GB-month            | $0.015/GB-month                |
| Class A operations (including writes/lists) | 1 million              | $4.50/million                  |
| Class B operations (including GET/HEAD)     | 10 million             | $0.36/million                  |
| Direct R2 egress                            | Free                   | Free                           |
| DeleteObject                                | Free                   | Free                           |

These are account-level allowances, not a guarantee of a zero invoice. Avoid
repeated HEADs, lists, health polling or synthetic uploads against the real bucket.
Reuse verified local audio caches. Compare provider billing with usage counters;
application download-grant estimates cannot meter URL replays precisely.

## Fresh database and installation artifacts

Any owner-managed MongoDB recreation is outside this implementation. The current
rollout preserves existing current-schema records. The new schemas do not
interpret old version IDs; no old-record bridge or old audio copy is implemented.
Deleting MongoDB does not delete old AWS objects or stop their storage charges.
No AWS bucket/object deletion is authorized or implemented here.

Before real worker enrollment/update/qualification, republish required runtime
archives and the bounded synthetic qualification fixture to R2 through the existing
trusted release pipeline. Verify each unique key's ETag, bytes, SHA-256, type and
Ed25519 signature, then promote the corresponding installation catalog. Publish
required APK releases through the existing administrator upload/verification flow.
The initial migration catalog was intentionally empty. The current catalog now
contains verified private R2 macOS/Windows 0.1.2 runtime objects and the synthetic
qualification fixture. Their publication and separate native acceptance boundaries
are recorded in the dated rollout guides; catalog presence alone does not prove
activation or npm publication. Do not invent ETags or reuse old signed identities.
The direct-owner model catalog remains unchanged: **do not mirror model weights**
to R2 or change upstream model URLs just because they use another host/provider.

If preserving historical data becomes a separate requirement, copy every referenced
exact source object/version under the same key, validate bytes/hash, and rebuild
its ETag metadata before switching. That is outside this fresh-database scope;
never invoke Super Slurper/Sippy or delete source data automatically.

## Local verification and optional live check

Normal unit/integration suites use local fixtures and require no real R2 keys.
`backend/scripts/benchmark-audio-transfers.test.mjs` covers signed create-only PUT,
HEAD identity, checksum metadata when the returned checksum is absent, conditional
GET integrity, exact-key cleanup, and uncertain PUT recovery using mocks.

The real benchmark is manual and can incur usage. Supply dedicated test-bucket
credentials via the process environment, **never `.env.production`**, and choose
a bucket other than `music-mute` or `STORAGE_BUCKET`:

```sh
# STORAGE_* values are supplied securely by the caller, never pasted into Git.
node scripts/benchmark-audio-transfers.mjs \
  --bucket musicmute-r2-transfer-test --allow-writes
```

Default traffic is one 1 MiB PUT, one HEAD, one GET and one DELETE. Bounds are
1–3 rounds and at most two sizes from 1, 4 and 16 MiB. The tool never lists a
bucket, changes bucket settings, reads user media, loads dotenv, or prints signed
URLs/credentials/provider errors. `cleanup_pending` contains only generated keys;
reconcile those after grant expiry and the in-flight transfer window if cleanup
was uncertain. A mock pass is not live R2 acceptance.

The backend's real worker integration suite is separately gated:

```sh
MUSICMUTE_R2_INTEGRATION=true pnpm run test:worker:integration:r2
```

Supply explicit `STORAGE_*` values for a dedicated private test bucket matching
`music-mute-test-<suffix>` via a secure caller environment. Without opt-in it skips;
it never loads `.env.production`. It can incur PUT/HEAD/GET/storage usage and uses
isolated local MongoDB/Redis plus synthetic test objects. Normal
`test:worker:integration` remains fixture-only. A separate opt-in does not authorize
production media access or environment changes.

Before enabling real processing, separately verify private access, checksum
rejection, overwrite rejection, signed URL expiration, browser CORS/ranges,
worker input/output, qualification, installer artifacts, APK verification and
failed/abandoned cleanup with bounded synthetic files. No deployment, bucket
configuration, destructive database operation, data copying or live billing test
is implied by local validation.

## Sources and API review

- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 AWS SDK example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 browser CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

The [official Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-09-30. Rules 101 (OpenAPI), 104 (security), 118 (snake_case),
182 (ETag/conditional requests) and 176 (Problem JSON) shape this change.
The owner explicitly approved the storage-identity break and fresh database,
which is the documented exception to the usual compatibility requirement (rules 106/107).
REST-specific rules do not replace the existing raw WebSocket protocol.
