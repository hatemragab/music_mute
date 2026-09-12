# MusicMute security and cost hardening design

Date: 2026-09-12. Status: approved for local implementation; production infrastructure changes remain unapproved.

## Objective

Reduce avoidable S3, database, API and release-distribution exposure without adding monthly quotas, tokens, subscriptions, per-user lifetime limits or usage billing. Users may continue to submit and process unlimited songs. The controls in this design are integrity checks, short burst limits and cleanup guarantees, not product entitlements.

## Decisions

### Immutable uploads

Replace replayable presigned multipart POST grants with whole-object `PUT` grants. Every grant binds the reservation key, exact content length, content type, SHA-256 checksum and `If-None-Match: *`. A successful upload therefore creates the reserved object only when no current object exists; replay cannot create another current version at the same key.

The wire contract is:

```ts
interface UploadGrant {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}
```

Clients reject any other method, HTTPS violation, unexpected redirect or invalid required header. Browser code lets the user agent calculate `Content-Length`; native and worker clients set the exact file length. API bearer credentials are never sent to the storage host. Existing checksum verification and version pinning remain authoritative after upload.

### Durable orphan cleanup

Create a shared `storage_cleanup_tasks` collection for exact object keys under `users/` or `app-releases/`. Each task has a unique key, reason, optional owner user ID, due time, settlement deadline, lease token/expiry, retry count and completion timestamp. Cleanup repeatedly lists and deletes every version and delete marker for the exact key until the settlement deadline has passed and a final sweep is empty. This catches uploads which began before grant expiry but completed after the first cleanup pass.

Producers schedule only objects that are no longer semantically referenced:

- expired `awaiting_upload` audio jobs become failed with `UPLOAD_EXPIRED`, and their input reservation is scheduled;
- terminal failed/cancelled/interrupted or replaced attempts with an unconfirmed output reservation schedule that output key;
- expired, rejected or superseded APK upload reservations schedule their exact release key;
- account deletion waits for owner cleanup tasks before deleting the final account record.

Verified/published APK artifacts and confirmed job inputs/outputs are never scheduled merely because they are old. Task creation and the state transition that makes an object unreferenced occur in the same MongoDB transaction where possible. Cleanup runs independently of `AUDIO_PROCESSING_ENABLED` and is replica-safe.

### Burst protection without quotas

Authenticated processing endpoints receive generous per-minute UID buckets for reservation creation, upload-grant renewal/confirmation and job mutations. These counters reset continuously and do not cap monthly or lifetime usage. Existing global IP and authenticated UID protection remains.

Release upload reservation and completion require recent administrator authentication and the existing sensitive-operation rate class. Public APK grant endpoints use a tighter per-IP burst limit. This does not change which release is available.

### Release download exposure

Temporary direct-APK S3 grants last five minutes rather than one hour and remain version-pinned. A CDN/private-origin migration is an operator-owned infrastructure task and is not fabricated in application source. The public landing route remains functional with refreshable short grants.

### Bucket lifecycle safety

S3 versioning and all four public-access blocks remain mandatory. Lifecycle rules may only perform `AbortIncompleteMultipartUpload` or remove expired delete markers. Current-version expiration and noncurrent-version expiration remain forbidden because the database pins historical version IDs.

### Secret prevention

The backend verification pipeline scans tracked repository content for private-key blocks, Firebase service-account private keys, AWS access-key IDs and credential-bearing environment assignments. Examples with explicit placeholders remain permitted. The guard reports file and rule names only and never echoes secret values.

## Operational boundaries

- No AWS, Firebase, CapRover, DNS, CDN, bucket-policy, lifecycle or credential mutation is performed by this work.
- Existing live credentials still require operator rotation and least-privilege IAM review outside the repository.
- No commit, push, deployment, publication or real-user data deletion is included.
- Local tests and builds are evidence of source behavior, not production proof.
