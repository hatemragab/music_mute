# Branch 2: media and S3 cost protection

**Branch:** `hatem/media-s3-cost-protection`
**Create from:** updated collection after branch 1 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** B1–B7
**Status:** `NOT_STARTED`
**Current checkpoint:** B1
**Evidence:** `../evidence/02-media-s3-cost-protection.md`

## Assignment

Replace conflicting media/upload/download limits with one backend-owned policy.
Enforce account and service cost ceilings around private direct S3 transfers while
preserving exact-key/version/checksum safety and long-term successful outputs.

Do not change the worker architecture or live AWS console in this branch.

## Prerequisites

- [ ] Confirm branch 1 is merged and fetch the new collection tip.
- [ ] Record predecessor/collection SHA and prove sequential ancestry.
- [ ] Read architecture 02/06 and the provider runbook.
- [ ] Inventory backend, Android, iOS, dashboard, tests, and docs containing legacy
      30 MB/10-minute or 100 MB/30-minute policies.
- [ ] Run focused media/storage/client tests and record baseline results.

## B1. One media policy

- [ ] Replace all active policy versions with duration `<= 1,200` seconds and size
      `<= 50,000,000` bytes.
- [ ] Make the backend response authoritative with safe client offline ceilings.
- [ ] Apply the same policy to local and remote imports on Android and iOS.
- [ ] Validate declaration and confirmed media independently.
- [ ] Reject unsupported/mismatched type, extension, checksum, size, and duration
      before queue eligibility.
- [ ] Test below/exact/above boundaries in backend and both clients.

**Exit:** no runtime path accepts a legacy limit and clients explain the same policy.

## B2. Upload grants and confirmed bytes

- [ ] Enforce 30 grants/UTC day and 200 grants/UTC month atomically per account.
- [ ] Enforce 1,000,000,000 confirmed bytes/UTC month.
- [ ] Count new grants on issuance and confirmed bytes once after exact verification.
- [ ] Make request replay and upload confirmation idempotent.
- [ ] Add server-owned logical-audio family and five-attempt accounting hook.
- [ ] Prevent a changed request UUID from resetting the family attempt count.
- [ ] Return safe current-limit/reset information to clients.
- [ ] Test daily/monthly rollovers, concurrent last grant, duplicate confirmation,
      abandoned URL, and incorrect metadata.

**Exit:** S3 URL spam and confirmed-byte races cannot exceed account policy.

## B3. S3 grant and cleanup safety

- [ ] Preserve exact owner/job keys, required signed headers, checksum, type, size,
      immutable version, and attempt ownership.
- [ ] Cap upload/download URL expiry at 600 seconds.
- [ ] Never persist or log a presigned URL.
- [ ] Wire abandoned, invalid, cancelled, failed, and stale objects into exact-version
      leased cleanup.
- [ ] Add a regression test for cancelled-upload orphan cleanup.
- [ ] Treat missing exact objects as reconciled without prefix-wide deletion.
- [ ] Test transient S3 cleanup retry and permanent safe failure.

**Exit:** every non-retained object has a bounded idempotent cleanup path.

## B4. Retained output and lifecycle

- [ ] Count verified published outputs toward the 1,000,000,000-byte account cap.
- [ ] Block later admission at/above the cap without discarding an in-flight success.
- [ ] Decrement retained usage only after exact deletion/reconciliation.
- [ ] Keep successful output until job/account deletion.
- [ ] Keep retryable input until terminal outcome; target temporary cleanup within
      24 hours afterward.
- [ ] Set successful audio to Intelligent-Tiering as specified.
- [ ] Test deletion/retry counter consistency, bounded overshoot, and missing object.

**Exit:** retained bytes are explainable and temporary objects do not grow forever.

## B5. Download and service bandwidth protection

- [ ] Enforce 150 result grants/UTC month.
- [ ] Enforce 10,000,000,000 estimated result bytes/UTC month.
- [ ] Charge immutable object size at new grant issuance.
- [ ] Reuse idempotent still-valid requests without a second charge.
- [ ] Add user result grants and worker input grants to the 80,000,000,000-byte
      monthly service estimate using their correct scopes.
- [ ] Pause new expensive grants safely when the service ceiling is reached.
- [ ] Preserve locally cached result playback without a new grant.
- [ ] Test exact limits, duplicate/reused URLs, object-size races, service ceiling,
      wrong owner, missing object, and restricted/deleting account.

**Exit:** API behavior reflects grant/estimated accounting and never claims exact
actual presigned-download measurement.

## B6. Admin and client integration

- [ ] Add media/transfer fields to global policy and one-account override UI.
- [ ] Show upload grants/bytes, download grants/estimate, retained bytes, period,
      effective limits, and reset.
- [ ] Update Android and iOS policy parsing, upload attempt persistence, errors, and
      boundary copy.
- [ ] Remove duplicated hardcoded product limits from client decision paths.
- [ ] Preserve uncertain-transfer recovery with the same idempotency identity.
- [ ] Update API, operations, dashboard, Android, and iOS documentation.

**Exit:** backend, dashboard, Android, and iOS agree on one contract.

## B7. Verification and operator handoff

- [ ] Run focused backend storage, usage, job, cleanup, and integration suites.
- [ ] Run backend format/verify and relevant processing/dashboard integration suites.
- [ ] Run the dashboard gate.
- [ ] Run Android debug builds, lint, and both unit-test variants.
- [ ] Run iOS formatting/tests only on the authorized simulator.
- [ ] Validate docs, manifest JSON, relative links, and whitespace.
- [ ] Complete but do not execute the AWS/Atlas/Redis provider checklist.
- [ ] Record real S3 checks as `NOT_RUN` unless explicitly authorized and executed.
- [ ] Remove all obsolete media-policy paths and explain remaining numeric matches.
- [ ] Update progress/evidence/changelog and prepare the PR.

**Exit:** reviewed PR is ready against the collection branch. Stop before branch 3.
