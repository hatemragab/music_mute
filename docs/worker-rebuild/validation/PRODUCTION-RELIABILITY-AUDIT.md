# Worker/CLI production reliability audit — 2026-09-25

Branch: `hatem/worker-production-reliability`. Base: `c95672f41bbb13cd5a91850e1b6794fc33fd8e0f`
(PR #29 merged). Changes in this report are local and uncommitted. No publication,
service restart, activation, cloud mutation, capacity increase or GPU benchmark
was performed. OS sandbox implementation remains explicitly deferred.

## Verdict and proof boundaries

Recoverable transfer, reporting, resource and child failures have concrete local
fixes and regression coverage. This is **not production release acceptance**.
Abrupt parent death, interrupted installation/update, capacity evidence and
remote diagnostic delivery retain the open gates below.

The reported four-minute partial download incident is historical context. Its
exact network cause remains unconfirmed. PR #29's download idle watchdog is in
this base; unrelated accumulated Python warnings are not evidence of a crash.

Read-only `mw status --local --json` during this audit returned exit 0:
installed `0.1.0-mvp.43-local.20260925`, active lifecycle, running LaunchAgent,
healthy local state, model/local ready, no readiness blockers. The local command
returned `claimEligible: null`: this does **not** verify live backend eligibility,
a completed job, S3 publication, or Sentry ingestion. No configuration values,
signed URLs, job media, identifiers from live jobs, or log dumps are retained here.
The installed bundle was not changed. The task handoff says it contains a narrow
transfer patch over .42; this audit does not equate it with the worktree build.

## Ranked findings

Line references are relative to the repository and describe this working tree.
`FIXED_LOCAL` means implemented with isolated tests, not installed or released.
`OPEN` means source evidence or a missing acceptance guarantee remains.

| ID / priority / status                 | Source evidence                                                                                                                                                                             | Reproduction and operational impact                                                                                                                                                                                           | Change or remaining gate                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 / P1 / FIXED_LOCAL                  | `worker/src/runtime/worker-runtime.ts:419`; `control-plane-client.ts:447`                                                                                                                   | Exhaust a retryable config/claim request. Previously `run()` exited immediately and stopped other work.                                                                                                                       | Up to three reconciliation rounds, 1s/2s abortable backoff, preserving pending claim identity. Auth, ownership and protocol failures remain fatal. Existing HTTP client retries remain bounded separately. Exhaustion exits honestly; it does not pretend availability.                                                                                                                                                                        |
| R2 / P1 / FIXED_LOCAL                  | `worker/src/runtime/transfers.ts:179`                                                                                                                                                       | PUT sink stops reading, or reads the body but never returns headers. Previously only the two-hour total budget applied.                                                                                                       | Default 30s upload inactivity bound, reset by nonempty body consumption, plus existing total/ownership cancellation. Abort destroys the file stream; response bodies are cancelled. Final-chunk checksum verification and exact S3 version requirement remain. Real loopback tests cover stalled sink, missing headers, total timeout, cancellation and success.                                                                               |
| R3 / P1 / FIXED_LOCAL                  | `worker/src/runtime/worker-runtime.ts:928`, `:1200`                                                                                                                                         | One disk/memory gate rejection previously put the slot in `unavailable` forever.                                                                                                                                              | Remember the rejected input size; re-probe no sooner than 30s at reconciliation. Clear only the resource blocker after the gate passes. Cleanup and exhausted-child blockers remain independent. No repeated job attempt is created by the probe.                                                                                                                                                                                              |
| R4 / P1 / FIXED_LOCAL                  | `worker/src/runtime/worker-runtime.ts:989`                                                                                                                                                  | Download fails, then `/fail` acknowledgement is lost. Previously the second error escaped and the original terminal diagnostic disappeared.                                                                                   | Emit correlated `failure-report-deferred` and original `attempt-failed`, stop renewing, clean up and free local occupancy. Backend lease recovery remains authoritative; no synthetic acknowledgement or unsafe ownership reuse. A following fixture attempt completes.                                                                                                                                                                        |
| R5 / P1 / FIXED_LOCAL                  | `worker/src/runtime/worker-runtime.ts:1017`                                                                                                                                                 | Child exits; workspace cleanup rejects. Previously cleanup skipped the restart branch.                                                                                                                                        | Preserve the failed workspace, block admission, emit `workspace-cleanup-failed`, and still recover the child. Do not classify an unsafe or undeletable workspace as healthy. Operator inspection/restart is required for this blocker.                                                                                                                                                                                                         |
| R6 / P1 / FIXED_LOCAL                  | `worker/src/runtime/worker-runtime.ts:828`, `:1218`; `engine/musicmute_engine/pipeline.py:311`                                                                                              | Explicit `GPU_OOM` was a normal child error, retaining possibly damaged provider state; repeated child startup errors retried forever.                                                                                        | Terminate/recreate the OOM child. After an initial restart failure, allow three recovery attempts with 5s initial delay then 30s/60s backoff (reconciliation can delay further). Exhaustion retains unavailable state and emits `child-recovery-exhausted`. Mocked OOM followed by a successful job and repeated failed restart tests pass. No actual GPU OOM was induced.                                                                     |
| R7 / P1 / OPEN                         | `worker/src/agent/child-process.ts:103`, `:360`; `engine/musicmute_engine/child.py:93`, `:139`                                                                                              | Kill the Node supervisor abruptly during synchronous Python inference. Python is in a detached process group; Node cannot execute its group-kill code after SIGKILL, and Python reads pipe EOF only after processing returns. | Existing tests prove timeout/forced termination **by a living supervisor**, not abrupt-parent-death cleanup. Add an independently enforced parent-liveness mechanism and adversarial parent-death/descendant test before claiming this guarantee. Native code holding the GIL must be considered. Do not perform this experiment against the live worker.                                                                                      |
| R8 / P1 / OPEN                         | `worker/src/platform/macos/user-benchmark.ts:1062`, `:1128`; `runtime/runtime-config.ts:181`                                                                                                | Retain an old PASS receipt, then fail a capacity rerun; or point a valid receipt at a different installed release.                                                                                                            | Failed rerun does not invalidate the old receipt. Loader checks digest syntax, machine ID and expiry, but does not bind digests to active release/model/fixture. One baseline/pair and startup-inclusive short-fixture timing do not prove sustained two-worker capacity. Keep one slot. Receipt invalidation, installed identity binding, sustained resource and listening/quality acceptance are prerequisites to authorizing two slots.     |
| R9 / P1 / OPEN                         | `worker/src/runtime/local-lifecycle.ts:71`; `platform/macos/command-lock.ts:33`; `platform/macos/user-updater.ts:274`                                                                       | Interrupt a lifecycle writer while its lock exists; terminate updater after draining/stopping but before its rollback `try`, or at an activation journal boundary.                                                            | Outer command lock has PID-based stale recovery; lifecycle lock has none. Updater's pre-try drain/stop/state writes can leave a stopped/draining worker. In-process rollback is not crash recovery. Require transaction-boundary interruption tests, safe stale-lock recovery and startup journal reconciliation. Never remove a lock merely because a command is slow.                                                                        |
| R10 / P2 / FIXED_LOCAL + OPEN DELIVERY | `worker/src/observability/sentry.ts:165`; `worker/src/cli/main.ts:231`; `runtime/diagnostic-spool.ts:221`; `backend/src/worker-fleet/telemetry/worker-runtime-diagnostics.controller.ts:14` | Handled job failures were only local; CLI Sentry capture was reached by top-level runtime errors. Backend has a log endpoint, but the runtime spool/client contain no batch forwarding path.                                  | Handled attempt, child-unavailable and cleanup failures now enter Sentry with allowlisted event/code/stage and UUID correlation. SDK/privacy-filter and SDK-failure tests pass. Reporting is asynchronous and cannot block recovery. Local spool remains durable evidence. Live Sentry receipt, alert visibility, and backend/S3 archival remain NOT_RUN/unimplemented client transport; do not claim remote log delivery from local spooling. |
| R11 / P2 / FIXED_LOCAL                 | `worker/src/runtime/worker-runtime.ts:390`, `:544`, `:1375`                                                                                                                                 | Already-aborted run starts unnecessarily; concurrent stop calls repeat teardown; an observer exception interrupts recovery.                                                                                                   | Pre-cancelled run does not start. Concurrent stops share one promise; hint shutdown failure still stops children. Observer exceptions cannot escape. Unexpected diagnostic-record failure blocks new claims without disrupting cleanup and is reflected in status. Existing spool I/O failures retain their fail-closed policy.                                                                                                                |
| R12 / P2 / FIXED_LOCAL                 | `worker/src/runtime/control-plane-client.ts:598`; `worker/scripts/run-engine-tests.mjs:19`; `engine/tests/test_child_output.py:29`                                                          | Each successful retry delay retained an abort listener; test entry/subprocess relied on inherited Python environment flags.                                                                                                   | Remove retry listener when delay completes. Explicit `-B` in Python test entry and remaining Python test subprocess; filtered environments cannot enable bytecode writes there. Existing security tests already pass `-B`. No existing runtime cache was deleted.                                                                                                                                                                              |
| R13 / P2 / OPEN                        | `worker/src/runtime/transfers.ts:137`, `:214`; `runtime/workspace.ts:73`; `runtime/resource-limits.ts:26`; `enrollment/artifact-download.ts:187`                                            | A filesystem write, sync, stat or close never settles. Network AbortSignal cannot interrupt those kernel operations.                                                                                                          | Network tests do not prove bounded filesystem recovery. Avoid racing a write and unlinking its path while I/O still owns the handle. A stronger process-isolated I/O/cancellation design and fault-injection evidence are required for a hard end-to-end deadline guarantee.                                                                                                                                                                   |
| R14 / P2 / OPEN                        | `worker/src/enrollment/artifact-download.ts:269`; `enrollment/qualification-upload.ts:74`                                                                                                   | Installer/model download or qualification PUT stalls.                                                                                                                                                                         | These separate transfer paths retain 10-minute default timeouts rather than job-transfer inactivity bounds; artifact redirects get fresh timeouts. Artifact writer also ignores a short `FileHandle.write()` result. Integrity activation checks mitigate corruption, but recoverability/latency still needs focused tests and fixes.                                                                                                          |
| R15 / P2 / OPEN                        | `worker/src/platform/macos/launch-agent.ts:119`, `:158`; `platform/windows/service-definition.ts:99`; `runtime/worker-runtime.ts:341`                                                       | Persistent startup/provider/auth failure causes repeated service launches; idle child dies between jobs.                                                                                                                      | launchd throttles failed exits to 10s but has no persistent circuit breaker here. Initial child startup has a five-minute bound; idle child failure is recovered when processing next fails, rather than proactive liveness observation. Bounded in-process retry does not prove bounded lifetime restart count. Require restart/quarantine policy and native OS acceptance.                                                                   |

## Coverage of unchanged authority and lifecycle behavior

- **Backend ownership and retry limits — SOURCE_INSPECTED:**
  `backend/src/worker-fleet/claims/worker-claim.service.ts:224` checks request replay,
  session identity, idle slot and eligible attempt budget before transactional claim.
  `leases/worker-lease.service.ts:69` validates machine/session/incarnation and exact
  job/attempt ownership and caps renewal at deadline. `leases/worker-recovery.service.ts:26`
  fences expired attempts and decrements retry budget transactionally before releasing
  the matching slot. `leases/worker-recovery-maintenance.service.ts:23` runs only when
  processing is enabled, at 10s intervals, at most 100 recoveries per pass.
  `attempts/worker-attempt.service.ts:288`, `:394`, `:643` handle completion, failure and
  matching-slot release. Backend database/S3 integration was not executed in this audit.
- **Publication ambiguity:** output-grant reconciliation checks an already-published
  exact object before retrying PUT. At most three upload attempts; completion uncertainty
  does not get converted into a conflicting failure. Existing worker tests retain this
  behavior. A lost `/fail` response can leave the _backend_ slot occupied until lease
  recovery; clearing local busy state is not proof of immediate backend availability.
- **Pause/drain/stop/resume:** local lifecycle intent and backend claim permission remain
  mandatory admission checks. Local pause/drain block new claims without forcibly killing
  healthy active work; stop uses the existing CLI drain boundary. Recovery does not write
  lifecycle intent or raise capacity. Backend revocation stops lease authority. Fixture
  tests are not native sleep/logout/reboot acceptance.
- **Sleep/wake/offline:** `runtime/lease-authority.ts:93` uses the greater of wall and
  monotonic elapsed time, plus the safety margin; an expired deadline cannot be extended
  by reconnecting. Hint transport remains advisory with HTTPS fallback. No host sleep,
  network disconnection or server configuration was induced.
- **Windows:** shared runtime fixtures and Windows config/package tests execute on macOS.
  `agent/child-process.ts:360` kills only the direct child on Windows; Job Object process
  tree ownership and native DirectML/LocalService/reboot proof remain NOT_RUN.
- **Integrity and installation:** existing immutable staging, signed update metadata,
  content-addressed owner-source model handling and rollback tests remain in force.
  No test modifies the installed release or repoints `runtime/current`. Updater recovery
  claims are limited by R9; source tests cannot establish real launchd rollback health.
- **Performance and media:** no separator, recipe, trimming or encoder implementation was
  changed. WAV trim then final MP3-only publication, -32 dBFS threshold, 0.6s minimum gap,
  0.2s padding and existing cleanup policy remain. Upload remains streaming and checksum
  verified; no second full-file hash pass was introduced.

## Validation record

Host: macOS ARM64, Node 24.18.0, pnpm 10.14.0. Synthetic input only.

| Command / experiment                                                                                     | Result and scope                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir worker install --frozen-lockfile`                                                            | PASS; worktree dependencies only. Optional Sentry CLI build script was not approved/run.                                                                                                                |
| Focused Vitest runtime, transfer, child, supervisor and telemetry runs                                   | PASS; real loopback HTTP transfer stalls plus fake control-plane/child failures. Subsequent-attempt completion, recovery exhaustion, resource re-probe, cleanup blocker and privacy filtering asserted. |
| `pnpm --dir worker exec vitest run --maxWorkers=2`                                                       | PASS: 300 tests, 2 platform-specific skips (56 passed files, 1 skipped).                                                                                                                                |
| `pnpm --dir worker typecheck`, `lint`, `build`, `protocol:check`                                         | PASS.                                                                                                                                                                                                   |
| `pnpm --dir worker test:engine` with installed Python, explicit `-B`, temporary caches, installed FFmpeg | FAIL: 69 tests ran, two subcases could not generate OGG/WebM fixtures because packaged FFmpeg has no `libopus` encoder. This is fixture-generation evidence, not proof its decoders fail.               |
| Same engine suite with installed Python and development FFmpeg                                           | PASS: all 69 tests. No GPU benchmark or actual separation acceptance.                                                                                                                                   |
| Initial unconstrained TypeScript run                                                                     | FAIL: new test deep-compared a 20 MB Buffer and exhausted a Vitest process. Assertion now compares SHA-256; bounded two-worker test run passes. No heap-limit increase or production process mutation.  |
| `pnpm --dir worker format:check`                                                                         | FAIL only on unchanged `pnpm-lock.yaml`; the same check against the HEAD version also fails. Changed-file formatting passes; unrelated lockfile preserved.                                              |
| Live `mw status --local --json`                                                                          | PASS local readiness only, installed .43; no backend/S3/Sentry delivery acceptance.                                                                                                                     |
| Native Windows, real OOM, abrupt supervisor death, sleep/wake, reboot/logout, live S3 and live Sentry    | NOT_RUN.                                                                                                                                                                                                |

The test-runtime Python runs use `-B` and temporary Matplotlib/Numba/XDG cache
locations. Native FFmpeg fixture generation does not load the production model.

## Operator interpretation and release gates

1. `transfer-failed` + `attempt-failed`: inspect the attempt/stage and idle versus total
   timeout code. Retry belongs to existing backend attempt limits; do not loop a job
   indefinitely or reuse an expired signed grant.
2. `failure-report-deferred`: terminal acknowledgement is uncertain. Verify backend
   lease recovery and final job state; do not announce a successful terminal update.
3. `resource-blocked`: restore disk/memory capacity. The same gate is rechecked after
   cooldown; policy and local pause/drain still control admission.
4. `workspace-cleanup-failed` or `child-recovery-exhausted`: admission stays blocked.
   Inspect private local diagnostics, resolve the cause, then use the authorized
   lifecycle workflow. Do not delete arbitrary workspaces or bypass integrity checks.
5. Before activation: package the complete candidate, verify immutable manifests and
   one-slot readiness, run a rights-cleared end-to-end job and cancellation/lease-loss
   recovery, verify exact-version S3 result/cleanup and actual Sentry correlation, and
   schedule OS-specific interruption tests. Activation/publication requires separate
   authorization. Keep two-worker capacity disabled until R8 is closed.
6. Local spooling is not remote archival; rate-limited best-effort Sentry is not a
   durable delivery receipt. Add and prove the backend diagnostic uploader before
   promising fleet-wide searchable history.
