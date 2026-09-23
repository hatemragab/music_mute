# 01 — Fix CLI lifecycle commands to preserve active jobs and warm models

**Status:** Implemented and covered by worker verification; candidate release
installation remains pending. **Depends on:** implementation authorization and
the [shared rules](EXECUTION-RULES.md). **Unlocks:** reliable diagnostics and benchmarks.

## Problem and scope

At the reviewed baseline, both start on a loaded service and resume can call
`launchctl kickstart -k`. That restarts the service, potentially losing the warm
model or interrupting a job. Make lifecycle commands express their actual intent.
This task owns CLI/service lifecycle behavior, not model math or recipe changes.

Read `worker/src/platform/macos/user-cli.ts`, `launch-agent.ts`, `local-drain.ts`,
`command-lock.ts`, `worker/src/runtime/local-lifecycle.ts`, the runtime adapter,
and `worker-runtime.ts`. Locate all kickstart callers, including recovery/update
flows, before changing the shared controller. Use existing CLI and lifecycle tests.

## Required work

1. Make `start` idempotent for a healthy running service. Preserve PID, active
   attempt, and model process. Handle loaded-but-stopped and unloaded states
   explicitly; do not use a kill flag as a generic wake mechanism.
2. Make `resume` persist active local intent and notify/reconcile the running
   supervisor without restarting it. Decide and document behavior when stopped;
   report stopped truthfully rather than claiming readiness. Repeated resume is safe.
3. Keep `restart` explicit, graceful by default, and subject to drain/cancellation
   semantics. Force remains an explicit operator choice. Preserve prior local
   lifecycle state on failure and never override backend restrictions.
4. Account for concurrent CLI calls and races with automatic child recovery. Keep
   state writes/command locking coherent and give useful bounded timeout errors.
5. Return distinct outcomes such as already-running, intent-updated, service-started,
   and restarted in human/JSON output. Task 04 adds full readiness waiting.

## Validation and acceptance

- Tests cover unloaded, loaded/stopped, running/idle, running/busy, paused, draining,
  backend-restricted, duplicate calls, and drain timeout states.
- Fake launchctl tests prove ordinary start/resume do not issue `-k` or bootout to a
  running service. Explicit restart waits for work to drain unless force is given.
- A task-owned local runtime check demonstrates PID/child identity retained across
  start/resume. Do not interrupt a production-connected installation for this test.
- No abandoned lease or duplicate job occurs in the busy-path test. Failure output
  reports actual state, and fixtures/CLI help are updated together.

## Handoff

Record the command/state behavior table, changed call sites, focused test results,
and remaining readiness limitations. Supply task 04 with the non-restarting wake
mechanism and task 09 with lifecycle paths that legitimately reload a model.

## Local execution record — 2026-09-23

- `start` now reports `already-running` without touching a running LaunchAgent or
  `service-started` when it bootstraps or non-killing-kickstarts a stopped service.
- `resume` updates local intent without kickstart. The runtime watches the private
  lifecycle file to wake reconciliation; its existing bounded poll remains fallback.
  Repeated resume preserves the revision. A stopped service remains stopped.
- `restart` remains explicit and drains a running service. Stop of a loaded but
  nonrunning service no longer waits on stale active-attempt status.
- Focused tests: 45/45 passed across `macos-user-cli.spec.ts`,
  `macos-launch-agent.spec.ts`, and `worker-runtime.spec.ts`.
- Worker `format:check`, `lint`, `typecheck`, and `build` passed locally.
- Real LaunchAgent PID preservation was not exercised: the fixed MusicMute service
  label is already loaded on this host. The local tests prove command calls and
  same-runtime child reuse without touching that installed service. Task 15 must
  retain this limitation unless a safe isolated integration proves the real PID.
