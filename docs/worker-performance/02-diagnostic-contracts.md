# 02 — Define diagnostic events, error codes, progress, and timing contracts

**Status:** Implemented locally; worker verification and isolated integration
passed. **Depends on:** 01.
Read [shared rules](EXECUTION-RULES.md) and [validation](VALIDATION.md).

## Problem and ownership

The child emits progress that the parent discards; successful stage timings reach
completion but are not a unified local job investigation record. Define a single
contract for events, live snapshots, and errors. Own its producers and validators
across Python, TypeScript, and affected backend consumers.

Read `worker/src/agent/child-process.ts`, `agent/ipc/child-protocol.ts`,
`runtime/worker-runtime.ts`, `runtime/local-runtime-status.ts`,
`engine/musicmute_engine/child.py`, `ipc.py`, `pipeline.py`, `media.py`, and
`backend/src/worker-fleet/protocol/v1/protocol.ts` plus telemetry DTOs. Use the
[source map](SOURCE-MAP.md) to find consumers.

## Required work

1. Specify schema version, event kind, severity, UTC timestamp, sequence, component,
   session/child incarnation, job ID, attempt ID, worker ID, stage, and safe error
   code. Define which fields are required for each event instead of an untyped bag.
2. Define startup, load, warm-up, input download/verification, decode/preparation,
   separation, encode, upload, and completion boundaries. Monotonic durations must
   have clear units and scope; overlapping stages must not be added as wall time.
3. Expose observed window/audio progress and last-progress time. Keep process
   heartbeat distinct. Unknown totals remain unknown; no simulated percentage.
4. Consume progress only for the matching request/incarnation and current attempt.
   Bound payloads/rates and handle duplicate, stale, out-of-order, and malformed
   messages. Do not change leases or completion authority through telemetry.
5. Define failure fields: code, stage, sanitized detail, observed cause, retryability,
   retry count, recovery outcome, and diagnostic next step. Generic timeouts cannot
   imply OOM. Preserve meaningful details through child errors and parent wrapping.
6. Define safe media metadata and runtime identity for comparisons. Exclude paths,
   URLs, tokens, user content, transcripts, and audio. Use allowlists and bounds.
7. Update canonical contracts and generated copies together; run the existing
   protocol sync/check. Update affected consumers directly, without migrations or
   backward compatibility shims. Storage policy belongs to 03; UI reporting to 04–06.

## Validation and acceptance

Test a successful job, failed stage, retry, cancellation, child restart, stale
progress, malformed frame, missing timestamps, and unknown fields. Exercise
sanitization with credentials, signed URLs, and multiline errors. Verify progress
does not complete a pending request or reset ownership deadlines. Provide a compact
example event stream and field dictionary, explicitly using synthetic IDs/data.

## Handoff

Document the contract, stage definitions, rate/coalescing decisions and affected
consumers. Tasks 03–06 and 13 must use these types rather than inventing new labels.

## Implementation evidence (local worktree)

- `worker/src/agent/ipc/child-progress.ts` validates stage-only and observed
  window progress. `worker/src/agent/child-process.ts` filters stale, duplicate,
  out-of-order, malformed, and wrong-request progress without resolving the job.
- `worker/engine/musicmute_engine/pipeline.py` and `child.py` emit actual stage
  boundaries instead of fabricated fractions. The runtime now emits versioned,
  timestamped, sequenced, typed attempt events with safe failure stage and
  known/unknown retryability. See [contract](DIAGNOSTIC-CONTRACT.md).
- Focused Vitest child/runtime suites: 19 tests passed. Focused Python pipeline
  suite using the existing main-checkout virtual environment: 4 tests passed.
  The full Python suite initially lacked `torch` for a unit mock. The test now
  supplies a fake torch module for that isolated warm-up check; all 42 Python
  engine tests pass using the existing virtual environment. This is unit
  validation, not GPU inference performance proof.
- Storage allowlisting/coalescing belongs to 03; CLI recovery guidance to 05;
  transfer timings to 06; real per-window GPU progress to 10; backend transport
  to 13. No Android or iOS code was changed.
