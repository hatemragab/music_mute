# MusicMute security and cost hardening implementation plan

> **For agentic workers:** implement task-by-task with test-driven development and verification before completion.

**Goal:** Prevent upload replay, reclaim orphaned storage durably, bound request bursts and reduce APK grant exposure while preserving unlimited user processing.

**Architecture:** Keep S3 as private versioned object storage, MongoDB as durable control-plane authority and Redis as ephemeral rate-limit state. Add one shared exact-key cleanup queue and extend existing transfer/auth/release services rather than adding a second scheduler.

**Spec:** [Security and cost hardening design](../specs/2026-09-12-security-cost-hardening-design.md)

## Constraints

- Work only on `codex/security-cost-hardening` in the isolated worktree from `origin/main`.
- Do not add tokens, monthly quotas, subscriptions or lifetime usage limits.
- Do not mutate production infrastructure or credentials.
- Preserve version-pinned downloads, account-deletion durability and existing API error safety.
- Add failing tests before implementation; run focused checks after every task and full checks before completion.

## Task 1: Conditional whole-object uploads

**Backend files:** `backend/src/storage/storage-transfers.service.ts`, `backend/src/releases/release-artifact-storage.service.ts`, `backend/src/jobs/job.types.ts`, related specs.

**Client files:** Android `processing/{JobModels,S3FormUploader}.kt`; iOS `Processing/{JobModels,S3MultipartFile,BackgroundTransferCoordinator}.swift`; dashboard release contracts/uploader and their tests.

- [x] Specify `method: PUT`, allowlisted `headers`, exact checksum/content type and `If-None-Match: *` in backend tests.
- [x] Generate `PutObjectCommand` grants with signed content length, type, checksum and conditional-create semantics.
- [x] Migrate every client to stream the raw file using the returned method/headers, reject redirects and never attach API auth.
- [x] Verify backend, dashboard, Android and iOS focused tests.

## Task 2: Durable exact-key cleanup

**Files:** create `backend/src/storage/storage-cleanup-task.schema.ts`, `storage-cleanup.service.ts` and specs; update persistence/module wiring, job/release schemas, maintenance services, account deletion and affected tests.

- [x] Test key-prefix rejection, idempotent scheduling, replica-safe leasing, exact-key-only deletion, settlement rescans and exponential retry.
- [x] Schedule expired audio reservations and unconfirmed terminal attempt outputs transactionally; use safe `UPLOAD_EXPIRED` status/error copy.
- [x] Schedule expired/rejected/superseded APK reservations without touching selected verified/published artifacts.
- [x] Run cleanup independently of audio processing and make account purging wait for owner tasks.

## Task 3: Burst and administrator controls

**Files:** auth decorators/guard/types, environment defaults/examples/tests, jobs and release controllers/tests.

- [x] Add processing create/grant/mutation operation buckets that reset by time and do not create a monthly quota.
- [x] Decorate costly processing routes consistently.
- [x] Require fresh admin authentication plus sensitive-operation rate limits for APK reserve/complete.
- [x] Add a tighter public per-IP throttle for APK grant/redirect endpoints.

## Task 4: Download and lifecycle hardening

**Files:** release artifact storage/config/specs, storage preflight/specs, environment examples/docs.

- [x] Reduce version-pinned APK grant lifetime to a validated configurable default of 300 seconds.
- [x] Permit only abort-incomplete-multipart and expired-delete-marker lifecycle actions; keep all object/version expiration forbidden.
- [x] Document private bucket, versioning, conditional-write policy and operator-owned CDN/credential work without applying it.

## Task 5: Secret guard and full verification

**Files:** create `backend/scripts/check-tracked-secrets.mjs` and test; update backend package scripts and README.

- [x] Test true positives, safe placeholders and value-redacting output.
- [x] Add the tracked-source scan to `npm run verify`.
- [x] Review the complete diff and run backend verify, dashboard format/lint/tests/deployment build, Android unit/lint/assemble and iOS tests on simulator `3CC14436-EC3C-4419-A079-C84951E5FA07` only.
- [x] Report any pre-existing failures separately; do not claim deployment or live infrastructure proof.
