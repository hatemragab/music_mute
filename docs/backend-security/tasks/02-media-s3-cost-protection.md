# Branch 2: media and S3 cost protection

**Branch:** `hatem/media-s3-cost-protection`
**Create from:** updated collection after branch 1 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** B1–B7
**Status:** `MERGED`
**Current checkpoint:** none
**Evidence:** `../evidence/02-media-s3-cost-protection.md`

## Assignment

Replace conflicting media/upload/download limits with one backend-owned policy.
Enforce account and service cost ceilings around private direct S3 transfers while
preserving exact-key/version/checksum safety and long-term successful outputs.

Do not change the worker architecture or live AWS console in this branch.

## Prerequisites

- [x] Confirm branch 1 is merged and fetch the new collection tip.
- [x] Record predecessor/collection SHA and prove sequential ancestry.
- [x] Read architecture 02/06 and the provider runbook.
- [x] Inventory backend, Android, iOS, dashboard, tests, and docs containing legacy
      30 MB/10-minute or 100 MB/30-minute policies.
- [x] Run focused media/storage/client tests and record baseline results.

## B1. One media policy

- [x] Replace all active policy versions with duration `<= 1,200` seconds and size
      `<= 50,000,000` bytes.
- [x] Make the backend response authoritative with safe client offline ceilings.
- [x] Apply the same policy to local and remote imports on Android and iOS.
- [x] Validate declaration and confirmed media independently.
- [x] Reject unsupported/mismatched type, extension, checksum, size, and duration
      before queue eligibility.
- [x] Test below/exact/above boundaries in backend and both clients.

**Exit:** no runtime path accepts a legacy limit and clients explain the same policy.

## B2. Upload grants and confirmed bytes

- [x] Enforce 30 grants/UTC day and 200 grants/UTC month atomically per account.
- [x] Enforce 1,000,000,000 confirmed bytes/UTC month.
- [x] Count new grants on issuance and confirmed bytes once after exact verification.
- [x] Make request replay and upload confirmation idempotent.
- [x] Add server-owned logical-audio family and five-attempt accounting hook.
- [x] Prevent a changed request UUID from resetting the family attempt count.
- [x] Return safe current-limit/reset information to clients.
- [x] Test daily/monthly rollovers, concurrent last grant, duplicate confirmation,
      abandoned URL, and incorrect metadata.

**Exit:** S3 URL spam and confirmed-byte races cannot exceed account policy.

## B3. S3 grant and cleanup safety

- [x] Preserve exact owner/job keys, required signed headers, checksum, type, size,
      immutable version, and attempt ownership.
- [x] Cap upload/download URL expiry at 600 seconds.
- [x] Never persist or log a presigned URL.
- [x] Wire abandoned, invalid, cancelled, failed, and stale objects into exact-version
      leased cleanup.
- [x] Add a regression test for cancelled-upload orphan cleanup.
- [x] Treat missing exact objects as reconciled without prefix-wide deletion.
- [x] Test transient S3 cleanup retry and permanent safe failure.

**Exit:** every non-retained object has a bounded idempotent cleanup path.

## B4. Retained output and lifecycle

- [x] Count verified published outputs toward the 1,000,000,000-byte account cap.
- [x] Block later admission at/above the cap without discarding an in-flight success.
- [x] Decrement retained usage only after exact deletion/reconciliation.
- [x] Keep successful output until job/account deletion.
- [x] Keep retryable input until terminal outcome; target temporary cleanup within
      24 hours afterward.
- [x] Set successful audio to Intelligent-Tiering as specified.
- [x] Test deletion/retry counter consistency, bounded overshoot, and missing object.

**Exit:** retained bytes are explainable and temporary objects do not grow forever.

## B5. Download and service bandwidth protection

- [x] Enforce 150 result grants/UTC month.
- [x] Enforce 10,000,000,000 estimated result bytes/UTC month.
- [x] Charge immutable object size at new grant issuance.
- [x] Reuse idempotent still-valid requests without a second charge.
- [x] Add user result grants and worker input grants to the 80,000,000,000-byte
      monthly service estimate using their correct scopes.
- [x] Pause new expensive grants safely when the service ceiling is reached.
- [x] Preserve locally cached result playback without a new grant.
- [x] Test exact limits, duplicate/reused URLs, object-size races, service ceiling,
      wrong owner, missing object, and restricted/deleting account.

**Exit:** API behavior reflects grant/estimated accounting and never claims exact
actual presigned-download measurement.

## B6. Admin and client integration

- [x] Add media/transfer fields to global policy and one-account override UI.
- [x] Show upload grants/bytes, download grants/estimate, retained bytes, period,
      effective limits, and reset.
- [x] Update Android and iOS policy parsing, upload attempt persistence, errors, and
      boundary copy.
- [x] Remove duplicated hardcoded product limits from client decision paths.
- [x] Preserve uncertain-transfer recovery with the same idempotency identity.
- [x] Update API, operations, dashboard, Android, and iOS documentation.

**Exit:** backend, dashboard, Android, and iOS agree on one contract.

## B7. Verification and operator handoff

- [x] Run focused backend storage, usage, job, cleanup, and integration suites.
- [x] Run backend format/verify and relevant processing/dashboard integration suites.
- [x] Run the dashboard gate.
- [x] Run Android debug builds, lint, and both unit-test variants.
- [x] Run iOS formatting and compile tests without launching a simulator; test
      execution remains explicitly deferred by the maintainer.
- [x] Validate docs, manifest JSON, relative links, and whitespace.
- [x] Complete but do not execute the AWS/Atlas/Redis provider checklist.
- [x] Record real S3 checks as `NOT_RUN` unless explicitly authorized and executed.
- [x] Remove all obsolete media-policy paths and explain remaining numeric matches.
- [x] Update progress/evidence/changelog and prepare the PR.

**Exit:** PR #11 is merged into the collection branch. Branch 3 subsequently
completed and merged as PR #12.
