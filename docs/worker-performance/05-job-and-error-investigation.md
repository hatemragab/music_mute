# 05 — Build job timelines, error investigation, and actionable Doctor reports

**Status:** Implemented locally; final worker gates and CLI walkthrough passed.
**Depends on:** 02–04.
Read [shared rules](EXECUTION-RULES.md) and [validation](VALIDATION.md).

## Objective and ownership

An operator should start with a job ID or error code and understand the failure,
evidence, and next diagnostic action. Own job/error queries, error presentation,
Doctor depth modes, and CLI help. Reuse task 03 history and task 04 status.

Read `worker/src/platform/macos/user-cli.ts`, `user-health.ts`,
`operational-logs.ts`, `worker/src/agent/child-process.ts`,
`worker/engine/musicmute_engine/service_doctor.py`, and existing tests. Trace how
original exceptions become sanitized error codes; avoid replacing useful detail
with only “runtime-doctor failed”.

## Required work

1. Add `job <id>` with all locally known attempts, stage start/end/duration, retries,
   cancellations, child restarts, terminal state, and evidence links/identifiers.
   Distinguish jobs from attempts and mark expired/missing history. Do not imply a
   local machine knows attempts handled elsewhere.
2. Add `errors --since <duration>` with grouping by code/component/stage, occurrence
   counts, first/last seen, affected jobs, and recovery evidence. Support machine
   readable output and a bounded result limit.
3. Add `explain <code>` or an equally clear consistent command. Show definition,
   observed evidence, likely causes explicitly labeled, and concrete diagnostic
   commands. Prefer read-only next steps. Recovery suggestions must state impact;
   do not automatically clear logs, restart jobs, or retry uncertain completion.
4. Give Doctor a lightweight current-runtime check and a thorough integrity/runtime
   check. Keep required integrity validation at installation/activation; do not
   remove security checks merely to make the quick command faster.
5. Return safe structured reasons from failed checks: check name, code, relevant
   evidence, and suggested action. Distinguish not-run, unsupported, warning,
   failed, and passed. Define exit codes and JSON behavior consistently.
6. Preserve existing attempt log filters and reuse the same query implementation.
   Avoid duplicate private information and error-specific ad hoc logging.

## Validation and acceptance

Cover download failure, decode rejection, GPU OOM with positive evidence, generic
timeout, cancellation, child exit, upload failure, backend ownership rejection,
completion uncertainty, and diagnostic-storage failure. Verify grouping counts and
job/attempt joins across segments and retries. Test sanitization and unavailable
history. Quick Doctor must not start another model process or heavy GPU workload.
Human-readable and JSON forms must agree about evidence and outcome.

## Handoff

Provide an error catalogue with synthetic examples and a short troubleshooting
walkthrough from job ID to root-cause evidence. Record which causes still require
runtime profiling and supply task 06 with reusable investigation results.

## Local implementation and operator walkthrough

The macOS CLI now provides `job <job-id>`, `errors --since <duration>
--limit <1-100>`, `explain <code>`, quick `doctor`, and `doctor --full`.
Each accepts `--json`. `job` exits 0 for local evidence and 2 when none is
retained; all other successful queries exit 0. Doctor exits 0 only if every
executed check passes; failed checks exit 1. Argument errors use the existing
CLI error path. No command in this set changes a job or service.

Start with `status --local`, copy the opaque job ID, then run `job <id>`. Read
its attempt number, terminal state, and stage timeline. Use the shown code with
`explain <code>`; use `errors --since 1d` to see whether the failure recurs.
If the stage indicates model loading or separation, run `doctor` first; run
`doctor --full` when a thorough provider/model/runtime integrity check is
needed. Quick Doctor never invokes Python or verifies model weights. Release
activation and worker start preflight still use the full check.

The local error catalogue covers download, invalid/decode audio, GPU OOM,
output upload, completion uncertainty, ownership rejection, child failure,
and diagnostic quota. For example, a `child-failed` event with `GPU_OOM`
requires a PyTorch/provider OOM exception message in its cause chain; a
generic timeout stays unclassified. The backend attempt failure may retain
its broader `SEPARATOR_FAILED` code while local evidence records `GPU_OOM`.
Likely causes are hypotheses; neither `explain` nor `job` proves a particular
network or GPU root cause without supporting runtime evidence.

Attempt timelines and error groups use the same bounded seven-day local event
reader as `logs --events`. The query caps at 10,000 retained events and marks
that limit. `job` reports the attempts seen by this machine only, so retry
counts can be incomplete when another machine owned an attempt or history
expired. Error recovery means a later child restart or success was observed
for the same attempt; it does not mean the backend retried or the output was
accepted. The CLI exposes no credentials, media names, signed URLs, or raw
exception traces. Task 06 should consume these local stage boundaries and
clearly distinguish them from backend queue and completion timings.

Focused validation: macOS investigation tests join attempts across rotated
segments, verify stage durations and error recovery, and test absent history;
quick Doctor tests prove it calls neither the release verifier nor the Python
runtime doctor. Python tests distinguish provider OOM from timeout. Full worker
gates remain for final validation.
