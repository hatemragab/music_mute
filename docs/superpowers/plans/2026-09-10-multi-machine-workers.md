# Multi-machine Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task after implementation is requested. Steps use checkbox syntax for tracking.

**Goal:** Process different queued jobs concurrently on independently authenticated Windows machines while preserving one contained attempt per machine and safe recovery.

**Architecture:** Keep the NestJS API, MongoDB FIFO queue/transactions, Redis infrastructure, and private S3 transfers. Add a MongoDB worker registry and replace singleton coordination with authenticated per-worker ownership. Retain the existing Windows engine and add installation identity verification.

**Tech Stack:** Existing strict TypeScript/ESM NestJS/Mongoose services, Vitest and native Node integration tests, Python 3.11+, unittest, PowerShell, Windows DPAPI/Job Objects, DirectML.

**Spec:** `docs/superpowers/specs/2026-09-10-multi-machine-workers-design.md`.

**Status:** Paused at the user's request until they build the dashboard and ask to resume. The user confirmed 2–5 machines and wants this task to integrate directly into their completed dashboard. Do not build a dashboard, scaffold another frontend, or begin fleet implementation while waiting. The permission contracts below are requirements to reconcile with the dashboard's actual authentication and authorization when it is available.

## Global Constraints

- One job and one warm Kim_Vocal_2 engine per machine; multiple machines process distinct jobs.
- Keep voice-only 44.1 kHz stereo / 192 kbps MP3 output and current exact PCM rounding.
- Preserve input limits `<600` seconds and `<30,000,000` bytes, private S3 verification, user authorization, cancellation, event idempotency, and history.
- Lease expiry alone never releases an unfinished assignment. Independent worker slots prevent a stalled machine blocking healthy machines.
- Never clone configured DPAPI/session/journal files between machines.
- Worker administration belongs in the upcoming admin page. Require server-side permissions on every admin API; a normal signed-in app user receives 403 and cannot self-promote.
- The user builds the dashboard first. Resume only when requested; inspect and reuse its existing layout, components, API client, login, and permission system before adapting this plan. Dashboard construction is outside this task.
- Generate a different key per worker. The admin page displays a generated key once; backend persistence contains only its digest. OpenSSL-generated imports remain supported.
- No new dependencies unless existing libraries cannot satisfy a concrete requirement.
- Explicit operator migration only; no automatic document backfill or destructive index changes during startup.
- No commit, push, production migration, credential generation, deployment, or machine restart without corresponding user authorization.
- Preserve current staged files and unrelated repository changes. Do not use blanket reset, stash, or `git add .`.
- If app UI testing is requested, use only iPhone 17 Pro/iOS 26.0 UDID `$IOS_SIMULATOR_UDID`.

## Shared interfaces

The following are proposed implementation contracts, not existing APIs:

```ts
// backend/src/worker/worker-routes.ts
export type WorkerId = string; // validated at registration/migration boundary
export type WorkerState = "enabled" | "draining" | "revoked";
export interface WorkerPrincipal {
  workerId: WorkerId;
  credentialDigest: string; // internal only; never logged or returned
  authMode: "legacy" | "fleet";
}
// WorkerAuthenticatedRequest carries worker: WorkerPrincipal.
```

The digest lets long-poll rechecks reject a rotated credential that authenticated earlier. Ordinary operation also rechecks state at the transaction boundary. Use the principal throughout the backend, not a mixture of untrusted request fields and free-form IDs.

```ts
// worker-registry.service.ts
authenticate(secret: string): Promise<WorkerPrincipal>;
assertCurrent(principal: WorkerPrincipal, session?: ClientSession): Promise<WorkerState>;

// worker-coordinator.service.ts: retain existing DTO types
claim(principal: WorkerPrincipal, sessionId: string): Promise<WorkerAssignment | null>;
heartbeat(principal: WorkerPrincipal, dto: WorkerSelectorDto): Promise<WorkerHeartbeatReply>;
stage(principal: WorkerPrincipal, selector: WorkerEvent,
      report: ProcessingReport): Promise<WorkerStatusReply>;
// Existing internal assignment lookup also requires the principal.

// worker-claim-wait.service.ts
claim(principal: WorkerPrincipal, sessionId: string, waitSeconds: number,
      signal?: AbortSignal): Promise<WorkerAssignment | null>;

// worker-output.service.ts
reserve(principal: WorkerPrincipal, dto: WorkerOutputDto): Promise<WorkerOutputReply>;

// worker-terminal.service.ts
complete(principal: WorkerPrincipal, dto: WorkerEventDto): Promise<WorkerStatusReply>;
stopped(principal: WorkerPrincipal, dto: WorkerStoppedDto | WorkerFailDto,
        kind: 'fail' | 'cancelled'): Promise<WorkerStatusReply>;

// worker-recovery.service.ts
reconcile(principal: WorkerPrincipal, sessionId: string,
          previousAttemptId: string, stopped: boolean): Promise<RecoveryReply>;
```

`WorkerAssignment` is a named exported type for the coordinator's current serialized assignment plus `workerId`. Define it in `backend/src/worker/worker.types.ts` by matching the current `assignment()` return fields exactly. In the same file define `WorkerStatusReply = { status: JobStatus }`, `WorkerHeartbeatReply = WorkerStatusReply & { cancelRequested: boolean; leaseExpiresAt: string }`, and `WorkerOutputReply = WorkerStatusReply & { upload: Awaited<ReturnType<StorageTransfersService['createOutputGrant']>> }`. `ProcessingReport` retains the existing `{ stage: 'processing'; durationSeconds: number; decodable: true; hasAudio: true }`; use the existing `WorkerEvent` selector type. `RecoveryReply` is an assignment, an existing terminal status reply, or `{ status: 'released'; previousAttemptId: string }`. Preserve existing selector/report request hashing when adding authenticated context.

## Task 1: Registry, mode validation, and safe operator primitives

**Files**

- Create `backend/src/worker/worker-registration.schema.ts`.
- Create `backend/src/worker/worker-registry.service.ts` and `.spec.ts`.
- Modify `backend/src/worker/worker-control.schema.ts`, `worker-routes.ts`.
- Modify `backend/src/processing/processing-persistence.module.ts`, `processing.module.ts`.
- Modify `backend/src/config/environment.ts`, `processing-environment.spec.ts`, and safe environment examples discovered in the current repository.
- Create `backend/test/worker-registry.integration.mjs`.

**Produces:** validated registry/control records, `WorkerPrincipal`, mode-aware registry service, unique digest/identity indexes.

- [ ] Write failing tests for valid IDs, invalid IDs, duplicate hashes, transactionally paired registration/control creation, revoked authentication, draining authentication, and absence of plaintext secret storage.
- [ ] Add environment tests: legacy mode requires the existing digest; fleet mode does not use it as fallback; default mode remains legacy; waiter limit default 32 and bounds 1–1024.
- [ ] Implement schema/service with current Mongoose patterns and `.js` ESM imports. `register` must insert registration/control atomically. Add a separate monotonic `controlRevision` for transactional policy/authority serialization. A duplicate/invalid registration cannot leave an orphan control.
- [ ] Implement authentication as bounded SHA-256 input processing plus registry lookup and verification. Do not echo bearer material, digests, or database errors containing credentials.
- [ ] Run focused Vitest tests, build, and the isolated registry integration file. Verify model initialization creates declared indexes without backfilling data.

Core test assertion to include in the existing guard fixture after making activation async:

```ts
await expect(guard.canActivate(context)).resolves.toBe(true);
expect(req.worker.workerId).toBe("z440-02");
expect(JSON.stringify(publicWorkerStatus)).not.toContain(workerDigest);
expect(JSON.stringify(storedRegistration)).not.toContain(workerSecret);
```

Define `publicWorkerStatus` using the registry's safe status projection that Task 6 exposes through the admin API. Test fixture secrets must be clearly artificial.

## Task 2: Per-machine atomic claims and persistent ownership

**Files**

- Create `backend/src/worker/worker.types.ts`.
- Modify `backend/src/jobs/job.schema.ts`, `job-attempt.schema.ts`.
- Modify `backend/src/worker/worker-coordinator.service.ts`, `worker.controller.ts`.
- Modify `backend/test/worker-coordinator.integration.mjs`.
- Create `backend/test/worker-fleet.integration.mjs`.

**Consumes:** Task 1 registry/principal. **Produces:** owned assignments and attempts with per-machine controls.

- [ ] Extend the real replica-set fixture in `worker-coordinator.integration.mjs` to create registrations/controls for `z440` and `z440-02`; preserve its existing storage grant stub and queued-job setup.
- [ ] Write the concurrent-claim regression before changing the coordinator. For two different principals and two queued jobs, both calls succeed and return different jobs. For two sessions sharing one principal, at most one distinct attempt succeeds.
- [ ] Add worker ownership fields and update assignment/control/attempt writes inside the existing `ProcessingTransactions.run` boundary. Preserve `queueOrder` ordering and driver transaction retries.
- [ ] Replace each hard-coded control lookup/update in the coordinator with the authenticated principal's ID. Ensure registration state/current credential is checked before allocation in the same transaction. Compare/update the observed control revision so a concurrent admin policy mutation to the registration cannot evade MongoDB write-conflict detection.
- [ ] Add `workerId` to assignment responses; keep existing request DTO selectors compatible.
- [ ] Run compiled Node integration tests for one worker, two workers, repeated same-session claims, competing sessions, and 20 simulated identities. Check DB invariants after completion rather than relying only on HTTP response counts.

Use the following assertions in the extended existing native fixture:

```js
const result = await Promise.all([
  service.claim(principalA, randomUUID()),
  service.claim(principalB, randomUUID()),
]);
assert.equal(new Set(result.map((x) => x.jobId)).size, 2);
assert.equal(new Set(result.map((x) => x.workerId)).size, 2);
assert.equal(await attempts.countDocuments(), 2);
assert.equal(await workers.countDocuments({ activeJobId: { $ne: null } }), 2);
```

Construct `principalA` and `principalB` through `registry.authenticate` using the registered artificial fixture secrets, rather than bypassing registry semantics with arbitrary IDs.

## Task 3: Authorization across heartbeat, outputs, terminal events, and receipts

**Files**

- Modify `backend/src/worker/worker-auth.guard.ts`, `.spec.ts`, `worker.controller.ts`, `worker.controller.spec.ts`.
- Modify `worker-coordinator.service.ts`, `worker-output.service.ts`, `worker-terminal.service.ts`.
- Modify `backend/test/helpers/audio-processing-fixture.mjs` to offer a second artificial worker credential without changing default callers.
- Modify `backend/test/worker-output.integration.mjs`, `worker-races.integration.mjs`.
- Create `backend/test/worker-ownership.integration.mjs`.

**Consumes:** owned assignment contract. **Produces:** all lifecycle endpoints scoped to an authenticated worker principal.

- [ ] Extend the HTTP fixture's existing worker auth selector with `worker-b`; derive both identities from their actual registered test keys.
- [ ] Add parameterized cross-worker tests for stage, heartbeat, output-url, complete, fail, cancelled, and reconcile using valid selectors belonging to A with B's credential.
- [ ] Repeat complete/fail/cancel with an already successful event ID under B's credential. Verify no cached receipt or job data escapes before ownership validation.
- [ ] Thread the principal from Nest's authenticated request through all service entry points and internal receipt/lookups. Transactions granting side effects compare/update `controlRevision` during authority checks, so revocation/policy changes conflict and revalidate. Keep bearer parsing/duplicate-header tests and fail-closed configuration tests.
- [ ] Clear a control only with matching authenticated worker, active job, and attempt; verify the update count. Preserve idempotent retries and cancellation winning a race with output verification.
- [ ] Run scoped unit/HTTP tests and existing output, recovery, cancellation, and race integration tests.

Required HTTP regression pattern using the existing fixture request helper:

```js
const response = await f.request(
  "POST",
  "/worker/heartbeat",
  selectorA,
  "worker-b",
);
assert.equal(response.status, 409);
assert.equal((await f.jobs.findById(selectorA.jobId)).workerId, "z440");
assert.equal(await f.jobs.db.model("NotificationOutbox").countDocuments(), 0);
```

Assert the same non-leaking ownership failure for unknown versus foreign selectors; authentication failures remain 401. Existing public/user routes must retain their current auth behavior.

## Task 4: Independent recovery, draining, and bounded claim waits

**Files**

- Modify `backend/src/worker/worker-recovery.service.ts`, `worker-claim-wait.service.ts`, `worker-claim-wait.service.spec.ts`.
- Modify `backend/src/processing/processing-maintenance.service.ts`.
- Modify `backend/src/jobs/jobs-query.service.ts`.
- Modify `backend/test/worker-recovery.integration.mjs`, `worker-claim-wait.integration.mjs`, `worker-claim-intent.integration.mjs`.
- Create `backend/test/worker-fleet-recovery.integration.mjs`.

**Consumes:** Tasks 1–3 ownership/state. **Produces:** per-worker expiry/recovery, drain release replies, and fleet-aware availability.

- [ ] Test A interrupted while B claims and completes a different job; A's original reservation remains until verified stop. Stale A events remain rejected after replacement.
- [ ] Replace singleton expiry scanning with indexed, bounded batches, one transaction per assignment. Test duplicate sweepers and one inconsistent control without abandoning other workers' checks.
- [ ] Implement enabled recovery and draining release outcomes from the spec. Requeue only after stop confirmation; preserve original queue order and cancellation state. An idempotent repeat of a released recovery must return the same release result.
- [ ] Replace eight-waiter admission with configured process budget and per-worker admission. Revalidate credentials/state on every claim recheck; release counts on all exit paths.
- [ ] Test revocation/rotation during a pending long poll, 20 distinct waiters, duplicate worker waits, HTTP disconnect, API shutdown, and claim races across two API instances.
- [ ] Update `workerAvailable` with owner-aware and queued-fleet semantics. Do not return machine IDs, hashes, or new required fields to mobile clients.
- [ ] Run the affected compiled integration files and claim-wait unit tests.

Required state assertions:

```js
assert.equal((await workers.findById("z440")).activeJobId.toString(), jobA.id);
assert.equal(
  (await workers.findById("z440-02")).activeJobId.toString(),
  jobB.id,
);
assert.equal((await jobs.findById(jobA.id)).status, "interrupted");
// A's expiry does not prevent B's terminal transition or next claim.
```

The fixture must explicitly expire both A's job lease and control lease, as the existing coordinator test does. Do not simulate recovery by deleting state or merely advancing a timer.

## Task 5: Windows installation identity and recovery compatibility

**Files**

- Modify `windows-worker/musicmute_worker/config.py`, `__main__.py`, `worker.py`, `progress.py`.
- Modify `windows-worker/Configure-Worker.ps1`, `worker.config.example.json`, `README.md`.
- Modify `windows-worker/tests/test_progress.py`, `test_worker.py`, `test_reliability.py`, `test_transport.py`, `test_loop.py`.
- Modify `backend/src/worker/worker.controller.ts` and its tests for `POST /worker/identity`.
- Add packaged tests only if new files are necessary; update `windows-worker/package.py`'s test whitelist if so.

**Consumes:** backend identity endpoint and `RecoveryReply`. **Produces:** explicit machine-bound setup without changing DSP/containment behavior.

- [ ] Test legacy config default `z440`, explicit second ID, invalid ID, correct identity handshake, mismatched identity, and protected active-journal identity change.
- [ ] Add the empty-body identity endpoint with authenticated `{ workerId, state, protocolVersion: 2 }`. Reject unexpected request properties using current DTO validation conventions.
- [ ] Prompt for the non-secret worker ID in setup, preserve hidden secret entry, and validate identity before first claim. Keep raw secrets removed before launching any separator child.
- [ ] Version/bind local installation metadata to API URL and worker ID. Preserve an unchanged legacy session UUID and journal. Do not silently reset state on mismatch.
- [ ] Handle a fleet `status: released` reconcile reply by clearing only active assignment bookkeeping, preserving retained media, and returning to the idle loop. Test cancellation versus non-cancelled release separately.
- [ ] Run focused tests, then the Windows package suite. Re-run native containment and quality checks only if changes touch those boundaries or expose a failure.

Essential Python regression using the existing `test_worker` fixture:

```python
worker = Worker(config_for_a, api_returning_b_identity, transfers)
with self.assertRaisesRegex(RuntimeError, "identity"):
    worker.run_once()
self.assertNotIn("claim", [route for route, _ in api_returning_b_identity.calls])
self.assertEqual(saved_session_before, session_file.read_bytes())
```

Adapt the fake API's identity reply in one fixture location so existing behavior tests do not accidentally bypass the handshake. An identity error cannot become a media failure acknowledgement.

## Task 6: Protected admin APIs, one-time keys, and explicit migration

**Files**

- Create `backend/src/worker/worker-admin.service.ts`, `.spec.ts`.
- Create `backend/src/worker/worker-admin.controller.ts`, `worker-admin.module.ts`, `worker-admin.cli.ts`, `worker-admin-event.schema.ts`.
- Create `backend/src/worker/dto/worker-admin.dto.ts` and `.spec.ts`.
- Reuse the completed dashboard's existing admin-authentication, permission, and access-management foundation. Identify its actual source paths on resumption and add only the worker-specific permission integration it requires; do not create a competing admin account system.
- Create `backend/test/worker-admin.integration.mjs`, `admin-access.e2e-spec.ts`, and `worker-migration.integration.mjs`.
- Modify `backend/package.json`, safe environment examples, `backend/README.md`, `backend/docs/api/audio-processing.md`, `windows-worker/README.md`.

**Consumes:** registry/control/ownership services and the existing Firebase `AuthRequest.identity`/active user contract. **Produces:** protected admin routes, owner-controlled grants, one-time key delivery, and trusted bootstrap/migration commands.

The existing global AuthGuard authenticates the Firebase user; the new route permission guard checks `req.identity.uid` against server-owned `admin_access`. A valid Firebase token alone is insufficient. No client profile update can modify grants. Permissions are `workers.read`, `workers.manage`, and `admin.access.manage`. The first owner receives all three through an explicitly authorized backend bootstrap, with no public bootstrap endpoint. Every later grant change requires the owner's `admin.access.manage` permission; preserve the last owner and audit actor/target.

Implement the exact fleet routes listed in the spec. Keep ordinary worker bearer credentials completely separate from admin identity. Require a recent verified sign-in for sensitive mutations and use existing rate-limit infrastructure for bounded per-admin mutation budgets.

Create/rotate credential request contract:

```ts
type CredentialInput =
  { mode: "generate" } | { mode: "import"; sha256: string };
type CreateWorkerInput = {
  id: string;
  label: string;
  operationId: string; // UUID, administrative audit/idempotency identity
  credential: CredentialInput;
};
```

Use explicit DTO validation for the discriminated credential input; reject mixed fields and raw secret fields. For `generate`, compute `randomBytes(32).toString('hex')`, persist SHA-256 only, and return the raw key once with a safe worker summary. For `import`, store the validated digest and return no raw key. Use `Cache-Control: no-store`. The unique operator event/operation ID is committed atomically with mutation; replay of a key-issuing operation returns a safe conflict instead of rotating again or revealing plaintext. Never automatically retry create/rotate in the UI.

Limited trusted-backend command interface (implemented by this task; not runnable yet):

```sh
npm run worker:admin -- bootstrap-owner --firebase-uid OWNER_UID
npm run worker:admin -- release-stopped --id z440-02 --attempt-id UUID --reason "Verified powered off"
npm run worker:admin -- migrate-legacy --dry-run
npm run worker:admin -- migrate-legacy --apply
```

- [ ] Test anonymous 401, ordinary signed-in user 403, worker-key rejection, read-only versus management grants, manager self-promotion rejection, permission removal, recent-login enforcement, and last-owner protection.
- [ ] Test duplicate ID/hash rejection, generated/imported key paths, one-time response loss/replay, secret-free list/audit output, drain preserving active work, idle-only rotation, emergency revocation retaining the slot, and exact-attempt stopped release.
- [ ] Implement the admin permission foundation and fleet controllers with narrow DTOs. Use existing Firebase/session verification rather than trusting client role claims. Protect all grant mutations; no ordinary account is automatically granted access on sign-in.
- [ ] Implement register/list/drain/enable/rotate/revoke using registry services with current-state transaction predicates. Policy/key mutations also increment the matching control revision atomically, and tests force both commit orders against in-flight claims/stage/terminal operations. `enable` must not silently reactivate a revoked old key; require explicit idle rotation to a fresh key before it can be enabled.
- [ ] Implement stopped release with exact worker/attempt comparison and stop-attestation reason. Reject stale IDs, cancelled-job requeue, and expiry-only release. Add operator events with actor UID, action, worker/attempt, reason, timestamp, and unique operation ID; exclude keys, hashes, URLs, and media names.
- [ ] Implement an idempotent legacy migration: import the configured digest into `z440`, preserve session/generation/control state, backfill owned jobs/attempts in bounded batches, and report counts without values. Refuse apply with unreleased active work or conflicting identity/hash mappings. Dry-run performs no writes.
- [ ] Add interrupted/repeated migration and rollback-precondition tests. Do not use automatic startup migrations or modify/drop existing production indexes.
- [ ] Document admin-generated one-time keys, optional OpenSSL generation/import, exact-character hashing, per-machine DPAPI setup, backup/rotation, and mode-switch order. No example contains actual production keys.
- [ ] Run HTTP authorization/secret-handling tests and compiled CLI tests against isolated MongoDB/Redis. The limited CLI module must initialize only required persistence/config/operator services, exit cleanly, and never start HTTP listeners or normal maintenance loops.

The dashboard and its admin foundation must exist before this task resumes. Reuse their verified-principal and permission services. The proposed bootstrap/grant APIs above describe security requirements, not authorization to build an independent admin foundation. Reconcile them with the completed dashboard before implementation. The mandatory outcomes remain default-deny access, explicit owner approval, server-only grants, and permissions checked on every admin API call.

## Task 7: Integrate with the user's completed dashboard

**Prerequisite and ownership:** wait for the user to build the dashboard and request resumption. Inspect its actual frontend paths, framework, components, API client, login, and permissions. Do not build its application shell, navigation system, login pages, or a second web project. Backend files are Task 6's controllers/DTOs plus `backend/docs/api/audio-processing.md`.

**Consumes:** the user's existing dashboard and protected fleet APIs. **Produces:** worker/key management integrated into that dashboard using its established patterns. Adapt the proposed routes and views to its actual structure rather than imposing a separate dashboard design.

- [ ] Add `/admin/workers` list/detail/create views using the page's established authenticated API client. Display online/offline, state, last seen, and current job; include loading, empty, retryable error, and permission-denied states.
- [ ] Implement create/rotate as explicit one-shot mutations. Show a raw generated key only in its immediate copy dialog; clear component state on close/navigation and exclude response bodies from analytics/error reporting and persistence.
- [ ] Handle response loss by inspecting worker state and offering a deliberate idle rotation. Do not retry a key-issuing operation automatically or imply the old raw key can be recovered.
- [ ] Provide drain progress and state-gated enable/rotate/revoke/release actions. A stale UI must handle backend 409 without overriding current worker state.
- [ ] Reuse existing owner/access-management controls; integrate worker-specific permissions without building a new admin-management page. Verify normal users and worker managers cannot invoke access-grant actions.
- [ ] Test ordinary signed-in users denied, read-only staff restricted, approved owner actions, reauthentication, key dialog cleanup, failed requests, and last-owner protection using the chosen admin project's test tooling.
- [ ] Verify the real page with staging identities and artificial worker keys before production onboarding. No secret snapshots or live credentials in test fixtures.

## Task 8: Integration matrix, documentation, and package review

**Files**

- Modify `backend/package.json` to include the new integration files in the existing processing integration command.
- Modify existing fixture tests that assume only one global slot, keeping explicit single-identity coverage.
- Update `backend/docs/api/audio-processing.md`, `backend/README.md`, `windows-worker/README.md`, and this plan's execution record.

- [ ] Run all ownership, migration, receipt replay, failure-isolation, same-NAT, and concurrency cases listed in the spec. Confirm real replica-set transactions across distinct API callers, not only mocks.
- [ ] Review the repository for remaining singleton assumptions. Any remaining `z440` literal must be a documented legacy/default/test identity, not a fleet control lookup.

```sh
rg -n "findById\('z440'\)|_id: 'z440'|WORKER_ID|MAX_WAITERS" backend/src
```

- [ ] Run from `backend/`: `npm run verify`, `npm run test:processing:integration`, and `npm run test:integration` when infrastructure wiring changes. These commands must use isolated services, not production URLs.
- [ ] Run from the repository: `ruff check windows-worker backend/separate.py`, `ruff format --check windows-worker backend/separate.py`, and `python -m unittest discover -s windows-worker/tests -v` with `PYTHONPATH=windows-worker`. Record platform skips and the known macOS process-cleanup limitation separately from native Windows results.
- [ ] Build the Windows ZIP using `python windows-worker/package.py`; verify every archive entry against source and exclude runtime files/keys. Build the API archive using `npm run package:caprover` and inspect its source/runtime exclusions.
- [ ] Review the staged diff and concrete rollout checklist. No production deployment occurs as part of source validation.

## Task 9: Authorized rollout and two-machine native proof

**Prerequisites:** separate authorization for deployment/migration and access to a second worker machine. Having only one Z440 is sufficient for implementation and simulated fleet tests, but not real multi-machine proof.

- [ ] Confirm current API replica versions and worker idle/assignment state. Back up intended source/config metadata without copying secrets into the repository.
- [ ] Deploy backend in legacy mode, upgrade the current worker, and verify its identity/one-job behavior while retaining its current key and durable session.
- [ ] Let the current job finish and stop the legacy worker at verified idle before registry import; run migration dry-run; obtain authorization for the concrete migration if not already covered; apply, read back invariants, and switch all replicas to fleet mode.
- [ ] Provision the initial owner explicitly and verify that ordinary signed-in users are denied admin access. Through the admin page, register/configure a second unique worker and key. Run `Start-Worker.ps1 -Check`, `-SelfTest`, and a live one-job check on each machine. Verify Task Scheduler and SYSTEM-only wake protection on each.
- [ ] Submit two authorized test jobs through the normal upload path. Prove distinct owners, simultaneous processing, exact result ownership, verified S3 output, and no duplicate completion notifications.
- [ ] Disconnect one machine during an assigned test job. Verify its job remains interrupted/reserved while the other handles new work. Restore/verify stopped recovery, then test drain and key rotation on the idle machine.
- [ ] If application UI/playback verification is requested, use only the designated iPhone simulator. Record API, native processing, storage, notification, and playback evidence separately.
- [ ] Leave the agreed worker fleet running, document actual throughput and remaining limits, and preserve an explicit rollback gate requiring all non-legacy slots to be safely released.

## Plan self-review checklist

- [x] Registry/authentication, job ownership, cached receipts, all terminal paths, recovery sweep, public availability, claim admission, admin permissions/page contracts, one-time keys, operator lifecycle, Windows identity, migration, and rollback are covered.
- [x] Worker context signatures are consistent across guard, controller, coordinator, output, terminal, and recovery services; policy changes and worker side effects share a transaction conflict boundary.
- [x] Normal tests do not create production keys, write production data, restart machines, or use live infrastructure.
- [x] Confirmed scope is 2–5 machines and management through the upcoming admin page. The Firebase login proposal uses explicit owner-approved grants, never automatic admin access.

## Execution record

Planning only. Current source contracts and validation commands were inspected. Self-review covered the user's admin-page correction, explicit permissions, receipt authorization, policy/claim transaction races, legacy migration ordering, and one-time key delivery. No fleet implementation, production key generation, production migration, or deployment has been performed.

Latest user instruction: wait until the user builds the dashboard, then use that dashboard directly. Implementation is paused; dashboard construction is excluded. Refresh this plan against the completed dashboard before executing any task.
