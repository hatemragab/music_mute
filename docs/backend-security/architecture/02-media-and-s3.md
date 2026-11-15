# Unified media, S3 lifecycle, and cost accounting

## Objective

Use one backend-authoritative media policy and protect storage/request/bandwidth
costs without proxying audio through NestJS. Preserve the existing private-bucket,
exact-key, checksum, size, version, and attempt-fencing foundations.

## One media policy

The only launch acceptance limits are:

- duration `<= 1,200` seconds;
- prepared upload `<= 50,000,000` bytes.

Delete legacy policy-v1/v2 branches and conflicting client constants. Clients may
reject obviously invalid input early but must consume the backend policy response.
The backend repeats every check and remains authoritative.

Validate at two points:

1. declaration/grant time: integer size, supported extension/type, declared
   duration, account/grant capacity;
2. confirmation time: exact owner key, immutable version, real size, content type,
   checksum, media duration, and job state.

Confirmation must fail safely if metadata differs. An invalid object is scheduled
for exact-object cleanup and never reaches the queue.

## Upload grant accounting

Before creating a new grant, atomically enforce:

- account is active and unrestricted;
- account has fewer than 30 grants in the UTC day;
- account has fewer than 200 grants in the UTC month;
- declared upload can fit within remaining monthly confirmed bytes;
- logical-audio attempt count is below five;
- waiting-job and retained-output admission are available;
- service is not blocked by an operational safety gate.

Idempotent replay of the same request returns the original grant. A genuinely new
grant increments daily/monthly grant counters even when unused. The grant record
is short lived, owner scoped, and linked to one server-generated logical-audio
family so changing a request UUID cannot reset the five-attempt boundary.

At confirmation, atomically count the verified size once. Duplicate confirmation
returns the prior result. Monthly confirmed-byte accounting never trusts a client
reported total.

## Object identity

Continue using owner/job-scoped keys:

```text
users/<account-id>/jobs/<job-id>/input/<random>.<extension>
users/<account-id>/jobs/<job-id>/attempts/<attempt-id>/vocals.mp3
```

MongoDB stores key, immutable version ID, bytes, checksum, type, and ownership.
Never store a presigned URL. The backend signs only the exact key after ownership
and limit checks.

## Signed URL rules

- Upload and download grants expire in at most 600 seconds.
- Required upload headers are part of the signed request.
- The bucket policy separately rejects query-signed requests with
  `s3:signatureAge > 600000` milliseconds.
- A URL is a bearer capability and may be reused until expiry; do not claim it is
  single use.
- A refreshed URL is a new grant unless it is an idempotent replay of the same
  still-valid request.

## Download accounting

Before issuing a result URL:

1. authorize the account and job ownership;
2. confirm the immutable result still exists and matches stored identity;
3. calculate `estimatedBytes = storedResultBytes`;
4. atomically enforce 150 monthly grants and 10,000,000,000 monthly estimated
   bytes;
5. atomically enforce the 80,000,000,000 monthly service outbound ceiling;
6. record the grant and estimate once;
7. issue the exact-key URL.

The API cannot reliably observe how many times a presigned URL is used. User-facing
copy must say "download access" or "download grants," not claim byte-perfect actual
transfer metering.

Valid local cached playback does not call the grant endpoint. Worker input grants
add their object size to the service estimate but not the user's result-download
grant count.

## Retained storage

Count only verified, published, successful output objects against the
1,000,000,000-byte account retained-output limit. Temporary inputs, stale attempts,
and objects already in cleanup do not count as retained results.

Admission is blocked when retained successful bytes are at or above the effective
limit. A result already processing may finish and cause a bounded overshoot; retain
it and block later admissions. Deleting a completed job decrements retained bytes
only after exact object deletion is durably completed or reconciled as missing.

## Lifecycle and cleanup

| Object                                | Retention                                                       |
| ------------------------------------- | --------------------------------------------------------------- |
| Successful published output           | Indefinite until job/account deletion                           |
| Current input during eligible retries | Until terminal outcome                                          |
| Terminal input                        | Cleanup eligible immediately; target completion within 24 hours |
| Abandoned/unconfirmed upload          | Cleanup eligible after grant/reservation expiry                 |
| Invalid upload                        | Cleanup eligible immediately                                    |
| Cancelled/failed/stale attempt output | Cleanup eligible immediately                                    |

Cleanup is exact-key/version, idempotent, leased, retryable, and bounded. A missing
object is successful reconciliation. Never use owner-prefix deletion during normal
job cleanup. Account deletion may enumerate owner-scoped records but still deletes
verified exact objects/versions.

The existing cancelled-upload orphan path must have an explicit regression test.

## Intelligent-Tiering

Use S3 Intelligent-Tiering for successful audio:

- Frequent Access initially;
- automatic Infrequent Access after 30 days without access;
- automatic Archive Instant Access after 90 days without access;
- no optional Archive Access or Deep Archive Access tiers at launch.

The code sets the intended storage class for newly stored successful results. The
operator configures and verifies the matching bucket/lifecycle policy using the
provider runbook. Do not silently change the live bucket from a code branch.

## Client and admin behavior

Android and iOS show the same 20-minute/50-MB limits and safe account-limit errors.
They do not own authoritative counters. Retrying an uncertain identical request
reuses its idempotency key. A new user-requested replacement follows the five-attempt
contract.

Admin usage views show upload grants, confirmed bytes, download grants, estimated
download bytes, retained output, effective limits, and period boundaries. Admins
change policy/overrides, not raw counters or S3 metadata.
