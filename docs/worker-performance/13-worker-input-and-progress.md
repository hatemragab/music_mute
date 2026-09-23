# 13 — Improve worker input transfer and expose real processing progress

**Status:** Local worker/backend progress contract and isolated API flow verified;
real network-transfer improvement and mobile display remain unmeasured.
**Depends on:** 12 and telemetry contracts 02–06.
Read [shared rules](EXECUTION-RULES.md) and [validation](VALIDATION.md).

## Objective and sources

Preserve the uploaded source quality while reducing measured worker input and
output transfer delays. Carry actual worker processing stages through the
authenticated backend contract so a future mobile task can display trustworthy
progress. Own worker and backend code only. Read worker download, verification,
engine invocation, progress, upload and completion paths, plus backend job and
attempt presenters and existing progress/hint flows. Inspect mobile contracts
read-only where necessary to describe the future integration.

## Required work

1. Trace and measure the worker's input download, validation, decode, separation,
   final encoding, result upload and completion acknowledgement. Compare their
   contribution to full job latency with task 08 engine timings when available.
2. Preserve upload/source quality. The 192 kbps setting applies only to the final
   vocal MP3. Validate input identity, size, checksum, cancellation and cleanup.
3. Keep retries and process restarts idempotent. Avoid duplicate download or
   upload only when safe identity and completion evidence support reuse.
4. Transport actual current-attempt progress with authenticated bounded updates.
   Reuse existing transport/reconciliation where appropriate, preserve job authority,
   and update backend/worker contracts together. Do not introduce migrations or a
   compatibility shim. Do not expose internal diagnostic details in public APIs.
5. Expose stage labels and real percentage when total windows/audio duration is
   known. Use indeterminate progress otherwise. Separate preparing, separating and
   saving result; distinguish stale updates from known failure. Never report 100%
   before durable result readiness. Handle retries with new attempts without stale
   regression.
6. Bound progress network updates and survive reconnect, cancellation and process
   restart. Keep CLI and backend stages consistent through task 02 semantics.

## Validation and acceptance

Run focused worker and isolated local API contract/integration tests for transfer
timing, retries, progress authorization, attempt reconciliation, cancellation,
and completion. Do not run Android or iOS builds, tests, or device flows.

## Handoff

Provide transfer timing comparisons, contract changes, automated test evidence,
and a short handoff describing what mobile clients could display in a later
separate task. Hand task 15 the complete local worker/backend integration
scenario. Do not claim the screenshot's mobile UI has changed.

## Local result — 2026-09-23

The worker already records per-attempt input download, result upload and
completion-acknowledgement durations in its sanitized local performance event.
Its source transfer still verifies the pinned object version, exact byte count
and SHA-256 before processing. Result publication retains the existing
reservation/version idempotency checks. No download cache or upload bypass was
added: the full-song GPU benchmark measures engine time, while the isolated API
fixture measures local HTTP/storage behavior and cannot establish a production
network bottleneck. The 192 kbps result is 40.0% smaller for the provided song,
but its real upload-time saving has not been measured.

The Python separator now emits completed/total inference windows, including
grouped calls and final partial groups. The child forwards those counts through
the existing validated IPC channel. The worker maps actual work to `preparing`,
`separating` and `saving-result`, sends at most one authenticated progress
request at a time, coalesces intermediate updates and normally waits at least
two seconds between requests. Temporary send failures retry the latest value;
progress failures do not block audio processing. Separation percentage is capped
at 99 until the backend has durably completed the result. Stages without a safe
denominator are indeterminate (`phasePercent: null`).

The backend `POST /worker/v1/attempts/:id/progress` checks the machine
credential, worker, session, incarnation, lease and current attempt. It accepts
monotonically increasing sequence numbers and rejects another worker. The public
job detail exposes only `processingProgress` with phase, optional percentage,
observation time and a stale flag after 30 seconds. A new claim resets the
snapshot; completion, failure and cancellation cannot show an old attempt's
progress. This is a direct local contract update without a migration.

The isolated backend/worker integration test passed with local object storage:
claim, upload, completion and result readiness; a current worker's progress
update and replay; wrong-worker rejection; public detail presentation; and
progress disappearance on cancellation. Focused progress reporter, runtime,
backend attempt/presenter and Python child/separator tests also passed. The
local fixture uses a simulated child and its transfer timing is not a live S3
or real GPU job measurement. Task 15 must run the final real-GPU scenario.

Android was inspected read-only. A later mobile task can map the three public
phases to the existing progress timeline, show percentage only when present,
and use `stale` to avoid presenting frozen progress as live. The current Android
app still does not display this new field. No Android or iOS code/build/device
flow was changed.
