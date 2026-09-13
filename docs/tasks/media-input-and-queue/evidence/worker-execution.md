# Worker execution review and fixes

2026-09-13; local only. Android implementation owner independently reviewed W01/W02
and fixture changes, then implemented parent-authorized execution fixes. Parent
retained media_limits.py, inspect_audio channel/rate checks, fixture, and packaging
ownership. Backend agent owns executionEvidence DTO/accounting integration.

## Findings addressed

1. `finally: execution.stop()` could persist stopped proof after containment cleanup
   itself failed. The worker now explicitly closes the engine and recovers retained
   containment before recording stopped timing on an exceptional return. If either
   stop verification fails, stopped remains false and no evidence is emitted.
2. Whole engine.run wall time included cold model startup and trim/encode. The child
   now writes bounded, operation-bound separation start/end phase telemetry in the
   unique output directory. Its completed duration is the same separation interval
   returned in the existing timings response; model reset/startup and later trim,
   encode, upload, and queue time are excluded.
3. Normal cancellation during the child separation phase uses the same invocation's
   host monotonic phase start and supervisor-confirmed containment stop. Shutdown
   within that phase is included; this is a measured separation-phase interval, not
   an estimate derived from queue wall time. A running phase is never extrapolated
   across a supervisor restart or unverified stop.
4. Exact child end-phase telemetry can recover after a supervisor crash before
   checkpointing the duration. Its output reference is persisted and confined to
   owned state. Recovery reads only a bounded matching completed phase after
   containment stop is verified, and clears the reference atomically to prevent
   double accumulation. Missing/incomplete data stays unknown rather than zero.
5. Known prior-attempt evidence was lost when reconciliation returned a replacement
   attempt and the verified output was reused. A stable reconcile event ID/evidence
   now survives response loss/restart and is acknowledged durably before replacing
   the clock. Unacknowledged known measurements cannot silently be overwritten.
6. The additive optional `executionEvidence.separationCompleted` flag distinguishes
   completed separation from a partial cancellation. It is true only when the child
   AI call returned normally; a thrown AI failure does not claim completion. This
   lets backend cancellation settlement debit full measured duration after completed
   AI even if cancellation arrives during trim/encoding. Backend owner confirmed
   matching DTO, monotonic storage, replay hashing, and cross-attempt settlement.

The prior clock format measured whole subprocess wall time. Its records remain
loadable but are marked incomplete rather than reinterpreted as trusted separator
measurements. Legacy IPC without phase telemetry remains usable without invented
execution evidence.

## Changed paths

- `windows-worker/musicmute_worker/execution.py`: durable phase measurement, strict
  stop evidence, confined recovery reference, stable reconciliation evidence.
- `windows-worker/musicmute_worker/worker.py`: execution/reconcile integration and
  stop proof. Parent's independent input/media-limit changes remain preserved.
- `backend/separate.py`: separation phase telemetry, including failed-call timing
  without a false completed flag; existing warm/cold protocols remain compatible.
- `windows-worker/tests/test_execution.py`, `test_execution_worker.py`,
  `test_worker.py`, `test_separator.py`: failure, cancellation, recovery, replay,
  timing separation, and telemetry regressions. No GPU/model run was performed.

## Actual validation

New execution regressions first failed RED on unsupported stop/recovery methods,
then passed. Final focused execution/integration run: 14 tests passed.

Formatting passed using the existing tool cache:

```sh
uv tool run --from black black windows-worker/musicmute_worker/execution.py \
  windows-worker/musicmute_worker/worker.py windows-worker/tests/test_execution.py \
  windows-worker/tests/test_execution_worker.py windows-worker/tests/test_worker.py \
  windows-worker/tests/test_separator.py backend/separate.py
```

Final full worker run (including parent's updated package allowlist/test):

```sh
PYTHONPATH=windows-worker uv run --no-project --with numpy --with soundfile \
  python -m unittest discover -s windows-worker/tests
```

Result: **161 tests, OK; 17 platform-gated skips**. The isolated NumPy/soundfile
separator parity/integration suite also passed separately: **11 tests, zero skips**.
Without those optional dependencies the standard Python run passed with 23 skips;
it is not substituted for the expanded-dependency run above.

`python3 -m unittest discover -s tests/media-input`: **4 tests passed**.
`git diff --check -- windows-worker backend/separate.py android
 docs/tasks/media-input-and-queue/evidence/android.md`: passed.

Logs: `/tmp/worker-execution-focused.log`, `/tmp/worker-execution-optional-all.log`,
`/tmp/worker-separator-optional.log`, `/tmp/worker-fixtures-review.log`.

No Windows execution, GPU benchmark, Z440 update, network claim, deployment,
commit, or push was performed by this agent. Abrupt crashes with no completed
phase and failed containment remain unknown/pending; normal observed mid-separation
cancellation now has measured evidence after confirmed stop.
