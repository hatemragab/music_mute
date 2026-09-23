# Local worker diagnostic contract (v2)

This is the worker's local runtime event contract. It does not change the
backend's public job status or the mobile clients. The `RuntimeEvent` union in
`worker/src/runtime/worker-runtime.ts` is the source type; task 03 governs
retention and task 13 governs backend progress transport.

## Envelope and identity

Every event has `schemaVersion: 2`, UTC `recordedAt` (ISO 8601), a sequence
increasing within one runtime process, opaque `sessionId` and `incarnation`
UUIDs, `component: worker-runtime`, `severity`, and `kind`. Attempt events
require `workerId`, `jobId`, and `attemptId`. A child recovery event requires
`workerId`; a failed child can have attempt IDs when it failed during a job.
Command events require a safe code and opaque command ID in `detail`.

`attempt-progress` requires `stage`. It may carry `work` only when the child
observes a real completed and total count. `work.unit` is currently `windows`.
No total or percentage is inferred from the stage or elapsed time. The event's
`recordedAt` is the last observed progress time for that event. It is distinct
from the worker heartbeat and lease renewal. A progress event has no authority
to extend a deadline or complete a job.

`attempt-succeeded` requires validated `stageTimings`, each with a stable stage
name and `durationMs`. Python measures each completed processing stage with a
monotonic clock; its result seconds are converted to milliseconds by the
TypeScript result validator. These are durations of separate operations, not
an additive wall time. Task 06 will add end-to-end transfer and queue timing.
`attempt-failed` requires the public safe `code`, last observed `stage`, and
`retryable`: `true` or `false` only when the transfer classified it; otherwise
`null` means unknown. `attempt-stopped` records a safe reason and last stage.
The backend remains the authority for actual retry and ownership decisions.

## Stages

Worker stages: `resource-check`, `input-download`, `output-upload`,
`completion`. Python child stages in order: `input-validation`, `preparation`,
`model-load`, `separation`, optional `denoise`, optional `trim`, `encoding`,
`output-validation`, `output-ready`. A stage event means the operation began.
Some stages may be absent when the recipe disables an operation or processing
fails earlier. Window counts are optional until task 10 instruments the
qualified GPU inference loop; an unknown total stays unknown.

The child emits progress only for its current request and incarnation. The
parent rejects unknown fields, invalid counts, duplicate or older stages, and
stale request IDs. A malformed structural IPC frame fails the child protocol;
an invalid but structurally valid progress payload is ignored. Progress does
not resolve the process request or change its timeout.

## Privacy

Events contain opaque IDs, enum stage/code values, bounded timings, and
sanitized diagnostic text. Normal records must not contain source filenames,
paths, URLs, credentials, signed grants, transcripts, or audio. Task 03 will
apply storage allowlists, redaction, and quotas. Task 05 will add CLI guidance
for observed causes, recovery results, and next steps without turning a
generic timeout into an unsupported OOM claim.

## Synthetic example

These IDs and times are synthetic; the example omits the common envelope
fields other than `kind`, `sequence`, and `recordedAt` for readability.

```jsonl
{"kind":"attempt-started","sequence":1,"recordedAt":"2026-01-01T00:00:00.000Z","workerId":"worker-uuid","jobId":"opaque-job-id","attemptId":"attempt-uuid"}
{"kind":"attempt-progress","sequence":2,"recordedAt":"2026-01-01T00:00:01.000Z","stage":"input-download"}
{"kind":"attempt-progress","sequence":3,"recordedAt":"2026-01-01T00:00:08.000Z","stage":"separation"}
{"kind":"attempt-progress","sequence":4,"recordedAt":"2026-01-01T00:00:12.000Z","stage":"separation","work":{"unit":"windows","completed":2,"total":20}}
{"kind":"attempt-succeeded","sequence":5,"recordedAt":"2026-01-01T00:01:00.000Z","stageTimings":[{"stage":"separation","durationMs":42000}]}
```

Every real attempt event also includes the required envelope and attempt IDs.
