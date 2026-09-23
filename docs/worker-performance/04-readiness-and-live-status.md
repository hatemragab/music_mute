# 04 — Build accurate CLI readiness checks and live status monitoring

**Status:** Implemented locally; installed-service proof pending. **Depends on:** 01–03.
Read [shared rules](EXECUTION-RULES.md) and [validation](VALIDATION.md).

## Objective and sources

Make `status` explain whether work can proceed and why. Provide both immediate
local inspection and a live view without restarting anything or repeatedly running
heavy Doctor checks. Own status/readiness rendering and the required runtime snapshot.

Read `worker/src/platform/macos/user-cli.ts`, `user-health.ts`, `launch-agent.ts`,
`runtime/local-runtime-status.ts`, `local-lifecycle.ts`, `worker-runtime.ts`,
`control-plane-client.ts`, and the new task 02/03 interfaces.

## Required work

1. Distinguish stopped, starting, loading, warming, ready, processing, draining,
   paused, recovering, and failed using actual events. Show model/provider identity,
   active job/attempt, stage elapsed time, observed progress and last-progress age.
2. Calculate readiness from fresh current-session runtime evidence, child state,
   service state, local intent, backend policy, capacity, and diagnostic/resource
   health. Return explicit blockers; do not equate a running PID with ready.
3. Add `status --local` for immediate no-network results and `status --watch` for
   bounded refresh. Fetch remote policy with a bounded timeout; label cached data
   with its age and show unknown when not available. Do not call it connected from
   an old successful snapshot.
4. Add optional `start --wait-ready` with a documented timeout and stage updates.
   Distinguish locally model-ready from remotely eligible to claim. Waiting must
   not restart the service, override a pause, or invent success after timeout.
5. Provide readable TTY output, stable JSON snapshots, and newline-delimited JSON
   streaming where appropriate. SIGINT stops the viewer only. Non-TTY output must
   not contain cursor-control noise. Bound polling and show unsupported metrics.
6. Detect stale heartbeat and stale progress separately. Show a warning based on
   evidence; do not automatically kill a long song because an estimate was wrong.
   Detailed GPU telemetry must be optional if collection is costly or unavailable.

## Validation and acceptance

Use fake clocks/service/backend responses to cover fresh and stale status, wrong
incarnation, child warming/failure, backend down/paused/revoked, local drain, full
capacity, and diagnostic write failure. Test wait-ready success/timeout, non-TTY,
JSON output, and interruption. Verify watch never mutates lifecycle and local status
makes no backend call. Record actual timing for CLI response in a local check;
do not assert a responsiveness claim solely from mocks.

## Handoff

Publish command help/examples, snapshot schema and blocker glossary. Provide tasks
05–07 with reusable readers and task 08 with instrumentation overhead to measure.

## Implementation evidence (local worktree)

- The child emits actual `loading` and `warming` startup stages before `ready`.
  The runtime snapshot includes session/incarnation/PID, GPU slots/provider,
  cached backend policy with observation time, diagnostic storage state, and
  active attempt stage and observed window count. Snapshot writes for repeated
  window progress are throttled to five seconds; stage changes and the first
  observed count publish promptly.
- `status --local` makes no backend call. `status --watch` refreshes every two
  seconds, supports JSON lines, and only reads state. The normal status fetch
  has a 2.5-second backend timeout. `start --wait-ready` waits up to six
  minutes for **local model readiness**, reports phase transitions, then checks
  remote eligibility once. A running PID alone is not accepted as ready.
- JSON status schema is version 2. `readiness` reports `phase`, `modelReady`,
  `localReady`, nullable `claimEligible`, blockers, heartbeat age, and a
  separate stale-progress warning. Cached policy is informational and carries
  `cachedPolicyAgeMs`. GPU memory is `null` with `not-sampled` until explicit
  telemetry exists. No progress estimate kills a long-running job.
- Focused tests cover active progress, wrong PID, stale heartbeat, local-only
  no-network status, pause, full capacity, diagnostic blockage, watch
  interruption, and wait-ready success/timeout. A read-only candidate CLI
  `status --local --json` against the existing user installation took 80 ms,
  exited 1 with phase `starting` because the installed worker has not emitted
  this candidate snapshot format, and made no backend status request. This is
  CLI response proof, not runtime deployment or ready-state proof.

### Blocker glossary

- `runtime-heartbeat-stale` and `runtime-process-mismatch`: local snapshot
  cannot prove the current service is live; inspect `doctor` and the service.
- `model-loading`, `model-warming`, `child-unavailable`: child is not ready;
  inspect startup/recovery events if it persists.
- `local-paused`, `local-draining`, `backend-paused`, `backend-draining`,
  `backend-claims-disabled`: effective policy currently prevents claims.
- `capacity-full`: all configured GPU slots have active jobs. This is expected
  while the one allowed job is processing.
- `diagnostics-*`: local history storage blocked admission; inspect the
  marker and disk or permission failure before retrying. `logs --clear` does
  not silently remove the marker.
- `backend-unavailable`: current remote status could not be fetched;
  `claimEligible` is unknown, even when cached policy was previously active.
