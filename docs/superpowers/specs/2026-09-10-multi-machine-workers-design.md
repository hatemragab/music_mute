# Multi-machine Windows workers — proposed design

Status: paused at the user's request until they build the dashboard and request resumption. This task will integrate with that dashboard; it will not build a dashboard. Application implementation and deployment are not authorized by this document.

## Objective and initial scope

Allow multiple independently configured Windows machines to process different MusicMute jobs concurrently from the existing MongoDB FIFO queue. Each machine runs one job and one reusable Kim_Vocal_2 engine. The existing Z440 continues to work during a controlled migration.

Confirmed scope and recommended admin-access design:

- The user selected 2–5 machines initially; include an automated 20-worker concurrency test. This is a validation target, not a purchased-machine requirement or a guaranteed throughput figure.
- The user will build the dashboard first. Wait for it and a request to resume, then inspect and reuse its layout, components, API client, login, and permissions for worker-management integration. Do not construct another dashboard or admin foundation. The proposed administration contracts below must be reconciled with the completed dashboard. CLI access is limited to trusted migration/recovery and any bootstrap actually required by that existing foundation.
- Recommended login: reuse the existing verified Firebase identity, with separate server-controlled admin permissions. In response to the user's concern, signing in never automatically grants admin access. Start with one explicitly provisioned owner account; adding other administrators requires an explicit owner action.
- Workers use Windows, DirectML, the same model/output contract, and outbound HTTPS. No inbound worker service or shared local disk is required.
- Keep the existing conservative recovery policy: lease expiry alone never authorizes reassignment of unfinished processing.

## Current implementation verified

- `backend/src/worker/worker-routes.ts` fixes the authenticated identity to `z440`.
- `worker-auth.guard.ts` checks one SHA-256 digest from `PROCESSING_WORKER_KEY_SHA256`.
- `worker-control.schema.ts` permits only `_id: 'z440'`; coordinator, recovery, terminal, and public availability queries address that singleton.
- Jobs and attempts record session/attempt/generation, but not a machine owner.
- `worker-claim-wait.service.ts` allows eight waiters per API process.
- Windows already supplies DPAPI secret storage, a local global mutex, process containment, durable assignment/session state, bounded transfer retries, warm-model reuse, and boot startup.
- MongoDB transactions already serialize conflicting claims; S3 object identities and event receipts support verified, idempotent completion.

## Approaches considered

| Approach                                                              | Advantages                                                                                          | Costs                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| MongoDB worker registry with per-machine slots and keys — recommended | Reuses current queue and leases; immediate per-machine control; no API restart to register machines | Requires ownership changes throughout the job lifecycle and protected admin APIs                    |
| Environment variable containing multiple worker IDs and hashes        | Small initial authentication change                                                                 | Registration/rotation requires configuration rollout; draining and status still need database state |
| New broker and orchestration platform                                 | Could support a substantially different deployment model                                            | Adds infrastructure and replaces working coordination without a present requirement                 |

Use the MongoDB registry. Redis remains the existing shared infrastructure; it does not become the business queue.

## Invariants

1. Each worker ID has at most one assigned, unreleased attempt. Distinct workers may own distinct jobs simultaneously.
2. Each job has at most one assigned, unreleased attempt. A job is never assigned twice because two API replicas claim concurrently.
3. Every worker operation is authorized using the identity derived by the backend from its credential, never a caller-supplied job-owner field.
4. Authority requires matching worker ID, job ID, attempt ID, session ID, generation, and the existing live-lease requirements.
5. No terminal receipt, presigned URL, or recovery result is returned before checking the authenticated worker's ownership.
6. An expired worker keeps its unfinished slot until verified stop recovery. Other workers continue claiming queued jobs.
7. No changes to user authorization, private S3 transfers, upload validation, cancellation semantics, or voice-only output quality.
8. FIFO means oldest eligible queue order at each successful assignment. Parallel jobs may finish in a different order.

## Persistence

Add `audio_workers`, represented by `WorkerRegistration`:

| Field                    | Contract                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `_id`                    | Stable operator-selected ID; `^[a-z0-9][a-z0-9-]{0,63}$`; retain `z440` for the current machine |
| `label`                  | Non-secret display label, 1–80 characters                                                       |
| `keySha256`              | Lowercase 64-character SHA-256 hex digest; unique index; never returned by status commands      |
| `state`                  | `enabled`, `draining`, or `revoked`                                                             |
| `createdAt`, `updatedAt` | Audit timestamps                                                                                |

Keep `audio_worker_control` as the operational slot collection. Its `_id` becomes a validated worker ID rather than an enum. Preserve active job, session, attempt, generation, lease, and last-seen fields. Add a monotonic `controlRevision` used for compare-and-update serialization of policy and attempt actions; it is separate from the attempt generation. Add an index on lease expiry with active-job filtering appropriate to the actual MongoDB query plan. Registration and control creation happen together through the operator service; an unknown credential cannot create either record.

Add a nullable `workerId` to `Job` and a required owner for newly created `JobAttempt` records. Unassigned queued jobs have no owner. Preserve ownership on completed attempts for audit and receipt authorization. Keep attempt IDs globally unique and existing FIFO indexes. In legacy mode only, missing historical ownership is interpreted as `z440`; an explicit migration backfills assigned jobs and attempts before fleet mode is enabled.

The worker registration/control identity must never be renamed or deleted while history references it. Revocation retains records and attempts.

## Authentication and OpenSSL

OpenSSL remains a supported manual way to generate a high-entropy bearer secret:

```sh
openssl rand -hex 32
```

This generates a new 32-byte random secret encoded as hex. Generate a different secret for every machine. These are worker API credentials, separate from SSH keys and Windows login credentials. No production secret is generated or collected during planning.

The normal admin-page flow generates the same amount of random secret material using the backend's existing Node `crypto.randomBytes(32).toString('hex')`; spawning OpenSSL from the API is unnecessary. The create/rotate response delivers the raw key once over HTTPS with `Cache-Control: no-store`. Persist only its digest. The page keeps the raw value only while the one-time copy dialog is open; exclude it from logs, analytics, error reports, caches, and browser persistence. There is no later reveal endpoint. If the response is lost, inspect the existing worker and explicitly issue a new idle-worker key rather than replaying or retrieving the lost plaintext.

The operator copies the one-time raw secret into that worker's existing hidden configuration prompt, which stores it using Windows DPAPI. The backend registry stores its SHA-256 digest. For optional OpenSSL-generated imports, accept only the precomputed digest in the admin registration request. Hash the exact secret characters without a trailing newline; do not register the digest of a text file's extra newline. Normal admin-generated setup does not require manually computing a hash or changing CapRover variables for every machine.

Authentication remains `Authorization: Bearer <raw secret>`. In fleet mode, the guard hashes the bounded bearer, resolves its registration through the unique digest index, verifies it, rejects revoked credentials, and attaches a server-owned `workerId`. There is no client-controlled ownership header to trust. Drain state permits existing-attempt operations but prevents new assignments. Revalidate current credential/state inside each long-poll recheck so a pending request cannot claim work after rotation or revocation; the transaction also checks registration state before allocating a slot.

Keep two explicit deployment modes:

- `legacy`: existing environment digest is required and maps only to `z440`.
- `fleet`: registered per-machine digests are authoritative; the legacy environment digest is not a fallback. The existing digest may be imported into the `z440` registration so the current machine does not need a secret change during migration.

Environment validation is conditional on mode. Do not store a list of raw worker secrets or AWS credentials in backend configuration. Do not keep positive authentication caches that delay revocation in the first version.

## Claims and lifecycle ownership

Pass authenticated worker context into every coordinator, output, terminal, receipt, and recovery entry point. A worker cannot act on another worker's assignment even if it knows all its selector values or replays a previously successful event ID.

Within the existing MongoDB transaction, validate the registration, read that worker's control, and return its live assignment for an idempotent repeat. If the slot is free and the registration is enabled, select the oldest eligible queued job, update its owner and attempt, update only this control record, and create the owned attempt. Transaction conflicts must retry from a fresh snapshot; there is no read-then-claim operation outside this transaction. Duplicate sessions for one identity compete for one slot and cannot double its capacity.

Do not rely only on reading registration state inside a snapshot transaction: that can race with a policy update to another document. Registration lifecycle/key mutations update the same control's `controlRevision` in their transaction. Claims and transactions granting worker side effects compare/update the observed control revision as part of their authority check. This forces a conflict/recheck if drain, revoke, or rotation races with a claim/operation, rather than allowing an action from an obsolete policy snapshot. Test both commit orders explicitly.

Include `workerId` in newly returned assignments. Existing stage, heartbeat, upload, complete, fail, and cancelled request DTO selector fields can remain unchanged: the additional ownership dimension comes from authentication, not the request body.

Terminal receipt lookup must first scope the referenced job/attempt to the caller. Preserve existing request-hash calculations for legacy receipt replay; adding ownership checks must not make existing successful events fail solely because the hashing format changed. A terminal event clears only a matching worker/job/attempt control record and must verify that the expected update occurred.

## Recovery, drain, and revocation

- Sweep expired controls in bounded batches, with one transaction per assignment. One inconsistent worker must be reported without preventing recovery checks for healthy records. Concurrent maintenance instances must remain idempotent.
- Expiry marks the affected attempt interrupted and retains its control reservation. No other machine automatically receives that job. It does not reserve the whole fleet.
- The original worker may reconcile after its local process supervisor verifies termination. An enabled worker may receive a replacement attempt using existing recovery behavior.
- A draining worker may finish an active job. Once idle, its claims return empty and update liveness without allocating work.
- If a draining worker reconciles an interrupted attempt after proving stop, release its reservation and requeue the non-cancelled job with its original FIFO order. Return an explicit `{ status: 'released', previousAttemptId }` reply; the upgraded Windows worker clears its active journal, retains media under the existing retention policy, and continues its idle loop. A cancelled job becomes cancelled rather than queued. This response is fleet-mode-only.
- For a permanently unavailable machine, an operator may release a specific attempt only after independently verifying that the old processes stopped, for example through confirmed shutdown. Require exact worker/attempt identifiers and a non-secret audit reason; recheck them transactionally. This is not an automatic timeout action.
- Normal key rotation is idle-only after draining. Revocation takes effect immediately for new calls; emergency revocation during a job leaves its slot reserved until safe recovery. Revocation does not retroactively invalidate an already issued S3 URL, so attempt-specific object identities and finalization fences remain mandatory.

## Windows configuration and identity

The distributable remains one common source-only ZIP. Configure each machine separately; do not clone another machine's DPAPI file, session, assignment journal, or progress state.

Add a non-secret `worker_id` setting. Preserve `z440` as the legacy default for existing configurations. Add authenticated `POST /worker/identity` with an empty body returning `{ workerId, state, protocolVersion: 2 }`. Before its first claim, an upgraded worker verifies that the returned identity matches its configured ID. In legacy mode, the upgraded backend also provides this endpoint for the existing identity. Do not enable multiple machines against an old backend.

Bind durable installation state to API URL and worker ID while preserving the existing session UUID for an unchanged installation. A change of identity or API with an active journal must fail safely; setup must not erase or automatically reinterpret the journal. Test the identity transition with old configuration/session files explicitly.

Keep one local global mutex and one warm engine per machine. Preserve boot-before-sign-in setup, SYSTEM-only wake protection, exact PCM rounding, transfer retry limits, cancellation containment, and secret removal before child process launch. No GPU or audio-processing algorithm changes are part of fleet support.

## Admission and availability

Replace the fixed eight-waiter limit with validated `PROCESSING_WORKER_MAX_WAITERS`, default 32 per API process, bounded 1–1024. Allow at most one pending long poll per worker per process; additional requests receive bounded `429 Retry-After`. Rechecks use worker-scoped claims and credential/state validation. Disconnect, expiry, exception, revocation, and shutdown paths release admission counts. Database fencing remains authoritative across replicas; a process-local limiter is not a distributed lock.

Review existing external request-rate controls for shared-NAT behavior before enabling the fleet. Do not introduce a fleet-wide bucket that lets one malfunctioning machine exhaust every worker's budget. Bound any new worker-specific limits by the authenticated ID, retaining separate unauthenticated abuse controls.

Preserve the user-facing `workerAvailable` Boolean without exposing fleet identities or counts:

- For an assigned/interrupted job, availability refers to its actual owner's freshness and permitted active-work state.
- For an unassigned queued job, availability means at least one enabled worker is recently online, including busy workers; it is not a promise of an immediately free slot.
- A fresh idle poll counts as online. A revoked or merely historical worker does not.

The admin worker list reports ID, label, state, online/offline, active job/attempt, and last seen. Detailed hardware telemetry is outside the initial fleet scope.

## Admin page and permission boundary

Current backend user authentication verifies Firebase identity and active provisioned user status. It does not currently define admin permissions. Add a separate `admin_access` collection keyed by verified Firebase UID, containing a server-controlled set of permissions and audit metadata. No grant means no admin access. Do not add writable admin flags to public profile DTOs or trust roles supplied by the browser.

Permissions are `workers.read`, `workers.manage`, and `admin.access.manage`. The initial owner receives all three through an explicitly authorized, trusted-backend bootstrap operation. Worker managers receive only the worker permissions; they cannot promote themselves or grant access to anyone else. Additional admins are selected explicitly through the upcoming owner's access-management page. Preserve at least one owner; changing the last owner requires a deliberate trusted-backend recovery procedure, not a normal web request.

All `/admin/*` operations run the existing Firebase authentication guard first and a server-side permission guard second. A valid ordinary app user receives 403; no Firebase session receives 401. A worker bearer key cannot access these routes. Every request rechecks permissions so removal takes effect on the next call. Hiding a menu or guarding a frontend route is convenience, not authorization. New registrations, key generation/rotation, emergency revocation, permission changes, and stopped-release attestations require a recent verified Firebase sign-in (maximum five-minute `authTimeSec` age), with reauthentication requested by the UI when needed.

The upcoming admin page uses existing Firebase login and sends its ID token to these protected APIs. If its wider project later chooses a different login method, preserve the same verified-principal/permission boundary rather than exposing fleet routes without an admin guard.

Planned fleet endpoints:

| Route                                            | Permission       | Behavior                                                                      |
| ------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------- |
| `GET /api/v1/admin/workers`                      | `workers.read`   | Paginated safe worker/control summaries; no raw keys or digests               |
| `POST /api/v1/admin/workers`                     | `workers.manage` | Register ID/label; generate key once or import a digest; no duplicate ID/hash |
| `GET /api/v1/admin/workers/:id`                  | `workers.read`   | Safe worker details and bounded recent operator events                        |
| `POST /api/v1/admin/workers/:id/drain`           | `workers.manage` | Finish existing work, refuse new assignments                                  |
| `POST /api/v1/admin/workers/:id/enable`          | `workers.manage` | Resume a valid non-revoked registration                                       |
| `POST /api/v1/admin/workers/:id/rotate-key`      | `workers.manage` | Idle-only replacement, one-time key response; no automatic retries            |
| `POST /api/v1/admin/workers/:id/revoke`          | `workers.manage` | Immediate revocation; explicit emergency intent if active                     |
| `POST /api/v1/admin/workers/:id/release-stopped` | `workers.manage` | Exact-attempt operator stop attestation; retains strict recovery policy       |

Access-management endpoints in the upcoming admin foundation (`GET /admin/access`, `PUT /admin/access/:firebaseUid`, `DELETE /admin/access/:firebaseUid`) require `admin.access.manage`. They operate on already provisioned active users and bounded permission enums, audit actor/target, and cannot remove the last owner. Treat this as a prerequisite admin-foundation deliverable; it is not an unrestricted user-profile update.

Once the user's dashboard exists, integrate worker controls using its established patterns for loading/error/empty states, safe refresh, worker creation, a one-time key-copy dialog, drain progress, idle-only rotation, explicit emergency revoke/recovery confirmation, and online/offline indicators. Handle 401, 403, stale-state 409, rate limits, and lost one-time-key responses. Do not automatically retry key-issuing mutations. Dashboard construction, application scaffolding, navigation, login screens, and a separate admin-access UI are excluded; reuse the completed dashboard's foundation.

Every administration mutation writes an audit event with actor UID, action, worker ID, optional attempt ID, non-secret reason, operation ID, and time. Never audit key material, hashes, presigned URLs, or media names.

## Operator workflow and rollout

Normal administration uses the protected admin page/APIs above. Trusted backend CLI operations are limited to `bootstrap-owner`, `migrate-legacy`, and emergency `release-stopped`. Run them in the backend environment using existing database configuration. There is no unauthenticated registration endpoint and no worker credential can register another worker.

1. Implement and validate backend changes in legacy mode with isolated MongoDB/Redis.
2. Deploy the upgraded API to all replicas in legacy mode; ensure no old API binary remains before enabling fleet mode.
3. Upgrade the current Z440 worker while idle. Verify local checks, identity, authenticated empty-queue/one-job behavior, and background task state.
4. Let the current job finish and stop `z440` at confirmed idle, require no unreleased active attempt, and run an explicit migration dry run. This does not assume a registry/admin drain operation exists before import. Apply an idempotent, batched backfill/import only after operator authorization. Do not migrate documents during application startup or drop/rewrite existing indexes automatically.
5. Verify every assigned job/attempt has an owner, the existing control is consistent, registry hashes are unique, and the current credential resolves to the same `z440` identity. Switch all API replicas to fleet mode, then enable that worker.
6. After the admin page and permission foundation are available, register a second distinct worker through that page, configure its one-time raw key on the second Windows machine, and verify two real jobs process concurrently. Existing media and credentials stay local.
7. Expand gradually after observing isolation, memory use, transfer load, and task recovery. Do not assume linear end-to-end speedup from worker count.

Rollback to legacy mode requires draining all non-legacy workers and verifying that they have no unreleased assignments. Never deploy the old singleton binary while another machine owns an attempt. Keep the additive registry/history data; rollback is not a data-deletion operation.

## Acceptance criteria

- Two workers claim different jobs concurrently; duplicate requests for one worker hold one slot.
- Under 20 simulated identities and competing API callers, no job has multiple unreleased owners and FIFO selection remains correct.
- Worker B cannot heartbeat, reserve, complete, fail, cancel, reconcile, or read receipts for worker A's attempt.
- Offline A holds only A's job; B continues. Stale A events cannot publish results after a verified replacement.
- Drain, idle rotation, immediate revocation, pending-claim revocation, same-NAT workers, and process shutdown admission cleanup are covered.
- An ordinary signed-in Firebase user cannot access any admin endpoint; a worker key cannot access it either. Owner bootstrap, permission removal, manager self-promotion rejection, recent-login checks, last-owner protection, and secret-free admin/audit responses have explicit tests.
- The admin page can register a worker and deliver its raw key once, recover from a lost response through explicit rotation, and perform allowed worker lifecycle actions without exposing secrets in history or browser persistence.
- Existing `z440` credentials, config, sessions, event receipts, and histories have migration and rollback tests.
- Windows identity checks, release replies, changed-identity journal protection, and existing containment/quality tests pass.
- Native fleet proof requires two separately configured machines and a real private-S3 input/output cycle, plus application playback on the designated iPhone simulator when UI verification is requested.
- No secrets appear in source packages, logs, CLI output, tests, Git, or process arguments.

The user confirmed 2–5 machines and the upcoming admin page. The proposed Firebase-plus-explicit-permissions design answers the user's access-control concern; final admin-project integration must retain that boundary. This draft does not start implementation, generate credentials, migrate live data, or change the running Z440.

The user's latest instruction takes precedence over earlier proposed admin-foundation tasks: wait for their dashboard, then integrate directly with it. Reconcile the proposed API/permission details with its actual implementation before starting fleet work.
