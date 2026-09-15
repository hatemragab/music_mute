# W04 execution brief

Implement [W04](../worker/W04-activation-and-rollback.md) after W03 independent
review. Read its completed report and actual interfaces at handoff; W03 is still
being implemented when this brief is prepared. The approved task/design remain
authoritative. No commits, deployment, real services, migration, or legacy adapter
is authorized. Preserve all other contributors' work.

## Boundaries to reuse

- W01 `Launcher.run` already holds the machine lock over startup, nonce handshake,
  child execution and verified descendant stop. A saved launcher ownership record
  must be reconciled before starting another child. Integrate activation into this
  serialized lifecycle; do not create a competing worker supervisor or acquire a
  non-reentrant machine lock recursively.
- Worker journals, progress and execution records are independent authorities.
  An idle process or absent heartbeat is insufficient: confirm owned assignment
  terminal state, acknowledged local cleanup, and verified stopped descendants.
  Preserve unresolved ownership and stop attestations across power loss.
- W02 prepares environments at their final versioned location, inventories the
  full executable/importable tree including interpreter aliases and both media
  binaries, and uses isolated Python launches. Moving an installed venv or mutating
  active dependencies invalidates that identity. Candidate preparation may
  download/install while busy; GPU qualification must wait for the safe boundary.
- W03 supplies maintained TUF verification, exact signed release descriptors,
  confined downloads/extraction, cache ownership and durable event reporting.
  Consume its verified result, not a raw dashboard target or an unsigned local
  directory. Active/prepared/permitted rollback references must survive cache GC.

## Existing backend authority

Read `WorkerRolloutsService.getUpdateDecision/updateStatus` and worker readiness
code before wiring transitions. The current ordered stages are `available`,
`downloading`, `prepared`, `waiting_for_idle`, `validating`, `activating`, `running`,
`verified`; terminal stages are `failed`, `rolled_back`, `blocked`. Status writes
carry policyRevision, stage, observedBuild, eventId and optional processingAttemptId
under the existing validation/fences. Do not confuse B03 reporting events with
these authoritative update transitions.

Re-fetch authenticated policy immediately before switching; a stale selected
target, paused/superseded rollout, withdrawn release, or changed minimum build must
not activate. If policy cannot be refreshed, keep claims held and preserve the
known consistent environment. Recovery may inspect local state offline, but must
not treat offline permission as fresh assignment eligibility.

## Durable activation requirements

Journal every transition before its side effect. Include old/candidate identity,
full runtime/model bindings, current policy revision, fallback permission, and
which readiness acknowledgement was obtained. Use atomic replacement with durable
file and parent-directory synchronization where supported; file-only fsync is not
proof of power-loss persistence for a replaced pointer. Native limitations must
be explicit and tested through the adapter contract.

Treat claim hold as local operational state, not administrator desired state.
Candidate checks must not claim a job or manufacture qualified profile evidence.
Only resume claims after the actual readiness acknowledgement. After a candidate
has owned work, rollback must first stop/reconcile that ownership. Rollback restores
the complete allowed environment and requires both signed compatibility and current
backend fallback permission; no data conversion is introduced.

Launcher updates need their own durable handoff/recovery record and retained known
working executable. Keep native service entrypoints fixed. Fault injection must
prove a failed new launcher cannot remove the sole recovery path.

Test crashes before/after each journal/pointer write, stale selection, missing
network, candidate failure before/after claims, prohibited rollback, lock ownership,
and duplicate restart calls with actual temporary files. Report local tests
separately from native service/boot qualification and hold source for review.

## W03 handoff interface check

Current `Launcher.maintenance(client, bootstrap_root=..., distribution_origin=...)`
returns `client`, `events`, `verifier`, `downloader` and `cache`. It briefly acquires
the machine lock to verify installation/API binding; `ReleaseVerifier.resolve`
acquires that same lock internally. `Launcher.run` holds it for the whole child
lifecycle. W04 must explicitly resolve this ownership arrangement when integrating
maintenance; invoking either lock-taking factory/verifier from an already locked
run is not safe for a non-reentrant native lock.

`ControlClient` currently exposes `fetch_policy`, `server_time` and `post_events`.
Authoritative update-status submission still needs a bounded authenticated client
method in W04, with durable event ID and exact retry payload. Backend status
transitions are consecutive, and `observedBuild` must match the backend's current
runtime report. Do not report a candidate build as observed merely because it has
been downloaded. `running` additionally requires the exact target runtime;
`verified` requires an independently stored processing attempt after running, so
successful startup/readiness alone must never emit `verified`.

W03 review and root spool integration evidence are in `W03-report.md`,
`W03-clock-response.md` and `W03-spool-backend-integration.md`. The isolated exact
launcher interpreter is `/tmp/musicmute-w03-launcher-lock-check/bin/python`.

Worker lifecycle integration points checked in current source: `run_once` first
recovers contained processes, verifies identity, then calls `_assignment`.
`_assignment` resumes pending cleanup before it reconciles/discovers ownership.
`_resume_cleanup` requires backend `local-cleanup` status `cleaned` before it
acknowledges execution and clears the assignment/cleanup records. Preserve that
ordering. A local update hold must fence fresh claims while still allowing these
cleanup and owned-recovery paths; simply returning early from the whole loop would
prevent the very cleanup needed to reach an activation boundary. Reuse the existing
dedicated recovery claim endpoint when discovering uncertain ownership under a
hold; do not make an ordinary claim just to ask whether work exists.
