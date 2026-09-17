# Domain model, job ownership and worker protocol

**Protocol family:** `musicmute-worker/v1`. All fields below are implementation contracts; routes are new proposals relative to the application's actual existing API prefix. Read the global HTTP setup before mounting them. Keep existing public `/jobs` requests compatible.

## 1. Durable entities

| Entity | Minimum fields and invariants |
| --- | --- |
| Enrollment invitation | ID, random-code digest, expiresAt, consumedAt, creator, initial group/policy; one activation path |
| Installation session | ID, scoped credential digest, invitation ID, phase, outcome, sequence acknowledgements, lastSeenAt, report summary; exists before machine activation |
| Machine | ID, credential digest/revision, status, policy revision, approved capabilities, hardware report, software version, supervisor generation, desired/applied revisions |
| Worker slot | ID, machine ID, GPU ID, stable slot index, process incarnation, current session, validated capacity, allowed recipes, current attempt |
| Existing audio job | Preserve user/metadata/input/output/status/revision fields; add frozen recipe snapshot, retry eligibility, attempt number and current execution ownership |
| Attempt history | Attempt ID, job ID, machine/worker/session/incarnation, claim request ID, lease and deadline, state, stage/timings, output reservations and terminal reason |
| Log batch | Installation/machine stream, sequence range, digest, durable archive identity or bounded inline payload, ack state |
| Heartbeat sample | Machine/time/sanitized measurements, `expiresAt`; history only |
| Worker release | Immutable release ID, manifest digest, platform/backend and protocol compatibility; added for manual package lifecycle validation in branch G |

Choose a small set of Mongoose collections reflecting these boundaries; do not make a collection per telemetry metric. Keep current ownership inside the job for atomic matching. Slot reservations and attempt history can use the replica-set transactions already required by processing startup. [R4, R8]

Use UUIDs for new external fleet identifiers unless existing naming conventions dictate another consistent opaque ID. Existing job/user ObjectIds remain unchanged. Fields called `sessionId`/`incarnation` are fencing identities, not secrets; authentication remains required.

## 2. Public job state compatibility

Existing public states are `awaiting_upload`, `queued`, `validating`, `processing`, `uploading_result`, `interrupted`, `cancel_requested`, `ready`, `failed`, and `cancelled`. Do not replace them with a new uppercase enum. [R3]

| Event | Public state | Internal detail |
| --- | --- | --- |
| Reservation created | awaiting_upload | Input not yet trusted or eligible |
| Verified upload confirmed | queued | Frozen recipe and queue timestamp present |
| Claimed; input downloaded/validated | validating | Lease active; stage distinguishes download/validation |
| Separation/denoise/trim/encode | processing | Fine-grained stage and timings on attempt |
| Output upload | uploading_result | Attempt-specific reservation |
| Accepted finalization | ready | Version-pinned output committed |
| Retryable attempt lost | interrupted briefly or directly queued | Conditional recovery preserves prior attempt history |
| User cancellation | Existing cancellation contract | Invalidate ownership; signal child; reject any late result |
| Final failure | failed | Safe public code; richer sanitized internal reason |

Do not expose a signed URL, machine secret, local path, internal stack trace or S3 administration field in a public job serializer. Map new fleet errors to compatible safe public errors; extend public enums only with explicit compatibility tests.

## 3. Enqueue and claim

Restore submission/upload-confirm/retry by extending the surviving controller's currently unavailable operations behind the feature gate. Reuse existing validation, idempotency, admission/usage, settings fences and user authorization. Only jobs with verified version-pinned input enter the queue. Historical queued records lacking the new execution version/recipe are not automatically executable; migrate or reject deliberately.

For a claim request include `requestId`, `workerId`, `gpuId`, `sessionId`, `incarnation`, and applied policy revision. Machine identity comes from the credential. The server validates that the slot belongs to that machine/session and is within approved limits.

Within a bounded transaction:

1. Deduplicate the claim request. If it already granted an active attempt, return that same attempt; never claim a second job merely because a response was lost.
2. Reserve the free worker slot and check the current machine/policy/session fence. Serialize against policy/revocation changes through a conditional write to the relevant admission record, not a stale read alone.
3. Select the oldest eligible `queued` job with no valid current owner, exact matching recipe capability, not deleted/cancelled, with verified input. Use a conditional `findOneAndUpdate` with explicit update operators.
4. Generate a fresh attempt ID, increment attempt number, set ownership, lease and bounded processing deadline, create attempt history, and link the slot.
5. Commit before returning or notifying any client.

Use unique indexes for `(machineId, gpuId, slotIndex)`, scoped claim request IDs, and attempt IDs. Index eligible queue fields and lease expiry. Preserve existing job `revision`/`adminRevision` middleware; it rejects pipeline-style lifecycle updates. [R4, R7]

MongoDB single-document compare-and-set is the core job ownership primitive. Multi-document transactions coordinate slots and the existing accounting/audit boundaries; Redis locks are not required. [T6]

A no-job response is `204` or a documented empty envelope. Claims do not prefetch batches of future tasks. Transaction retries must not repeat nontransactional network side effects.

## 4. Leases, deadlines and stale attempts

A valid attempt is identified by the tuple `(jobId, attemptId, machineId, workerId, sessionId, incarnation)`. The backend clock determines lease validity. Responses include server time and lease expiry. The supervisor uses monotonic elapsed time and a conservative safety margin; it must not trust its wall clock to extend ownership.

Renew active leases in one HTTPS batch every 20 seconds. Each item returns its own accepted/expired/cancelled/revoked disposition. Renewal must check identity, active state, current session and **unexpired lease**. Never revive an expired attempt by a late renewal. Cap lease extension at the fixed processing deadline.

Machine heartbeat does not renew job ownership. The supervisor renews only live children with valid current work and acceptable stage/progress deadlines. A child that hangs while its supervisor remains alive must eventually time out. Separate stage timeout from total job deadline; a long model inference may legitimately emit no per-second progress, so base its stage budget on measured performance plus a documented safety factor and a global bound.

A scanner runs approximately every 10 seconds and conditionally handles expired leases. It compares the same attempt ID and expiry it observed, so a renewal racing the scan cannot be overwritten. Within the ownership transaction, it releases the slot, records the loss and queues a new attempt after bounded backoff, or marks the job finally failed/cancelled as appropriate.

Retries use a **new** attempt ID and fresh output key, restart from the pinned input, and keep the original recipe. Maximum three execution attempts is a configurable starting policy. An automatic attempt retry is not the public user action that creates a new linked job; preserve the existing public retry/usage contract.

Reject old progress, renewals, upload-grant requests and completions after reassignment. If an upload began before ownership expired, S3 may still accept it; it remains an orphan and cannot become the job's accepted output. Attempt fencing and pinned object versions, not presigned-link expiry alone, provide correctness. [T5]

## 5. Cancellation, pause and policy changes

Cancel/delete wins when its conditional job transition commits first. Every finalization rechecks deleted/cancelled/account status and ownership. Do not resurrect a job after cancellation or account deletion. Keep the current public cancellation behavior; there is no requirement to wait for a disconnected machine before showing cancellation.

`drain` stops new claims and lets active work finish. `pause` is an admission pause unless explicitly paired with a separate cancel action. Revoking a machine invalidates authentication/claim authority and triggers safe attempt recovery. A WebSocket cancellation hint accelerates stopping but is not the enforcement mechanism.

Dashboard policy updates use `expectedRevision` compare-and-set. Old-session/old-policy claims fail with a resync response. Active attempts keep their frozen recipe and existing parameters. Disabling denoise on a machine means it cannot claim a denoise-required recipe; it never means silently skipping the step.

## 6. S3 grant and completion protocol

Keep the existing media identity: `{key, versionId, bytes, sha256, contentType}`. Here `sha256` is **base64** as enforced by `isSha256`, whereas signed release/model SHA-256 digests use explicitly named hexadecimal fields. [R3, R4, R7]

The supervisor downloads only a backend-issued GET URL for the assigned input version and verifies byte count/checksum. Do not use arbitrary user-supplied remote URLs for worker input. Parse/validate local media after download; do not let a playlist fetch a second network resource.

Before upload, declare the result size, media checksum, content type and measured duration. The backend derives an exact output key such as `worker-jobs/<jobId>/attempts/<attemptId>/vocals.mp3` within the configured namespace and issues a bounded PUT grant. Store the reservation; do not accept a caller-chosen bucket, key, prefix or arbitrary URL. Request/refresh the grant near upload time and only under valid ownership.

Upload with the exact signed headers, obtain the immutable S3 version ID, then call complete with the reservation and version. Before finalization, the backend HEADs that exact version and verifies key, checksum, size and media type. It must not accept the latest version by key as a substitute. Media-format checks on the worker are required; S3 metadata validation is integrity checking, not proof that arbitrary hostile output is a good vocal separation.

Perform network verification outside a long database transaction, then recheck ownership/policy/account state and the expected output reservation inside the finalization transaction. Commit `ready`, the pinned output reference, attempt terminal state, slot release, usage settlement and durable notification work coherently using existing mechanisms. A repeated identical completion returns the accepted result. A conflicting duplicate or stale attempt returns a conflict, not a second accounting event.

Do not trust ETag as a universal SHA-256. Completed version pinning prevents a still-valid PUT URL from changing what clients retrieve. Track all uploaded attempt keys/version IDs for cleanup, including abandoned results and delete markers; never delete sibling objects or active results. Existing storage preflight/cleanup remains authoritative. [R5, R6, T5]

## 7. Proposed endpoint surface

Routes below are relative to the configured application API prefix. One fleet module owns them. Preserve existing user `/jobs` endpoints instead of moving clients to these private routes.

| Route | Credential | Purpose |
| --- | --- | --- |
| `POST /worker/v1/installations` | Single-use enrollment code | Exchange invitation for installation session; request replay handled safely |
| `POST /worker/v1/installations/:id/logs` | Scoped installation credential | Pre-activation diagnostics, sequence ack |
| `POST /worker/v1/installations/:id/report` | Installation credential | Preflight, service and benchmark report |
| `POST /worker/v1/installations/:id/activate` | Installation credential | Idempotent activation with locally generated machine credential digest |
| `POST /worker/v1/session` | Machine credential | New supervisor generation or resume same boot session |
| `GET /worker/v1/config` | Machine credential/session | Current effective policy and compatible release |
| `POST /worker/v1/slots` | Machine credential/session | Register bounded slots/process incarnations |
| `POST /worker/v1/claims` | Machine credential/session | Claim one job for one free slot |
| `POST /worker/v1/leases/renew` | Machine credential/session | Per-item batched renewals |
| `POST /worker/v1/attempts/:id/input-grant` | Valid current attempt | Refresh input access |
| `POST /worker/v1/attempts/:id/output-grant` | Valid current attempt | Reserve/refresh exact output upload |
| `POST /worker/v1/attempts/:id/complete` | Current attempt or same terminal operation | Idempotent finalization |
| `POST /worker/v1/attempts/:id/fail` | Current attempt or same terminal operation | Categorized failure and recovery |
| `POST /worker/v1/logs` | Machine credential | Ordered runtime diagnostic batches |
| `GET /worker/v1/events` | Authenticated WebSocket upgrade | Notices, heartbeat and progress |
| `/admin/worker-fleet/...` | Existing admin session + explicit permission | Fleet UI operations, enrollment, policy, reports, releases |

Endpoints must support size limits, redacted request logging, request IDs, typed safe errors and purpose-specific rate limiting. Do not make all worker routes globally public to bypass existing user guards. Give them an explicit machine/installation authentication path and retain separate admin checks.

## 8. WebSocket contract

Envelope: `protocolVersion`, `type`, `messageId`, `sessionId`, `sentAt`, `payload`. Backend-to-machine types: `jobs.available`, `config.changed`, `attempt.cancel`, `release.available`, `drain.requested`. Machine-to-backend types: `heartbeat`, `attempt.progress`, `config.applied`. Use a bounded max frame size, message-rate limit, ping/pong liveness and explicit invalid-message handling. No audio, secrets or arbitrary command payloads.

Authenticate the native client's upgrade using a header, not a query-string token. Reject old supervisor sessions and unauthorized upgrades before processing messages. Work notices carry no job ownership. Progress is best effort and rate-limited; accepted completion, lease state and configuration remain retrievable over HTTPS.

After reconnection, fetch effective config, reconcile owned attempts, then claim work only when safe. Treat duplicate/out-of-order hints as harmless. Missing Redis or socket notifications cannot lose the durable queue.

## 9. Error classes

Permanent input failures: invalid/empty/unsupported media, declared-vs-measured mismatch outside policy, checksum mismatch. Do not repeat them on three hosts.

Transient infrastructure failures: download/upload/network interruption under a still-valid deadline; retry boundedly, obtaining refreshed grants where authorized.

Capacity/backend failures: OOM, unsupported provider, failed GPU validation. Stop new admission to that capability, lower concurrency only within policy, and alert. Do not retry the same impossible configuration indefinitely or silently fall back to CPU.

Control failures: lease lost, cancelled, revoked, stale session, protocol mismatch. Stop or resync as specified; never publish a stale result. Store detailed sanitized internal reasons separately from compatible public errors.

Sources: [source index](../reference/SOURCES.md).
