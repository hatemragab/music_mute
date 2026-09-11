# Backend Audio Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:subagent-driven-development only when delegation is requested. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure direct S3 uploads, a durable FIFO MongoDB job queue, one external Z440 assignment, cancellation/recovery, voice-only MP3 results, error history, and FCM notifications.

**Architecture:** NestJS owns authentication, authorization, S3 grants and all MongoDB state changes. A separately implemented Windows worker polls the API and processes one job at a time. MongoDB transactions coordinate the worker slot, job state, error records and notification outbox; API maintenance loops perform no audio processing.

**Tech Stack:** Existing Node 24/npm 11, NestJS 11, TypeScript/ESM, Mongoose 9/MongoDB 8 replica set, external Redis, AWS SDK v3, Firebase Admin 14, Vitest, Supertest and isolated native-process tests.

**Spec:** [Backend audio processing specification](../specs/2026-09-09-audio-processing.md).

**Tracker:** [Ordered tasks and acceptance](../../tasks/audio-processing.md).

**Status:** Planning complete. All implementation tasks are pending. No implementation, commit, deployment, live storage mutation, or device test has been performed for this plan.

## Global constraints

- Implement only the NestJS backend. Mobile changes and Z440 implementation are outside scope.
- Input duration is strictly less than 600 seconds; input size is strictly less than 30,000,000 bytes.
- Output is one voice-only MP3. Do not publish an instrumental track.
- Retain files, job history, and error records indefinitely. No automatic deletion or business-record TTL indexes.
- Users may submit unlimited jobs and retain unlimited history. Paginate reads; retain existing request-abuse throttles without daily or outstanding-job quotas.
- FIFO begins when verified upload enqueue commits. An unfinished upload has no position.
- Exactly one global execution slot, including interruption and pending cancellation.
- Z440 may shut down at any point. Lease expiry does not release the slot.
- User cancellation is normal; processing failure records a safe error in MongoDB.
- Processing failure requires user retry at the queue tail. Interruption recovers the existing job first.
- S3 transfers use presigned access; store pinned object keys/versions/checksums, never signed URLs.
- Do not restore BullMQ, server-side YouTube downloading, or an audio worker in the API deployment.
- Preserve unrelated edits, mobile work, legacy deletions, real dotenv files and credentials.
- Do not commit, push, publish, deploy, create cloud resources or mutate real data without a separate direct request.
- Scope formatting to changed paths. Run the required full verification gate after implementation.

## Before execution

Read `AGENTS.md`, `README.md`, `docs/starter-plan.md`, `docs/auth-api.md`, the spec,
`package.json`, configuration, and each affected module from `backend/`. Recheck
the working tree; the backend currently contains untracked work and the parent
contains unrelated legacy deletions. Never reset or stage the whole tree.

Feature opt-in starts disabled. No MongoDB transactions or S3 preflight calls are
introduced into the existing auth-only startup path while disabled. Enabled
processing requires replica-set transactions and the storage preflight described
in the spec. The owner approved planning a MongoDB business queue; this does not
authorize restoring the removed BullMQ architecture.

## File structure and responsibility

Paths below are relative to `backend/`. New paths are planned, not existing files.

| Files                                                                                                                                           | Responsibility                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/processing/processing.module.ts`, `processing-persistence.module.ts`, `processing-startup.service.ts`                                      | Composition, schema registration, opt-in and awaited prerequisites                                         |
| `src/jobs/job.schema.ts`, `job-attempt.schema.ts`, `job-receipt.schema.ts`, `queue-counter.schema.ts`                                           | Durable jobs, attempts, callbacks and queue sequence                                                       |
| `src/jobs/job.types.ts`, `job-state.ts`, `job-errors.ts`                                                                                        | Shared contracts, legal transitions and safe HTTP errors                                                   |
| `src/jobs/jobs.service.ts`, `jobs.controller.ts`, `jobs.presenter.ts`, `jobs-query.service.ts`, `dto/`                                          | User reservation, history, cancellation and retry API                                                      |
| `src/jobs/enqueue.service.ts`                                                                                                                   | Transactional queue-order assignment                                                                       |
| `src/storage/storage-transfers.module.ts`, `storage-transfers.service.ts`, `storage-preflight.service.ts`                                       | Presigned POST/GET, version/checksum verification and read-only bucket checks                              |
| `src/worker/worker-control.schema.ts`, `worker-routes.ts`, `worker-auth.guard.ts`                                                               | Singleton control state and explicit worker authentication mode                                            |
| `src/worker/worker.controller.ts`, `worker-coordinator.service.ts`, `worker-recovery.service.ts`, `worker-output.service.ts`, `dto/`            | Claim, heartbeat, stages, cancellation acknowledgment, output and reconciliation                           |
| `src/job-errors/job-error.schema.ts`, `job-errors.service.ts`, `error-mapping.ts`                                                               | Transactional, bounded and sanitized error events                                                          |
| `src/notifications/push-registration.schema.ts`, `push-registrations.service.ts`, `push.controller.ts`, `dto/`                                  | Current owner/installation destination binding                                                             |
| `src/notifications/outbox.schema.ts`, `notification-delivery.schema.ts`, `notification-outbox.service.ts`, `notification-dispatcher.service.ts` | Durable outcome events and separate per-target delivery records                                            |
| `src/processing/processing-maintenance.service.ts`                                                                                              | Restartable bounded interruption/outbox scheduling and shutdown cleanup of owned timers                    |
| `test/helpers/audio-processing-fixture.mjs`                                                                                                     | Isolated compiled Nest fixture, real Mongo/Redis/Auth Emulator, explicit fake storage/messaging boundaries |
| `test/audio-processing.integration.mjs`, `test/worker-recovery.integration.mjs`, `test/notifications.integration.mjs`                           | Durable concurrency and restart proof                                                                      |
| `docs/audio-processing-api.md`, `docs/z440-worker-api.md`, `docs/audio-processing-operations.md`                                                | User contract, external worker contract and operational prerequisites                                      |

Register schemas once in `ProcessingPersistenceModule`; export its Mongoose
providers. `AudioProcessingModule` composes feature providers and controllers
without importing the existing `AuthModule` back into itself. Import narrow
existing Users/Devices/AppPolicy/Firebase modules where required. Reuse the
existing `StorageClient`; do not construct independent AWS clients per request.

## Shared interfaces to implement

`src/jobs/job.types.ts` owns these contracts; do not create competing definitions.
IDs are validated before constructing ObjectIds. Worker generation is a safe
integer. Queue order remains BSON int64 internally.

```ts
export type JobStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'validating'
  | 'processing'
  | 'uploading_result'
  | 'interrupted'
  | 'cancel_requested'
  | 'ready'
  | 'failed'
  | 'cancelled';
export interface InputDeclaration {
  extension: 'm4a' | 'mp4' | 'webm' | 'opus' | 'ogg' | 'aac' | 'mp3';
  contentType: string;
  bytes: number;
  durationSeconds: number;
  sha256: string;
}
export interface ObjectIdentity {
  key: string;
  versionId: string;
  bytes: number;
  sha256: string;
  contentType: string;
}
export interface WorkerSelector {
  jobId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
}
export interface WorkerAssignment extends WorkerSelector {
  leaseExpiresAt: string;
}
export interface WorkerEvent extends WorkerSelector {
  eventId: string;
}
export interface UploadGrant {
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}
export interface DownloadGrant {
  url: string;
  expiresAt: string;
}
```

Public presenters must never serialize `ObjectIdentity` directly. Worker DTOs
may consume job/attempt/session/generation, but must not accept a caller-selected
lease deadline; the server issues and enforces that value. Convert a callback's
assignment into selectors rather than trusting all returned fields.

## Test fixture contract

Task AP-01 introduces `startAudioProcessingFixture(t)` in
`test/helpers/audio-processing-fixture.mjs`. It builds a real Nest test composition
from compiled modules and uses isolated native dependencies. Tests may access
`f.jobs`, `f.attempts`, `f.errors`, `f.outbox`, `f.deliveries`, `f.control` and
`f.registrations` as Mongoose models to inspect or deliberately age fixture data.
Never use those mutation helpers with configured application database URIs.

The helper exposes these names for later acceptance tests:

```ts
// Contract for the JavaScript integration helper; declarations are explanatory.
interface AudioProcessingFixture {
  installationId: string;
  request(
    method: string,
    path: string,
    body?: unknown,
    identity?: 'owner' | 'other' | 'worker' | 'anonymous',
  ): Promise<{ status: number; body: any }>;
  createQueuedJob(identity?: 'owner' | 'other'): Promise<{ id: string }>;
  claim(sessionId?: string): Promise<WorkerAssignment>;
  expireAssignment(assignment: WorkerAssignment): Promise<void>;
  restartApi(): Promise<void>;
  flushMaintenance(): Promise<void>;
  advanceToProcessing(assignment: WorkerAssignment): Promise<void>;
  completeJob(jobId: string): Promise<void>;
  failNextNotification(): void;
}
```

`createQueuedJob` must call the actual user reservation/confirmation routes; it
populates only the fake S3 boundary between them. `claim` calls the actual worker
route, with the registered credential and UUID session. `expireAssignment`
updates only the isolated fixture's lease timestamps. `restartApi` closes and
recreates Nest against the same owned databases and fake external-state stores.
`flushMaintenance` runs the production bounded maintenance operations once.
`request` attaches fixture user identity/installation headers or worker credential
as selected; it never bypasses authorization guards. Default identity is `owner`.
Add helper methods only alongside the first test needing them and document them.

`installationId` is the owner's authenticated fixture installation UUID.
`advanceToProcessing` calls the stage endpoint with valid measured metadata for
the fixture's accepted input. `completeJob` claims the fixture's sole queued job,
validates it, reserves output through HTTP, inserts matching fake S3 output, and
calls completion through HTTP; assert the supplied job ID matches its assignment.
`failNextNotification` makes the injected messaging fake fail its next send with
a transient unavailable error. These helpers never mutate business state directly.

Wrap each integration snippet in a Node `test` with
`const f = await startAudioProcessingFixture(t)`; use `node:assert/strict` and
`node:crypto`. Unit snippets belong in Vitest `it` blocks with imports from the
named task file. Per-test setup/cleanup may affect only the owned isolated fixture.

The `any` return above describes test HTTP JSON only; production DTOs and service
interfaces remain strongly typed. Do not treat fake S3 acceptance as AWS proof.

## AP-01 — Persistence, transitions and isolated transactions

**Depends on:** none.

**Files:** Create the processing composition/persistence/startup files, four job
schema files, `job.types.ts`, `job-state.ts`, `job-errors.ts`, worker-control and
job-error schemas, `src/jobs/job-state.spec.ts`, and the integration fixture/test.
Modify `src/app.module.ts`, `src/config/environment.ts` and its tests,
`test/helpers/isolated-services.mjs` and `.test.mjs`, both safe env examples, and
`package.json` only for the processing integration script.

**Interfaces:** `assertInputDeclaration(input: InputDeclaration): void` and
`nextCancellationState(status: JobStatus): JobStatus` in `job-state.ts`;
Mongoose models registered by `ProcessingPersistenceModule`; feature enable flag.

- [ ] Write limit and transition tests, including exact boundaries and terminal cancellation conflicts:

  ```ts
  expect(() =>
    assertInputDeclaration({
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 30_000_000,
      durationSeconds: 30,
      sha256: Buffer.alloc(32).toString('base64'),
    }),
  ).toThrow();
  expect(nextCancellationState('queued')).toBe('cancelled');
  expect(nextCancellationState('interrupted')).toBe('cancel_requested');
  expect(() => nextCancellationState('ready')).toThrow();
  ```

- [ ] Run `npm test -- src/jobs/job-state.spec.ts` and observe the new assertions fail before implementation.
- [ ] Implement strict schemas, enum transitions, timestamp/revision fields and explicitly named indexes from the spec. Keep error/attempt/receipt histories in separate documents.
- [ ] Extend `IsolatedServices.startDatabases` with an opt-in `replicaSet: true` path: use an isolated `--replSet`, initiate via the existing Mongoose connection, await a writable primary, and retain the current default behavior. Never discover or reuse an existing mongod.
- [ ] Add `test:processing:integration` to build and run the three planned processing integration files plus the helper tests. Initially create only real test cases; add later files when their tasks implement them and update the script accordingly.
- [ ] Prove a transaction abort leaves no partial job/control/error write and that missing required indexes fail enabled startup. Disabled startup must require neither worker secrets nor S3 calls.
- [ ] Run focused tests, `npm run typecheck`, and `npm run test:auth:integration` after fixture changes. Review only owned diffs and record evidence in the tracker; do not commit.

## AP-02 — Worker-only authentication without weakening user guards

**Depends on:** AP-01.

**Files:** Create `src/worker/worker-routes.ts`, `worker-auth.guard.ts`, its spec,
and `test/worker-auth.e2e-spec.ts`. Modify `src/auth/auth.guard.ts` and its spec,
processing composition, configuration/tests, safe examples and HTTP CORS only if
the finalized protocol introduces a required nonstandard header.

**Interfaces:** `WorkerOnly()` metadata; `WorkerAuthGuard` produces a server-owned
worker identity `z440` on the request. Worker bearer secrets never become users.
The JSON request carries session/attempt selectors; no extra worker header is needed.

- [ ] Add HTTP denial tests before implementing the new mode:

  ```js
  const r = await f.request(
    'POST',
    '/worker/claim',
    { sessionId: crypto.randomUUID() },
    'owner',
  );
  assert.equal(r.status, 401);
  assert.equal(
    (await f.request('GET', '/jobs', undefined, 'worker')).status,
    401,
  );
  ```

- [ ] Run `npm run test:e2e -- test/worker-auth.e2e-spec.ts` and observe failure for the missing protected contract.
- [ ] Give global user authentication an explicit worker-route branch; register the worker guard globally in the processing module so that branch cannot leave the route unauthenticated. Reject contradictory public/worker metadata in tests.
- [ ] Validate secret digest configuration, use bounded bearer parsing and timing-safe digest comparison, and preserve the existing rate limiter. Reject anonymous, Firebase-user, malformed, old-key and disabled-feature worker requests.
- [ ] Test every worker controller handler's metadata, including routes added in later tasks. Keep all ordinary authenticated endpoints protected and existing public health/auth behavior unchanged.
- [ ] Run focused guard/HTTP tests and `npm run typecheck`; record evidence.

## AP-03 — Restricted S3 transfers and version verification

**Depends on:** AP-01.

**Files:** Create `src/storage/storage-transfers.module.ts`,
`storage-transfers.service.ts`, `storage-preflight.service.ts` and their specs.
Reuse `src/infrastructure/storage.module.ts`. Modify config/tests, safe examples,
`package.json` and lockfile only for the necessary presigned-POST helper.

**Interfaces:** `createInputGrant(job): Promise<UploadGrant>`,
`verifyInput(job): Promise<ObjectIdentity>`,
`createOutputGrant(job, assignment): Promise<UploadGrant>`,
`verifyOutput(job): Promise<ObjectIdentity>`,
`createDownloadGrant(object: ObjectIdentity): Promise<DownloadGrant>` on
`StorageTransfersService`; jobs/assignments must come from authorized DB reads.

- [ ] Write tests inspecting the signed POST policy, exact object/version GET,
      checksum mismatch, missing version, private/versioned-bucket refusal, and redaction:

  ```ts
  const policy = JSON.parse(
    Buffer.from(grant.fields.Policy, 'base64').toString(),
  );
  expect(policy.conditions).toContainEqual([
    'content-length-range',
    1024,
    1024,
  ]);
  expect(policy.conditions).toContainEqual({ key: expectedServerKey });
  expect(JSON.stringify(persistedJob)).not.toContain('X-Amz-Signature');
  ```

- [ ] Run `npm test -- src/storage` and verify the new assertions fail first.
- [ ] Reuse the installed request-presigner. Resolve and install only the published compatible POST helper with `npm install --save-exact @aws-sdk/s3-presigned-post`; inspect its lockfile diff, without upgrading unrelated packages.
- [ ] Bind POST conditions to the exact key, declared length, type and SHA-256. Verify the SDK emits and S3 accepts the checksum policy fields; add this to later sandbox acceptance rather than inferring it from a mock.
- [ ] Implement two-stage HEAD/version pinning, bounded AWS timeouts, controlled GETs and no-store response support. Do not accept client keys or version IDs as authority.
- [ ] Preflight versioning, public-access configuration, policy/ACL public status and conflicting lifecycle expiration through read-only SDK operations. No auto-correction of AWS configuration; fail closed with safe diagnostics.
- [ ] Run focused tests and typecheck; document the additional least-privilege read permissions required for preflight. Mark AWS enforcement as unverified pending an authorized sandbox check.

## AP-04 — User upload reservation and FIFO enqueue

**Depends on:** AP-01, AP-03.

**Files:** Create `src/jobs/jobs.service.ts`, `jobs.controller.ts`,
`enqueue.service.ts`, `dto/create-job.dto.ts`, `dto/confirm-upload.dto.ts`,
their unit tests and `test/jobs-upload.e2e-spec.ts`. Extend the integration fixture
and `test/audio-processing.integration.mjs`; wire providers in processing composition.

**Interfaces:** `JobsService.create(userId, input, requestId)`,
`renewUpload(userId, jobId)` and `confirmUpload(userId, jobId)`;
`EnqueueService.enqueue(session, job)` allocates the BSON-int64 sequence and
`queuedAt` inside the caller's transaction.

- [ ] Test unverified uploads, strict limits, cross-owner confirmation, cancellation during HEAD, and duplicate creation/confirmation:

  ```js
  const job = await f.createQueuedJob();
  const before = await f.jobs.findById(job.id).lean();
  const r = await f.request('POST', `/jobs/${job.id}/upload-complete`, {});
  assert.equal(r.status, 200);
  const after = await f.jobs.findById(job.id).lean();
  assert.equal(String(after.queueOrder), String(before.queueOrder));
  ```

- [ ] Run the focused unit/HTTP tests and observe failure before implementing routes.
- [ ] Use existing authentication and `RequireProcessingAccess()` on creation, renewal and confirmation. Derive user ID server-side; enforce UUID idempotency with a canonical request hash and owner/request unique index.
- [ ] Reserve first, sign second. Verify S3 outside transactions, then compare state and enqueue transactionally. Recover repeated creation after a signing outage by returning the existing reservation and a renewed grant.
- [ ] Allocate order only at successful enqueue, including ties/concurrent confirmations. Keep pending uploads out of queue queries; never cap jobs per user.
- [ ] Run `npm run build` followed by `node --test --test-name-pattern='upload|enqueue' test/audio-processing.integration.mjs`. Prove Mongo/API restart retains accepted queue order.
- [ ] Record evidence and update user contract documentation with request/response examples and safe errors.

## AP-05 — Owner history and authorized download actions

**Depends on:** AP-04.

**Files:** Create `src/jobs/jobs-query.service.ts`, `jobs.presenter.ts`,
`dto/list-jobs.dto.ts`, `dto/download-job.dto.ts` and tests. Extend jobs controller
and `test/jobs-history.e2e-spec.ts`.

**Interfaces:** `listOwned(userId, query)`, `findOwned(userId, jobId)` and
`download(userId, jobId, asset: 'input' | 'output')`; public job presenter exposes
no object identity, worker credential, receipt data or operational diagnostics.

- [ ] Write privacy and cursor tests first:

  ```js
  const job = await f.createQueuedJob();
  assert.equal(
    (await f.request('GET', `/jobs/${job.id}`, undefined, 'other')).status,
    404,
  );
  const r = await f.request('GET', '/jobs?limit=20');
  assert.equal(JSON.stringify(r.body).includes('versionId'), false);
  ```

- [ ] Run `npm run test:e2e -- test/jobs-history.e2e-spec.ts` and observe the missing behavior.
- [ ] Implement owner-first queries, stable `(createdAt, _id)` cursor pagination,
      status validation and worker availability. Do not leak another user's rank or files.
- [ ] Allow original download only for pinned input and output download only for ready. Use ordinary authentication for history/download/cancel, preserving disabled-account/session rules without imposing minimum-build processing policy on recovery actions.
- [ ] Test inserts between pages, invalid cursors, repeated page reads, output-not-ready and no-store headers. Run focused tests and typecheck; update the user API reference.

## AP-06 — Atomic global claim, heartbeat and stage reporting

**Depends on:** AP-02, AP-04.

**Files:** Create `src/worker/worker.controller.ts`,
`worker-coordinator.service.ts`, `dto/claim.dto.ts`, `dto/assignment.dto.ts`,
`dto/stage.dto.ts` and specs. Extend integration tests.

**Interfaces:** `claim(sessionId)`, `heartbeat(assignment)`,
`reportStage(event, stage, validatedMedia)` on `WorkerCoordinatorService`;
claim returns an assignment plus fresh pinned input grant or `204` with poll hint.

- [ ] Write a real concurrent-claim test first:

  ```js
  await f.createQueuedJob();
  await f.createQueuedJob();
  await Promise.all(
    Array.from({ length: 12 }, () =>
      f.request(
        'POST',
        '/worker/claim',
        { sessionId: crypto.randomUUID() },
        'worker',
      ),
    ),
  );
  assert.equal(await f.jobs.countDocuments({ status: 'validating' }), 1);
  assert.equal(await f.attempts.countDocuments({ endedAt: null }), 1);
  ```

- [ ] Build and run the claim-focused integration test; observe failure before coordinator implementation.
- [ ] Within one short Mongo transaction: compare idle control, select oldest queued job, increment generation, create attempt, transition job, and assign slot. Retry transient transaction conflicts with fresh reads; do not perform AWS calls in the transaction.
- [ ] Return existing assignment for the same session after an ambiguous claim response. Other sessions cannot claim around an occupied slot. Do not release the slot if signing the claim's GET grant fails.
- [ ] Heartbeat updates the valid current lease and returns cancellation intent. Stage reports accept only the allowed forward transition and validated media below limits. Deduplicate event IDs with matching request hashes.
- [ ] Prove oldest verified upload wins regardless of reservation creation order, two API instances cannot claim distinct jobs, and stale/expired assignments cannot heartbeat. Run unit, HTTP and focused integration checks.

## AP-07 — Cancellation, persistent failures and manual retry

**Depends on:** AP-05, AP-06.

**Files:** Create `src/job-errors/job-errors.service.ts`, `error-mapping.ts`,
their specs, `src/jobs/dto/retry-job.dto.ts`, `src/worker/dto/fail-job.dto.ts`,
`dto/cancelled-job.dto.ts`. Extend jobs/coordinator services and controllers,
receipts, integration tests and `test/jobs-cancel.e2e-spec.ts`.

**Interfaces:** `JobsService.cancel(userId, jobId)`,
`retry(userId, jobId, requestId)`; `WorkerCoordinatorService.fail(event, code,
diagnostics, stopped)` and `acknowledgeCancellation(event, stopped)`;
`JobErrorsService.record(session, event)` writes only allowlisted safe fields.

- [ ] Write cancellation and duplicate-error tests before implementation:

  ```js
  const job = await f.createQueuedJob();
  await f.claim();
  const r = await f.request('POST', `/jobs/${job.id}/cancel`, {});
  assert.equal(r.body.status, 'cancel_requested');
  assert.equal(
    (await f.control.findById('z440').lean()).activeJobId.toString(),
    job.id,
  );
  ```

- [ ] Run focused cancellation tests and observe the missing transitions.
- [ ] Implement immediate queued/pending cancellation, active cancellation intent, and stopped acknowledgments. Keep the slot during offline cancellation. Terminal ready cancellation is a conflict; repeated successful cancellation is idempotent.
- [ ] Commit failure, attempt closure, slot release, error record and receipt together only after stopped acknowledgment. Store bounded numeric/enum diagnostics and mapped safe messages; reject raw output/URL/token fields. Do not classify user cancellation as an error.
- [ ] Create manual retries as new jobs with owner-scoped idempotency and pinned original input. Allocate fresh queue order. Reject retry of invalid input using `NEW_INPUT_REQUIRED`; do not automatically retry processing errors.
- [ ] Test Mongo write failure cannot leave a failed job without its error record, duplicate reports create one error, cancellation wins over later fail/complete, and retry joins the tail. Run focused suites and document safe error codes.

## AP-08 — MP3 output reservation and durable completion

**Depends on:** AP-03, AP-06, AP-07.

**Files:** Create `src/worker/worker-output.service.ts`,
`dto/output-reservation.dto.ts`, `dto/complete-job.dto.ts`, specs,
`src/notifications/outbox.schema.ts` and initial outbox service. Extend worker
controller, persistence registration and integration tests.

**Interfaces:** `WorkerOutputService.reserve(event, metadata)`,
`complete(event)`; `NotificationOutboxService.enqueueOutcome(session, job,
outcome: 'ready' | 'failed')` inserts a unique durable event without sending FCM.

- [ ] Write tests for MP3-only output, attempt keys, checksum/version verification and completion deduplication:

  ```js
  await f.createQueuedJob();
  const assignment = await f.claim();
  await f.advanceToProcessing(assignment);
  const { jobId, attemptId, sessionId, generation } = assignment;
  const r = await f.request(
    'POST',
    '/worker/output-url',
    {
      jobId,
      attemptId,
      sessionId,
      generation,
      eventId: crypto.randomUUID(),
      bytes: 1024,
      durationSeconds: 30,
      contentType: 'audio/wav',
      sha256: Buffer.alloc(32).toString('base64'),
    },
    'worker',
  );
  assert.equal(r.status, 400);
  ```

- [ ] Run focused tests and observe failures before implementing result behavior.
- [ ] Enforce processing/current-attempt ownership, server-selected `vocals.mp3` key, independent output cap, and exact reservation metadata. Strip server-issued `leaseExpiresAt` from real callback DTO examples; it is not client authority.
- [ ] Verify output outside the transaction, then compare ownership/status again. Commit ready, pinned output, closed attempt, released slot, receipt and pending notification together.
- [ ] Complete an already-accepted event through its receipt even after slot release. Same ID with changed metadata conflicts. Old-attempt uploads cannot replace current output or trigger ready notification.
- [ ] Add failure outbox events to AP-07's terminal failure transaction. No notification network call belongs inside either transaction.
- [ ] Test cancellation during output HEAD, absent/corrupt output, ambiguous completion response, transaction failure and exactly one durable outcome event. Record that media-content correctness remains a trusted-worker attestation.

## AP-09 — Shutdown and interrupted-job reconciliation

**Depends on:** AP-06, AP-07, AP-08.

**Files:** Create `src/worker/worker-recovery.service.ts`,
`dto/reconcile.dto.ts`, `src/processing/processing-maintenance.service.ts`,
their specs and `test/worker-recovery.integration.mjs`.

**Interfaces:** `WorkerRecoveryService.markExpiredAssignments()` and
`reconcile(sessionId, previousAttemptId, stopped)`; reconciliation returns the
terminal receipt, cancellation, recoverable result, or a new attempt for the same job.

- [ ] Write the shutdown test first:

  ```js
  const first = await f.createQueuedJob();
  await f.createQueuedJob();
  const assignment = await f.claim();
  await f.expireAssignment(assignment);
  await f.restartApi();
  await f.flushMaintenance();
  assert.equal((await f.jobs.findById(first.id).lean()).status, 'interrupted');
  assert.equal(await f.jobs.countDocuments({ status: 'queued' }), 1);
  assert.equal(
    (await f.control.findById('z440').lean()).activeJobId.toString(),
    first.id,
  );
  ```

- [ ] Build and run `node --test test/worker-recovery.integration.mjs`; verify missing recovery behavior before implementation.
- [ ] Persist interruption without releasing the slot; enforce lease expiry in all mutations independently of the timer. Record one interruption event per attempt.
- [ ] Require stopped acknowledgment before reassignment. Resolve cancellation first, then inspect any expected uploaded result, then restart the same job with a fresh attempt/generation only when no valid result can be finalized.
- [ ] On recovery storage outage, keep the job/slot interrupted and return retryable service-unavailable; do not infer that output is absent. A confirmed missing/incomplete output permits reprocessing under a new attempt.
- [ ] Handle same-session connection loss, new boot session, lost completion response, power loss after upload, and repeated reconciliation. No timeout automatically creates another processing job.
- [ ] Test old callbacks, concurrent recoveries, disconnected cancellation, API restart, and no automatic dequeue after expiry. Document the worker singleton/process-stop obligation and the manual operator recovery boundary.

## AP-10 — Push registration and session-safe destination ownership

**Depends on:** AP-01; can be developed after AP-09 in the sequential order.

**Files:** Create push schema/service/controller/DTO/specs and
`test/push-registrations.e2e-spec.ts`. Modify
`src/auth/firebase.module.ts` to export a messaging provider from its managed app;
reuse existing users/devices/session-cutoff queries.

**Interfaces:** `PushRegistrationsService.register(user, installationId, token,
authTimeSec)`, `deactivate(userId, installationId)`, `eligibleFor(userId)`;
`FIREBASE_MESSAGING` injection token exporting Firebase Admin Messaging.

- [ ] Test token and installation rebinding before implementing it:

  ```js
  const installationId = f.installationId;
  await f.request('PUT', `/devices/${installationId}/push`, {
    token: 'fixture-token',
  });
  const publicJob = await f.request('GET', '/jobs');
  assert.equal(JSON.stringify(publicJob.body).includes('fixture-token'), false);
  assert.equal(await f.registrations.countDocuments({ active: true }), 1);
  ```

- [ ] Run focused registration/HTTP tests and observe failure first.
- [ ] Validate owned installation and bounded token, keep raw destination server-only,
      and transactionally enforce one current installation/token binding. Use binding
      revisions so already-prepared notifications can detect account changes.
- [ ] Exclude disabled users and registrations whose authentication time is at or
      before the existing logout-all cutoff. A later fresh authenticated registration
      restores eligibility. Deactivate idempotently without deleting the record.
- [ ] Reuse the existing managed Firebase app and lifecycle; fake messaging in tests
      without changing Firebase Auth Emulator behavior.
- [ ] Test two accounts on one installation, token rotation, logout-all, opt-out,
      invalid token input and private projections. Run auth regressions and focused checks.

## AP-11 — Durable FCM dispatch and notification error records

**Depends on:** AP-08, AP-10.

**Files:** Create `src/notifications/notification-delivery.schema.ts`,
`notification-dispatcher.service.ts` and specs,
`test/notifications.integration.mjs`. Extend outbox service, persistence,
maintenance scheduler, error classifications and config/examples.

**Interfaces:** `NotificationDispatcherService.dispatchDue()` performs one bounded
batch; per-target delivery state is separately persisted, never an unbounded
embedded array on a job. Provider send uses the injected messaging boundary.

- [ ] Write a transactional-ready/outbox and delivery-failure test first:

  ```js
  await f.request('PUT', `/devices/${f.installationId}/push`, {
    token: 'fixture-token',
  });
  const { id: readyJobId } = await f.createQueuedJob();
  await f.completeJob(readyJobId);
  f.failNextNotification();
  await f.flushMaintenance();
  assert.equal((await f.jobs.findById(readyJobId).lean()).status, 'ready');
  assert.equal(await f.outbox.countDocuments({ jobId: readyJobId }), 1);
  assert.equal(
    await f.errors.countDocuments({
      jobId: readyJobId,
      classification: 'notification',
    }),
    1,
  );
  ```

- [ ] Run focused notification tests and observe missing dispatch behavior.
- [ ] Atomically lease outbox work across API instances; freeze a bounded traversal
      of eligible targets into separate delivery documents. Recheck owner/binding
      revision/session eligibility immediately before each send.
- [ ] Send generic job/event identifiers. Track successful targets, deactivate
      invalid tokens, and implement the spec's eight-attempt bounded transient backoff.
      Keep delivery errors separate from processing outcome and never log tokens.
- [ ] Bound send time below lease duration, stop owned scheduling on API shutdown,
      and tolerate a crash after provider acceptance through stable event IDs. Do not
      claim exactly-once device delivery.
- [ ] Test multiple API instances, restart, invalid token, partial target success,
      account-switch race, exhausted retries, and missed push with readable history.
      Record FCM as a fake boundary, not live device proof.

## AP-12 — Complete regression, contracts and operations handoff

**Depends on:** AP-01 through AP-11.

**Files:** Create/finalize `docs/audio-processing-api.md`,
`docs/z440-worker-api.md`, `docs/audio-processing-operations.md`; update
`README.md`, `AGENTS.md`, this tracker and safe examples. Update only the stale
backend summary sentence in the repository-root README if it still claims BullMQ.
Finalize processing integration script, HTTP regressions and boundary tests.

**Interfaces:** Published user/worker contracts exactly match implemented DTOs and
status/error codes; operations docs explain opt-in and read-only prerequisites.

- [ ] Add an end-to-end backend contract test exercising reserve, confirm, FIFO
      claim, validate, output reservation, completion and owner-only retrieval through
      HTTP, with real Mongo transactions and explicitly fake S3/FCM boundaries.
- [ ] Include exact-byte/duration boundary tests, concurrent claim/cancel/complete
      races, a callback with a forged generation, repeated requests with changed
      payloads, original-input retention after retry, and no automatic deletion.
- [ ] Document JSON request/response examples for every spec route, authentication,
      idempotency, canonical codes, worker process-stop acknowledgment, timeout hints,
      and all shutdown points. Supply no Z440 implementation or mobile changes.
- [ ] Document enabled-startup replica-set/versioning checks, least-privilege AWS
      signing/preflight permissions, no-expiration policies, worker credential rotation,
      offline status, stuck-job diagnosis, and notification delivery limits. Operations
      remain read-only unless a separate explicit action is requested.
- [ ] Format changed files and run the exact repository gates from `backend/`:

  ```sh
  npm run verify
  npm run test:integration
  npm run test:auth:integration
  npm run test:processing:integration
  npm run build
  test -f dist/main.js
  npm audit --omit=dev
  git diff --check
  ```

- [ ] Verify repeat build output; review untracked created files as well as tracked
      diffs. Record pre-existing audit findings separately; do not force dependency
      upgrades. Do not mark unrelated known failures as caused/fixed by this work.
- [ ] Keep separate unverified acceptance items for actual nonproduction AWS
      enforcement, Windows recovery/CLI separation, APNs/FCM device delivery, and live
      mobile end-to-end behavior. Do not create test cloud objects or delete retained
      artifacts without explicit authorization.
- [ ] Mark each tracker task complete only with actual commands/results. Do not
      commit, push or deploy. Deliver source/validation evidence and remaining live gates.

## Requirement-to-task coverage

| Requirement                                            | Tasks                             |
| ------------------------------------------------------ | --------------------------------- |
| Strict input limits and direct restricted upload       | AP-01, AP-03, AP-04, AP-06        |
| Immutable accepted input and private transfers         | AP-03, AP-04, AP-05, AP-08        |
| Unlimited submissions and retained history/files       | AP-01, AP-04, AP-05, AP-07, AP-12 |
| FIFO after upload verification                         | AP-04, AP-06, AP-07               |
| One global slot across API instances                   | AP-01, AP-06, AP-09               |
| Personal-PC shutdown and existing-result recovery      | AP-08, AP-09                      |
| Cancellation and completion races                      | AP-07, AP-08, AP-09               |
| User-visible errors and durable DB error records       | AP-01, AP-07, AP-09, AP-11        |
| Manual failure retry at tail                           | AP-07                             |
| Voice-only MP3 result                                  | AP-08                             |
| FCM registration, durable dispatch and session safety  | AP-10, AP-11                      |
| External worker contract without worker implementation | AP-02, AP-06, AP-08, AP-09, AP-12 |
| Production prerequisites and honest proof boundaries   | AP-01, AP-03, AP-12               |
