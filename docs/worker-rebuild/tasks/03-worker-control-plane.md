# Branch 3: codex/worker-control-plane

**Parent:** accepted `codex/worker-gpu-feasibility` synchronized to collection. **PR base:** `codex/worker-rebuild`. **Checkpoints:** C1–C6.

## Assignment and prerequisites

Implement the minimum durable backend control plane inside the existing NestJS application. Preserve public job/history/account/usage behavior. Use simulated machines; real worker execution belongs to D.

Proceed only with the platform/provider pins accepted in B. Keep the backend protocol provider-neutral so another validated runtime can be added later without changing public job contracts.

## C1. Persistence, protocol and authorization boundary

Add a cohesive worker-fleet module with versioned protocol DTOs, machine identity, sessions, slots, attempts, policy, and diagnostics. Extend the existing `audio_jobs` source of truth rather than creating another user-facing job collection.

Use strict validation, explicit indexes, optimistic revisions, scoped guards, bounded payloads, and redacted errors. Internal machine/attempt fields must not leak through public serializers.

## C2. Enrollment, qualification record and revocation

Implement hashed high-entropy one-use invitations, expiry/max-use rules, restricted installation sessions, idempotent exchanges, sanitized diagnostics, recorded feasibility/runtime identity, activation, pause, and revocation.

Store credential hashes, never recoverable plaintext. A restricted or failed installation cannot claim jobs. Revocation invalidates credentials and sessions, prevents new claims, and fences current ownership.

## C3. Job admission and atomic claims

Restore guarded job creation behind an explicit feature gate. Preserve upload verification, usage reservation, limits, account state, request idempotency, immutable recipe snapshots, and existing public status/error behavior.

Implement one-at-a-time, capability-matched atomic claims. A lost response retried with the same request ID returns the same claim. Enforce one active attempt per logical slot and one accepted owner at a time.

## C4. Leases, cancellation, retry and recovery

Use backend-time conditional updates for lease renewal. Match job, attempt, machine, session, slot, and incarnation; never revive an expired attempt. Cap renewal at the overall processing deadline.

Add an idempotent recovery scanner that cannot reset a concurrently renewed attempt. Requeue only eligible transient failures with bounded backoff/attempts. Cancellation, deletion, session replacement, and revocation fence late renewal and finalization.

## C5. Exact-version S3 grants and finalization

Issue narrow, attempt-scoped grants for the exact input and output object. Require signed headers/checksums. Before completion, verify the immutable S3 version, key, size, checksum, media type, current ownership, lease, and recipe result.

Finalize job state, usage, notifications, slot release, and cleanup idempotently. An uploaded stale result is never published and is scheduled for safe cleanup.

## C6. Minimal machine status and policy APIs

Provide the APIs needed for D and E: machine/session/slot state, invitation lifecycle, drain/pause/resume/revoke, current job, recent bounded diagnostics, validated runtime identity, typed doctor/benchmark requests, and versioned recipe/capacity policy revisions.

Correctness must not depend on WebSocket or Redis delivery. Durable claims and HTTPS reconciliation remain authoritative. Add only the bounded transient hints, presence, heartbeat, progress, and diagnostic transport required by the accepted architecture. Automatic update orchestration is post-MVP.

**Exit:** backend verification plus concurrency, authorization, idempotency, S3, and recovery tests; reviewed PR into the collection branch. No real worker service, dashboard, deployment, or production mutation.
