# Backend Audio Experience Implementation Plan

Execution update (2026-09-10): B01–B05 complete locally following the user's later
implementation request. [Validation and archive](../../../backend/docs/validation/audio-experience.md).
The planned new integration files were consolidated into one
`backend/test/audio-experience.integration.mjs` run to follow the user's request for
wise, limited testing. Historical planning-only notices below are superseded for
implementation and packaging; no commit, push, deployment or live deletion occurred.

> **For agentic workers:** Use superpowers:executing-plans when implementation is authorized. Steps use checkbox syntax for tracking. No implementation or commits in this planning task.

**Goal:** Supply persistent names, accurate processing timing, mobile diagnostics, and owner-scoped deletion for the automatic native-mobile experience.

**Architecture:** Extend the existing NestJS jobs/worker/storage modules and MongoDB records. Preserve the API-only service shape, direct signed S3 transfers, external Redis configuration, existing idempotency, and Z440 worker protocol.

**Tech Stack:** TypeScript, NestJS, Mongoose/MongoDB, existing AWS S3 client, Vitest and Node integration tests.

**Spec:** [Agreed automatic audio experience](../specs/2026-09-10-automatic-audio-experience.md).

## Global constraints

- Planning only; no application code, commit, push, deployment, live deletion, or infrastructure changes.
- All spec requirements apply, including legacy clients, per-owner authorization, sanitized diagnostics, timing semantics, and explicit deletion.
- Existing input limits remain: nonempty, smaller than 30,000,000 bytes, shorter than 600 seconds. No URL download on the backend.
- Keep the existing worker wire protocol; derive timing from current events. Any discovery requiring a worker change must be documented as an explicit new dependency before implementation.
- Read backend/AGENTS.md, README.md, docs/starter-plan.md, package.json, and affected source before implementation. Preserve all unrelated current work.
- Device/UI tests only on iPhone 17 Pro, iOS 26.0, UDID $IOS_SIMULATOR_UDID; this backend plan requires no device tests.

## Baseline and file ownership

Paths below are relative to backend/. Existing modules include src/jobs/, src/job-errors/, src/worker/, src/storage/, and src/processing/. Existing jobs.presenter.ts exposes id/status/basic timestamps/input/error but no display title. job-attempt.schema.ts measures worker attempts, not just separation. JobError records worker errors; there is no mobile diagnostic route in the inspected job/error controllers.

New schema/controller/service/test files named below are proposed files. Recheck source when executing; retain module boundaries and reuse existing transaction, storage, auth, and rate-limit primitives. Backend owns the public contract fixtures; mobile plans consume them without inventing alternative field names.

## B01 — Metadata, rename, and compatible job contract

**Dependencies:** none. **Produces:** the metadata contract in the spec, including requestId reconciliation and rename. **Consumers:** A01, I01, B02, B03, B04.

**Files:** modify src/jobs/{job.schema.ts,job.types.ts,job-request.ts,jobs.service.ts,job-actions.service.ts,jobs.presenter.ts,jobs.controller.ts,jobs-query.service.ts,dto/create-job.dto.ts}; create src/jobs/dto/rename-job.dto.ts and src/jobs/job-metadata.service.ts; wire the existing processing module. Extend src/jobs/dto/create-job.dto.spec.ts and src/jobs/job-schema.spec.ts; create src/jobs/job-metadata.service.spec.ts and test/job-metadata.integration.mjs. Update docs/api/audio-processing.md. Create test/fixtures/audio-experience-contract.json with legacy, URL/import, renamed, retried, and tombstoned response fixtures as corresponding tasks land.

- [ ] Add failing tests for optional metadata and unchanged legacy create request hashes, lost-response replay, Unicode/Arabic names, whitespace-only/overlong names, wrong-owner rename, and same-name repeat rename.
- [ ] Run the focused unit tests and record the expected missing-feature failures.
- [ ] Implement optional sourceTitle/sourceKind/clientStartedAt, separate sourceTitle/displayName, and returned requestId. Normalize metadata once before hashing; absent metadata must preserve the existing hash shape. Keep immutable request identity separate from mutable displayName.
- [ ] Add owner-scoped PATCH /jobs/:id. Reject control characters and unsupported fields; do not mutate S3 keys. Preserve displayName on retry and guard updates with deletion state/revision so rename cannot revive a removed job.
- [ ] Add backward-compatible read defaults for old documents without a destructive backfill. List/detail must agree. Preserve original creator request hash even after rename.
- [ ] Publish exact request/response/error fixtures for both mobile teams; verify API prefix/envelope against existing clients. Run metadata integration tests with disposable fixtures and document the contract.

**Acceptance:** old payloads still work; one requestId still creates one job; title survives history/retry; unauthorized users cannot read or rename another owner's audio; no audio reprocessing after rename.

## B02 — Persist phase timing with replay-safe worker events

**Dependencies:** B01. **Produces:** timing fields/stage timestamps/serverTime consumed by A04 and I04.

**Files:** modify src/jobs/{job.schema.ts,job-attempt.schema.ts,jobs.presenter.ts,jobs-query.service.ts}, src/worker/{worker-coordinator.service.ts,worker-output.service.ts,worker-terminal.service.ts,worker-recovery.service.ts}; create src/jobs/job-timing.ts and src/jobs/job-timing.spec.ts; extend test/audio-processing.integration.mjs and docs/api/audio-processing.md.

- [ ] Add fixed-clock tests: queue 30 seconds, validation 5 seconds, processing 20 seconds, output upload 4 seconds must report 20 seconds of processing, not 59. Test two interrupted attempts, late heartbeats, duplicated events, cancellation, and clock-skewed client dates.
- [ ] Run the focused failing test, then persist processing interval entry/exit atomically with existing stage transitions and receipt transactions. Close intervals on output-upload start, cancellation, failure, and interruption without double counting.
- [ ] For interruption without a precise stop event, end at the last trustworthy worker observation and mark the timing approximate; never count all worker downtime as active processing.
- [ ] Return processingElapsedMs and totalElapsedMs with the approximation semantics in the spec. Legacy jobs with missing intervals return null instead of a guessed duration. Active intervals use server time; aggregate attempts within a job but not retry descendants.
- [ ] Keep history queries bounded; avoid loading all attempt records once per row. Store aggregates or batch lookups, and test pagination cost.
- [ ] Run focused timing tests and replay/interruption integration fixtures; add examples documenting audio duration versus processing time.

**Acceptance:** event replay does not inflate time; interrupted-worker offline duration is excluded; client time never changes queue order; no new Z440 event is required.

## B03 — Authenticated mobile error reporting

**Dependencies:** B01. **Produces:** POST /client-errors contract consumed by A05 and I05.

**Files:** create src/client-errors/{client-errors.controller.ts,client-errors.service.ts,client-error.schema.ts,client-error.dto.ts,client-errors.service.spec.ts}; wire through the existing processing module and reuse auth/rate-limiter patterns. Create test/client-errors.integration.mjs; update docs/api/audio-processing.md and docs/operations/audio-processing.md.

- [ ] Add tests for pre-reservation errors without jobId, owner/job mismatch, duplicate eventId, conflicting replay, invalid/oversized payloads, throttling, and secret-bearing unexpected fields.
- [ ] Run failing unit tests, then implement the exact allowlisted schema from the spec. Store ownerId/receivedAt from trusted server context and index owner/eventId uniquely plus operationId/jobId for support lookup.
- [ ] Resolve related jobs using owner plus requestId so pre-job reports can be found with the later Job ID. Do not allow client error reports to change server processing status or overwrite worker failure evidence.
- [ ] Rate-limit this route per authenticated owner using existing infrastructure; start with 30 reports/minute and return Retry-After on throttling. Duplicate accepted events return the same acknowledgement.
- [ ] Test bounded fields and verify no raw exception, signed URL, source URL, token, or audio filename/path enters server logs. Store structured codes and separately maintained safe user messages.
- [ ] Add an operations guide for looking up a Job ID or Reference in stored diagnostics without creating a public admin/error-log endpoint. Run integration tests using disposable accounts/jobs.

**Acceptance:** failures before upload are diagnosable; duplicates do not flood storage; reporters cannot attach another user's job; the reporting route does not gate processing availability.

## B04 — Terminal-job deletion and durable artifact cleanup

**Dependencies:** B01. **Produces:** DELETE /jobs/:id plus hidden/deleted history behavior consumed by A06 and I06.

**Files:** modify src/jobs/{jobs.controller.ts,jobs-query.service.ts,jobs.service.ts,job-actions.service.ts,job.schema.ts}, src/storage/storage-transfers.service.ts, src/processing/processing-maintenance.service.ts and module wiring; create src/jobs/{job-deletion.service.ts,job-deletion.service.spec.ts}; create test/job-deletion.integration.mjs. Update docs/api/audio-processing.md and docs/operations/audio-processing.md.

- [ ] Add tests for deleting each allowed terminal state, active-state 409, wrong-owner denial, repeat deletion, concurrent retry/rename, and stale signed-download requests.
- [ ] Run focused failing tests, then implement a transactional owner-scoped deletedAt tombstone and durable pending cleanup state. Return 204 idempotently for the same owner's tombstone and the existing not-found envelope for unknown/foreign IDs.
- [ ] Exclude tombstones from lists, return a stable deleted/not-found outcome for detail, deny new grants/retries/rename, and preserve create/retry receipts so a delayed replay cannot create another job after deletion.
- [ ] Implement bounded, leased cleanup through the existing maintenance lifecycle; no new Redis job worker. Delete only recorded S3 object key/version pairs owned exclusively by this job. Include input, output, and attempt output reservations; check retry descendants/shared references before removal, leaving shared objects until their final live reference is removed.
- [ ] Persist partial progress/backoff and resume cleanup across restart. Missing objects count as success. Storage failures do not restore deleted history. Keep minimal diagnostic IDs, status, and timing; scrub user-visible title from a tombstone when no longer needed for deletion.
- [ ] Exercise versioned storage mocks, shared retry inputs, multiple API replicas, crashes between tombstone and cleanup, and insufficient S3 delete permission. Document necessary runtime permissions for later approved deployment; do not change IAM or real objects during implementation tests.

**Acceptance:** deleted audio disappears for its owner across refresh; other jobs and exports are unaffected; cleanup is eventually retryable; no concurrent mutation resurrects audio; diagnostics remain findable by ID.

## B05 — Contract regression and handoff

**Dependencies:** B01–B04. **Produces:** backend contract ready for native integration, with explicit deployment status.

**Files:** update docs/api/audio-processing.md, docs/operations/audio-processing.md, test/fixtures/audio-experience-contract.json; create docs/validation/audio-experience.md during implementation.

- [ ] Add contract coverage for old client payloads, new metadata, retries, missing timing, client errors, and deletion races. Verify existing authentication, lease, checksum, and cancellation tests remain valid.
- [ ] Run from backend: npm run verify. This currently runs format check, lint, typecheck, Vitest, test:e2e, and build. Use disposable integration services and existing test harnesses; never point deletion tests at production.
- [ ] Run npm run build followed by node --test test/job-metadata.integration.mjs test/client-errors.integration.mjs test/job-deletion.integration.mjs after those proposed files exist. Record failures/skips and environment prerequisites explicitly.
- [ ] Review only the feature diff and update the shared tracker. Mark deployment as not performed unless separately requested; mobile integration cannot assume new endpoints are already live.

**Completion evidence:** focused tests and contract fixtures, full verification output, no unrelated changes, API documentation matching actual responses. No tests have been run for these unimplemented tasks in the planning session.
