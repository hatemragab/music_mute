# W10 — Implement the no-admin session agent and worker lifetime

- Status: code-complete / Windows pending. Current Session/login/durable-state source checks are complete; W25 separately records reviewed Advanced Force UI composition.
- Code dependencies: [W03](W03-windows-native-security-adapters.md), [W06](W06-runtime-and-model-package-layout.md), [W09](W09-startup-and-readiness-receipts.md).
- Accepted scope points: P19, P20, P25.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [requirement-by-requirement source ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md) plus dated historical records below.

Implementation has been explicitly authorized and source checks executed. This ledger is source-only: no Windows compiler, install, signing, Chrome/GPU/device or live release operation ran. Checked source rows below cite the actual production chain and portable proof; all native acceptance rows stay open.

## Existing behavior and design consequence

The current Windows installer starts a machine-wide service. The new consumer must run under the interactive user's identity, independently of the app window, while respecting Windows logout and saved worker intent.

## Read before editing

- [worker/src/platform/windows/service-definition.ts](../../../worker/src/platform/windows/service-definition.ts)
- [worker/src/platform/windows/user-installation.ts](../../../worker/src/platform/windows/user-installation.ts)
- [worker/src/platform/windows/native-service.ts](../../../worker/src/platform/windows/native-service.ts)
- [worker/src/runtime/worker-runtime.ts](../../../worker/src/runtime/worker-runtime.ts)
- [chrome-extension/macos/DesktopWorker.swift](../../../chrome-extension/macos/DesktopWorker.swift)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

For the sequential execution order, checkbox rules and current partial-source gaps, read [execution plan](../EXECUTION-PLAN.md), [feature acceptance](../FEATURE-ACCEPTANCE.md) and [resume gaps](../RESUME-GAPS.md).

## Implementation checklist

- [x] Implement a per-user single-instance session agent with a stable launcher and an app-owned HKCU Run registration. Use app/Chrome on-demand startup as well, since login startup may be delayed or disabled. **Source proof: L-singleton** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Supervise personal and fleet children with separate ownership, bounded restart budgets/backoff and native Job Objects. Keep the fleet process independent of Electron/Chrome port lifetime while stopping the entire owned tree at Windows logout. **Source proof: L-role** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Persist stopped/paused/draining/running intent atomically and reconcile it before starting claims. Existing approval/credential/setup checks remain mandatory; signed-out personal use creates no fleet enrollment. **Source proof: L-intent** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Handle lock/unlock, sleep/resume, network changes, interrupted shutdown and next login. Reconcile backend claims/leases before resuming; do not duplicate accepted work or revive a deliberately stopped worker. **Source proof: L-events** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Expose clear startup-disabled and recovery states. Do not rewrite startup registration on every launch, override the user's OS startup setting, require elevation or install WinSW/SCM entries. **Source proof: L-startup** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Keep existing legacy Windows services untouched. Detect conflicting installations and surface a recoverable explanation rather than adopting credentials, changing ACLs or uninstalling them. **Source proof: L-intent** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Implement app-close, quit-personal-app and MusicMute account-signout paths that preserve the separately approved fleet worker; use explicit Stop/Remove worker actions for worker lifecycle. **Source proof: L-account** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).

## Code validation checklist

- [x] Test state transitions across login/stop/pause/drain/restart/logout/sleep with injected session/process adapters. **Source proof: L-intent** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Fault-test double launch, stale process identity, supervisor crash loops, child creation failure and shutdown deadlines; assert only owned processes are terminated. **Source proof: L-role** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Check generated startup command quoting/length, HKCU scope and installer policy; prohibit SCM/HKLM/elevation calls in the consumer profile. **Source proof: L-startup** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).

## Windows acceptance — deferred until W34

- [ ] Verify standard-user login startup, startup-disable behavior, UI/Chrome-independent lifetime, lock, sleep/resume and logout termination.
- [ ] Confirm no orphan processes, no machine service/UAC and correct next-login restoration of every saved intent.

## Detailed AI-agent handoff — reviewed 2026-10-09

### Current source and boundaries

Production session source exists in [session modules](../../../windows-desktop/src/main/session/), [session contracts](../../../windows-desktop/src/shared/session-contracts.ts), [session-agent entry](../../../windows-desktop/src/agent/session-agent.ts), and [role entries](../../../windows-desktop/src/agent/). The ledger below traces production bootstrap/control bindings and portable behavior. Native logout/registry/Job delivery still requires Windows.

| Authority                 | Owns                                                                                                            | Must not acquire implicitly                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Session supervisor        | Durable fleet intent, SID-wide singleton with logon-bound IPC, personal owners, role Jobs and maintenance fence | Firebase account ownership of guest Chrome work or new fleet enrollment  |
| Stable installed launcher | Small verified bootstrap and independent agent launch                                                           | UI-owned helper Job lifetime or a generic shell launch                   |
| Fleet role                | Existing WorkerRuntime claims/drain/reconciliation with its approved credential                                 | UI/account-signout lifetime or a second scheduler                        |
| Personal role             | Original caller-bound jobs, cleanup and admission proof                                                         | Fleet worker credential or renderer-selected account identity            |
| Electron/Chrome clients   | Authenticated bounded commands and event snapshots                                                              | Arbitrary scope, startup override or forceful accepted-work cancellation |

### Ordered implementation/review sequence after authorization

- [x] Inventory existing supervisor/bootstrap/control/state-store behavior before editing. Keep `SessionState` as the sole stopped/paused/draining/running intent authority; enrollment records must not supply a conflicting intent. **Source proof: L-intent** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Validate the signed release launch inventory and fixed `runtime/node/node.exe`, `runtime/native/musicmute-native.exe` and `agent/*.cjs` paths. Publish private role configurations and DPAPI bootstrap only after full Prepare verification. Reject wrong `windows-user` profile or stale release/launcher receipts. **Source proof: L-bootstrap** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Start the fixed installed `MusicMuteSession.exe` independently of Electron/Chrome transport. The agent owns long-lived guardians; short UI helpers own only their own transport. On-demand startup and HKCU login startup must converge on the same SID-wide native singleton. **Source proof: L-singleton** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Initialize native identity, singleton, protected state and GPU recovery before starting role work. If durable state is unavailable, do not guess running intent. Reconcile the saved intent, enrollment approval/credential, readiness and legacy conflict before fleet claims. **Source proof: L-role** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Persist intent/restart/maintenance transitions atomically before side effects. A Stop or Restart that is still draining accepted jobs must retain the old child, expose pending/recovering state and retry within bounds; only OS session termination or exact guardian failure escalates to owned Job termination. **Source proof: L-intent** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Keep personal and fleet child ownership, configs, restart budgets and backoff separate. Record PID/creation time/nonce/Job receipt before accepting child control. Reset a budget only on an explicit valid recovery action; avoid an infinite crash loop. **Source proof: L-role** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Bind each personal owner to the actual authenticated peer birth and trusted client kind. Desktop submissions capture the supervisor's current account scope; Chrome submissions capture null guest scope. Never accept `captured_scope` or desktop authority merely because a renderer/browser supplied a field. **Source proof: L-owner** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Forward personal commands through the owning session gateway. Its original caller remains stable across submit/cancel/jobs/events; a fresh helper for each watcher must not change ownership. Internal scope/stop/guard controls stay on private role lanes. **Source proof: L-owner** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Publish full event snapshots with instance ID, monotonic revision, exact release, saved fleet intent, actual role phases/problems, startup and maintenance state. Implement bounded `wait_state`/personal `wait_changes` using subscriptions and separate event lanes; a long event wait must not block Stop or account fencing. **Source proof: L-events** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Handle current-session WTS lock/unlock/logoff and power/network changes. Lock is not logout. Sleep fences new work; resume/network recovery reconciles uncertain accepted claims before restarting admission. Confirm real end-session before destructive teardown, while retaining crash-safe native guardian cleanup. **Source proof: L-events** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Register the fixed HKCU Run command once at explicit activation/repair, inspect disabled/conflicting startup read-only, and never overwrite the user's disabled setting. Enforce documented command length/quoting and handle delayed login startup via bounded on-demand launch. **Source proof: L-startup** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Implement maintenance begin/end/commit for W29/W25: persist transaction/peer fence, reject new local submissions, drain fleet, prove personal cleanup and GPU idle, then stop exact role Jobs. Mark idle only from these proofs; commit retires the old agent after its reply is acknowledged. **Source proof: L-maintenance** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Make account sign-out, last personal window close, UI quit and Chrome disconnect detach personal scopes/owners without deleting fleet credentials or intent. Explicit fleet Stop/Remove and OS logout remain distinct operations. **Source proof: L-account** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Reopen after activation only when current DPAPI Ready, bootstrap and agent release agree. Await exact old authority process exit before using a new control endpoint; process exit alone remains insufficient for descendant/GPU cleanup. **Source proof: L-bootstrap** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).

### Failure and race cases

| Scenario                                                        | Expected result                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| App, Chrome and HKCU launch together                            | Exactly one agent per current logon; losers connect or return bounded busy        |
| New runtime activated but old bootstrap/control ticket survives | Reject stale release; activate/repair explicitly rather than launching old code   |
| State write fails during Stop/Restart                           | No unrecorded intent transition or false successful reply                         |
| Fleet drain exceeds a short IPC deadline                        | Preserve accepted work and saved requested intent; report draining/pending        |
| Account A signs out or changes to B while Chrome runs           | Guest work remains null-scope; A completions/outbox never become B's              |
| Event reply and cancel race on the same caller                  | Cancel reaches the role promptly; no reused ticket or ownership rebinding         |
| Child helper dies while its Node/tools remain                   | Exact guardian handles the tree; supervisor cannot infer cleanup from PID absence |
| Logout is queried then cancelled                                | Do not report final logged-out cleanup merely from the query                      |
| Update maintenance begins while accepted work/player pins exist | Fence new work; wait for valid idle/preservation proof or return busy             |
| Legacy machine service is detected                              | Explain conflict, preserve its files/ACLs/credentials, perform no SCM action      |

### Code-only test scenarios and commands

- [x] Expand supervisor fixtures for every saved intent, double launch, pending graceful drain, restart budget exhaustion, state-write failure, sleep/resume and uncertain-claim reconciliation. **Source proof: L-role** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Test bootstrap/activation/client fixtures for missing pinned resources, wrong native/session identity, stale Ready/bootstrap/release and independent UI closure. **Source proof: L-bootstrap** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Test authenticated peer/caller-kind/account fences, null guest scope, replayed request IDs, owner PID reuse and rejected internal personal commands. **Source proof: L-owner** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Test subscription revision/instance recovery, 20-second heartbeat completion, concurrent submit/cancel and shutdown of all event listeners without HTTP polling. **Source proof: L-events** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] Inject failures at each maintenance boundary; require role tree/GPU idle proof before activation and preserve pending accepted work on timeout. **Source proof: L-maintenance** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [x] From `windows-desktop/`, run focused session fixtures, then `npm run typecheck`, scoped lint/format and bundle checks. From `worker/`, run the native SDK fixtures/typecheck for changed native contracts. Never treat a fixture launcher or dummy Node as a production bootstrap. **Source proof: L-bootstrap** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).

Historical planning checkpoint: the earlier 56-fixture run and then-open fleet mock typecheck mismatch are retained in the dated audit history. They were superseded by Root’s 22:43:50 full 1,476/179 source pass. Current owned changes require their newer checks below; earlier passes do not validate later edits.

### Deferred Windows scenarios and deliverables

- [ ] Prove standard-user delayed/disabled login startup, app/Chrome on-demand convergence, UI-independent fleet lifetime, and no service/UAC prerequisite.
- [ ] Exercise lock, sleep, resume, network loss, interrupted logout, actual logout and next login with every intent; record all owned descendants and preserved accepted-work reconciliation.
- [ ] Verify guardian crash/restart and fast user switching with separate private endpoints/current-SID data but shared physical-GPU contention.

### Source lifecycle deliverable

- [x] Deliver the transition table below, fixed [config/bootstrap](../../../windows-desktop/src/main/session/context.ts) and [state schema](../../../windows-desktop/src/main/session/state-store.ts), command/event authority map and exact portable/native evidence in the [ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source).

| Trigger                                  | Durable intent/fence                                  | Observed transition and required proof                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh or unenrolled login                | Stopped/absent; no new approval                       | No fleet launch/qualification/claim.                                                                                                                                                         |
| Saved running/paused/draining login      | Preserve exact saved revision                         | Current qualified path is cheap; stale witness runs guarded PERSONAL + original-approved Fleet fixtures, then awaits the matching actual supervisor state. Stop/Remove/revision changes win. |
| Ordinary Stop/Restart with accepted work | Save stopped or restartPending before drain           | Keep old role and expose pending while accepted work drains; replacement requires successful cleanup. A short IPC deadline never forces it.                                                  |
| Reviewed Force                           | Save confirmation receipt + exact old fleet Job fence | Stop saves stopped; Restart preserves chosen intent; Update/Revoke preserve intent and ordinary personal idle. Only exact positive Job-zero proof clears pending force.                      |
| Lock/unlock                              | No intent change                                      | Keep the session; lock is not logout.                                                                                                                                                        |
| Suspend/resume/network                   | Preserve saved intent                                 | Sleep fences fleet admission; wake/network reconcile uncertain claims before restoring desired state. Failed reconciliation stays recovering.                                                |
| Shutdown query cancelled                 | Preserve state and children                           | Query alone authorizes no final teardown; actual end-session/logoff invokes owned cleanup.                                                                                                   |
| Confirmed logout                         | Preserve next-login intent                            | Stop only owned trees; native guardians establish eventual whole-Job zero. Native delivery/proof remains W34.                                                                                |
| Account signout/A→B/window detach        | Personal scope/owner changes only                     | Fence captured personal/cloud work appropriately; guest browser scope remains null; fleet credential/intent remains independent.                                                             |
| Maintenance begin/end/commit             | Persist exact peer/transaction                        | Fence new intake; ordinary drain plus personal/GPU/tree proof yields idle. End cannot erase unconfirmed Force; commit retires the old authority only after reply acknowledgement.            |

### Primary references and their consequence

- [Run/RunOnce keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys): Run execution may be delayed and its command is length-limited; do not promise immediate startup or rewrite the entry on every launch.
- [WTS session notifications](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification): register/unregister current-session notifications and handle unavailable early session services.
- [WM_QUERYENDSESSION](https://learn.microsoft.com/en-us/windows/win32/shutdown/wm-queryendsession): the query precedes the end-session decision; return promptly and defer final cleanup to confirmed termination.
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): owned descendants and retained Job accounting establish cleanup; UI transport lifetime alone does not.

## Separate fleet and account authority lifetime

- [x] Document independent session/fleet agent versus sole UI/headless account **Source proof: L-account** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
      authority. Manual Chrome Cloud shares account generation/realtime with UI;
      local Chrome submissions remain guest null-scope.
- [x] Preserve accepted Chrome work, media and replies across personal Quit; **Source proof: L-account** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
      reopened UI attaches to existing authority rather than a second controller.
- [x] Retire headless authority only after consumers/operations/replies/pins are **Source proof: L-account** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
      idle. Reap crashed peers by signed PID/birth, never bare PID or timeout alone.
- [x] Define same-SID multiple-logon behavior explicitly: IPC never crosses logons **Source proof: L-singleton** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
      from SID alone; shared-vault refresh/writes are serialized. Physical GPU
      contention across sessions/users remains W11's native guard.
- [x] Test simultaneous GUI/Chrome/login starts, idle/reply races, crashed peer, **Source proof: L-account** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
      account change and personal Quit without fleet loss. Real logout is W34.

## Reviewed Force source boundary

- [x] Add only signed sole-Main `fleet_force` with protected one-use confirmation/request UUID, original machine authority and reviewed snapshot revision. Persist the exact old fleet Job fence before effect; Stop changes saved intent, Restart preserves it, Update/Revoke preserve intent and require ordinary personal idle. Unknown tree/ACK cannot be cleared by wakeup or ordinary maintenance release. **Source proof: L-force** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)).
- [ ] Run authorized real Force scenarios on Windows and collect exact old-Job zero proof, interrupted accepted attempts and personal isolation. W25 owns user review/Main factory composition; this row does not claim its UI proof.

## Completion record

### Proven source checkpoint — 2026-10-09

- [x] Implement and code-test the independent retained shim / fixed runtime `login-worker.cjs` path and ASAR-derived public-only capsule. GUI files and account authority are not required at subsequent login.
- [x] Code-test saved running/paused/draining restoration, stopped/removed/restart-blocked no-op, immutable approval/revision changes during qualification, existing-owner preservation and actual matching supervisor acknowledgement.
- [x] Implement authenticated temporary SID-wide login ownership, fixed latest-role Job/controller proof and retained real leases on typed cleanup uncertainty. Portable native-boundary fixtures pass; real cross-logon/MSVC checks remain unrun.
- [x] Preserve independent worker Run registration in both ordinary GUI-uninstall paths and require signed runtime inventory to include `agent/login-worker.cjs`.
- [ ] Execute real Windows login/logout/reboot, secondary-GPU qualification, Run-disable/delay, foreign-logon race, uncertainty fault injection and uninstall/relogin acceptance in W34.

See [source evidence](../evidence/W03-W31-W33-2026-10-09-audit.md). Root's whole Desktop checkpoint passed 1,424 tests / 174 files; this does not compile or execute Win32/WinRT/NSIS or prove device/runtime acceptance.

Task/index/progress reconciliation is Root-owned; this task’s source proofs are recorded individually above. Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Requirement ledger return — 2026-10-09

Every source/code checklist above cites the production-entry, resource/authority,
actual implementation, portable test and native-only gate in [W10 independent session and worker source](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source).
Historical checked evidence is retained with its date. Current native compiler,
registry/PE/Job/Chrome/GPU/logon and signed candidate checks remain unrun.

## Maintenance/new-role admission return — 2026-10-10

- [x] Advance durable maintenance idle from actual fleet drain retry/whole-Job
      exit and authenticated personal-controller activity notifications. The
      notification verifies the real owned helper/role nonce/Node creation birth;
      it cannot submit a claimed idle flag. Parent queries real personal cleanup
      and GPU state under serialized supervisor ownership before saving idle.
- [x] Hold the fixed SID Prepare mutex through cold session startup and every
      new role launch; deny any protected `prepare_maintenance` WAL, including
      malformed/retired records. Existing passive controls remain reachable.
      Release the startup fence only after actual supervisor startup, and require
      the mutation owner to clear WAL/release its fence before an authorized rebind.
- [ ] Verify actual Windows controller notifications, pipe lifetime, simultaneous
      Prepare/Chrome/login starts and helper/guardian failures in W34. Portable
      ports are not native transport or process-tree evidence.

The [current ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#final-safety-returns--2026-10-10)
records 62 tests / 5 files at 00:14:28 for these source boundaries and Root's
1,764/205 whole-source checkpoint at 00:21:56. Native source digest is `3bf83a63a62a35ba8e5c8be4b1807c25a66fa36c8399b674d35815810606a1ba`;
MSVC/Win32/registry/Job/GPU/Chrome acceptance remains unrun.

## Current durable-state and lifetime return — 2026-10-10

- [x] Refuse ambiguous duplicate-key saved-intent/Force records using the existing
      bounded strict parser. Validate plain records and exact Force reason before
      reading/migrating; preserve only absent-maintenance legacy migration and
      clear plaintext buffers after valid or failed native vault reads/writes.
- [x] Execute real Vault store → real SessionSupervisor malformed-state refusal
      before eligibility/launch/claims, plus all saved intents and Force/byte/
      accessor fixtures. Broader session/bootstrap/control/event/owner/account
      lifetime checks passed **126 tests/14 files at 02:56:47**; whole TypeScript,
      scoped lint/format, source build and two boundaries passed after typed
      fixture corrections. See [current evidence](../evidence/W10-durable-session-state-2026-10-10.md).
- [ ] Run actual Windows login/Run/pipe/DPAPI/Job/logon/Force/uninstall acceptance
      in W34. No native/compiler or installed proof was produced.
