# Branch 6: codex/worker-integration

**Parent:** accepted `codex/worker-dashboard` synchronized to collection. **PR base:** `codex/worker-rebuild`. **Checkpoints:** F1–F6.

## Assignment

Integrate the accepted control plane, runtime, platform services, dashboard, mobile-compatible job flow, and S3 behavior. This branch proves the system; it does not add unrelated features or silently widen platform support.

## F1. Complete app/API/S3/worker flow

Run authenticated upload, verification, queued admission, capability-matched claim, exact input download, real processing, output upload, conditional completion, usage, notification, history/detail, and result download. Preserve public error/status behavior and account boundaries.

## F2. Ownership and concurrent recovery

Race machines/slots for claims and prove one accepted owner at a time. Inject lost responses, child/supervisor/backend failures, lease expiry, stale renewals/completions, session replacement, and bounded retry. Verify stale outputs never publish.

## F3. Cancellation, deletion and policy races

Race cancellation and account deletion with inference, upload, and finalization. Verify cleanup, notifications, usage, slot release, and immutable recipe behavior remain correct.

## F4. Real platform service behavior

On every platform accepted in B, run the release candidate from its actual background service context. Prove logged-out operation, restart recovery, GPU execution, S3 flow, and diagnostics. Distinguish service restart from an authorized reboot test.

## F5. Security and resilience

Exercise expired/replayed invitations, revoked credentials, wrong-machine IDs, forged attempts, grant misuse, malformed frames/media, oversized payloads, archive/path attacks, log injection, Redis/WebSocket absence if present, and backend restart.

## F6. Evidence reconciliation

Collect A–F checkpoint results as `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`, or `SIMULATED`. Resolve implementation/documentation mismatches and report unsupported platforms honestly. Passing fixtures do not certify untested GPU hardware.

**Exit:** complete integration evidence and reviewed PR. No production deployment, automatic updater rollout, or merge to `main`.
