# Test and release strategy

> **macOS LaunchAgent update:** the authoritative validation ladder and concrete
> CLI/package/LaunchAgent/CoreML/login-session acceptance matrix for the
> per-user redesign are in
> [08-macos-user-launchagent.md, section 12](08-macos-user-launchagent.md#12-validation-and-acceptance-strategy).
> The evidence categories and shared backend correctness requirements below
> still apply.

## 1. Evidence categories

`PASS`: actually executed check met its assertions. `FAIL`: executed check did not. `NOT_RUN`: not executed. `BLOCKED`: an identified prerequisite prevents it. `SIMULATED`: orchestration behavior verified with a fake engine/service; not GPU/hardware evidence.

Each checkpoint report states command, environment, relevant versions, commit, exit status, assertions and sanitized results. Never infer service/GPU support from a passing TypeScript build, installed provider list, synthetic fixture or another OS.

## 2. Initial test environments

The owner's **Mac mini M4** is the first development and inference host. Use local isolated MongoDB **replica set** and Redis. S3 credentials will be supplied privately in `.local.env` for backend/test harness use only; run-scoped object keys and version-aware cleanup are mandatory.

The **Windows Z440 / RX 580 8 GB** is reached through SSH after the owner supplies target/authentication and trusted host-key details. Test the identical accepted commit and manifest, not an uncommitted ad hoc Windows fork. Never copy `.local.env` or backend AWS credentials to the worker.

Linux CI can test protocol, packaging and rejection fixtures; it cannot establish M4/DirectML/NVIDIA/ROCm performance. NVIDIA and AMD Linux remain release-disabled without actual target evidence. Minimum OS versions and precise runtime pins are recorded after tests, not guessed from model names.

## 3. Layered validation

| Layer | Required examples |
| --- | --- |
| Pure logic | Recipe validation, trimmer parity, error mapping, expiry calculations, revision handling |
| Backend integration | Real isolated Mongo transactions/indexes; claims, slots, renewals, cancellation and retry |
| Transport | Authenticated HTTPS/WSS, reconnect, missing/duplicate hints, payload bounds and rate limits |
| Storage | Real scoped presigned PUT/GET, exact versions/checksums, expiry/refresh, attempt isolation and cleanup |
| Engine | Real Kim inference, valid voice-only output, provider dispatch evidence, repeat-job isolation |
| Host service | Correct service account, no interactive login dependence, restart/reboot/logged-out execution |
| Release lifecycle | Side-by-side candidate, explicit manual activation, verification checks, bad release rollback without backend availability |
| Product | Existing client requests and history/playback/cancel/delete/usage remain compatible |

Fake engines are explicitly test-only and impossible to activate with production registration. A CPU-only mock must never advertise a real validated GPU capability.

## 4. Concurrency and correctness scenarios

Run concurrent claim requests from several machines and slots; assert exactly one **accepted owner at a time** per job, not exactly-once physical computation. Inject a lost claim response and retry the same request ID; it returns the same claim rather than another job. Enforce one active attempt per logical slot even under duplicate requests.

Terminate a child while the supervisor remains healthy, including the narrow
window where an active request rejects before the operating-system exit event
settles. A restart must allocate a fresh lifecycle wrapper and process
incarnation; it must not reuse the terminated wrapper. Stop the supervisor,
block only its backend communication, and restart the backend. Observe bounded
lease expiry and requeue. Reconnect the former worker and attempt
completion/renewal/upload-grant creation; all stale operations are rejected. A
new worker restarts from input, not a fictitious checkpoint. Record a bounded,
redacted child diagnostic before replacement so an unexpected native exit does
not collapse into an unexplained generic separator failure.

Race renewal versus expiry scanning, cancellation versus completion, account deletion versus output publication, and policy change versus claim. Verify preserved usage/outbox idempotency. Test slot generation/session replacement so an orphan child cannot retain ownership.

For deadlines, distinguish an actual hung child from a long supported inference stage. No renewal may extend beyond the overall execution deadline. Test clock skew and process sleep; local monotonic safety stops publishing before authority is uncertain.

## 5. Audio checks

Compare the new trim step against the attached source using the same prepared separated input. Test interior/edge silence, one loud channel, threshold boundary, partial final windows, minimum-duration boundary, all-silent input, clipping/PCM rounding, small regions/fades, multiple gaps, large inputs and invalid numeric settings. Compare sample arrays at the PCM intermediate, not lossy MP3 bytes.

Test all four trim/denoise combinations and policy effects. Denoise off omits the step; trim off preserves pauses. Optional denoise must demonstrably execute and pass controlled noise checks plus owner listening review for clean/noisy speech and singing. A lower overall amplitude alone is not evidence of useful denoise.

A model benchmark reports cold/warm timings and memory with model/recipe/runtime/fixture digests. Measure baseline and concurrent throughput separately. Do not require identical floating-point outputs across GPU backends, and do not invent performance targets from GPU names.

## 6. Security and installation checks

Reject unsupported CPU/Intel/x86 Mac hosts before production activation. Test
missing driver, missing package, corrupted model, bad signature, malformed
archive, insufficient disk, path traversal, environment inheritance,
cross-machine requests and cross-user object access. For direct model
downloads, test the exact owner URL, the allowed provider redirect chain,
redirect loops/limits, an unapproved redirect host, timeout/rate-limit/retry,
wrong content type, oversized/truncated bytes, wrong digest, safe partial-file
cleanup, verified-cache reuse, and proof that no model object is written to or
read from MusicMute S3.

Exercise expiring/replayed enrollment, lost exchange response, idempotent activation and machine revocation. Collect pre-activation success/failure diagnostics; simulate offline upload/reconnect and duplicate batches. Verify no credential or full presigned URL in local/backend logs, errors, process arguments beyond acknowledged one-use enrollment limitations, evidence or archive.

Use a dedicated service account and test after interactive logout. Reboot and cold-boot encryption constraints must be reported honestly. Test interrupted installation, repair, uninstall, repeated install, duplicate-supervisor protection and graceful draining. Do not alter the owner's global runtimes or GPU driver.

## 7. Manual update and rollback checks

On each declared MVP platform, test explicit local package selection, drain behavior, rollback quarantine, and protocol compatibility. Inject candidate import failure, GPU self-test failure, crash loop, disk-full, corrupt download, expired/replayed manifest, and power/process interruption during the pointer switch.

Confirm the independent launcher starts the known-good version even when the candidate agent and backend are both unavailable. A network outage after local startup success must not cause endless version oscillation. Reject automatic retry of a quarantined candidate until explicitly authorized locally.

Automatic target selection, canary promotion, capacity-aware fleet rollout, pause/abort, and remote downgrade policy are post-MVP tests. They do not block the fast MVP.

## 8. Release gates

Both M4 and Z440 must pass actual model, end-to-end S3, service-context, restart/logged-out and rollback tests before the full two-platform MVP is called ready. A missing SSH prerequisite may leave a branch draft; do not turn it into fabricated support.

All new requests remain gated outside the isolated test environment until owner release approval. Preserve existing history and user data. Keep a backwards-compatible backend window for last-known-good workers and an explicit rollback runbook.

Final evidence includes artifact checksums/signature verification, runtime and
license/provenance record, a confidential authorization-record reference for
each model, proof that every model came from its approved owner-hosted URL,
exact tested platform builds, all checkpoints, residual risks, and operator
cutover/recovery commands. A release-readiness PR is not deployment
authorization.

Detailed host procedures are in [Mac/local](../runbooks/MAC-LOCAL-TESTING.md), [Windows/SSH](../runbooks/WINDOWS-SSH-TESTING.md), and [release operations](../runbooks/RELEASE-OPERATIONS.md).
