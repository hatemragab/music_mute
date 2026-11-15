# W24 — Implement worker controls and authority reconciliation

- Status: code-complete / Windows pending (production source and portable checks complete; native/live/signed-release acceptance deferred).
- Code dependencies: [W11](W11-gpu-admission-and-handover.md), [W23](W23-worker-onboarding-and-eligibility.md).
- Accepted scope points: P20, P25.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [W23/W24 source and fixture checks](../evidence/W23-W24-fleet-core.md).

Checked implementation/code rows refer to the concrete production source and portable fixtures mapped in the [final source closure matrix](../evidence/W23-W24-W25-W29-final-source-closure-2026-10-09.md). They do not claim native execution. A dependency's pending Windows proof does not block source work; preserve every W34/native/live/release gate below.

## Existing behavior and design consequence

Mac control semantics include persisted local intent, backend authority and recent start/recovery error handling. Windows needs the same product meaning through its session agent, not a service-command substitute.

## Read before editing

- [chrome-extension/macos/DesktopWorker.swift](../../../chrome-extension/macos/DesktopWorker.swift)
- [chrome-extension/macos/DesktopWorkerView.swift](../../../chrome-extension/macos/DesktopWorkerView.swift)
- [worker/src/cli/app-control.ts](../../../worker/src/cli/app-control.ts)
- [worker/src/platform/macos/app-control-protocol.ts](../../../worker/src/platform/macos/app-control-protocol.ts)
- [worker/src/runtime/worker-runtime.ts](../../../worker/src/runtime/worker-runtime.ts)
- [chrome-extension/docs/macos-worker-integration.md](../../../chrome-extension/docs/macos-worker-integration.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Trace exact current Start/Pause/Drain/Resume/Stop/Restart semantics and document a transition table before porting. Preserve accepted-work completion, cancellation policy and command idempotency rather than guessing from labels.
- [x] Expose concise controls/status in the Worker screen and versioned authenticated commands through the trusted broker. Validate owner, capability, request ID, lifecycle generation and busy state.
- [x] Persist local intent atomically across agent/app/OS restart. Backend disabled/revoked/draining state remains independently authoritative and cannot be overridden by a local Start.
- [x] Coordinate personal GPU priority and maintenance with worker controls without resetting user intent. A temporary reservation does not become a permanent Stop.
- [x] Handle timeouts, stale completion, failed startup, startup-disabled state and conflicting commands with safe localized guidance and bounded recovery.
- [x] Ensure close/quit-personal-app and MusicMute signout preserve fleet state. Stop worker is an explicit distinct action; logout of Windows stops the session-owned process tree.

## Code validation checklist

- [x] Run table-driven transition tests for every command/state pair, duplicate/stale IDs, backend authority and saved intent after restart.
- [x] Test accepted-job drain/stop/restart semantics against the existing shared runtime and GPU broker.
- [x] Test safe localized error mapping and no implicit service/HKLM calls in the consumer controller.

## Windows acceptance — deferred until W34

- [ ] Exercise all worker controls during idle, active jobs, personal requests, network loss and backend permission changes.
- [ ] Verify intent survives app close, account signout, agent restart and Windows login/logout with the required process lifetime.

## Detailed agent execution handoff

### Single intent authority and control table

The durable Session state is the sole intent authority; enrollment reports/record defaults are not a second scheduler. Read [session supervisor](../../../windows-desktop/src/main/session/supervisor.ts), [fleet control](../../../windows-desktop/src/main/fleet/runtime-control.ts), [fleet channel](../../../windows-desktop/src/main/fleet/channel.ts), [role GPU control](../../../windows-desktop/src/main/fleet/role-control.ts), [inference proof](../../../windows-desktop/src/main/fleet/inference.ts) and [shared WorkerRuntime](../../../worker/src/runtime/worker-runtime.ts).

| Trigger                  | Saved intent / claims                           | Accepted work and physical authority                                                                |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Start/Resume             | Running; backend policy still gates claims      | Start only with real enrollment/preparation/admission; no preload before permit.                    |
| Pause                    | Paused; no new claims                           | Keep accepted work; do not silently cancel jobs.                                                    |
| Drain                    | Draining; no new claims                         | Finish accepted work; remain draining until an explicit later intent.                               |
| Stop                     | Persist stopped before effects                  | Preserve child while drain ACK is pending; then confirm whole-tree exit before releasing GPU/lease. |
| Restart                  | Durable restart request, preserve chosen intent | Finish accepted work, stop old exact tree, start new incarnation only when eligible.                |
| Personal priority        | Temporary admission state, intent unchanged     | Yield only after accepted/uncertain work and every inference child are safely stopped.              |
| Sleep/wake               | Temporary session/admission state               | Follow established pause/resume policy without rewriting saved intent.                              |
| App close/account logout | Intent unchanged                                | Fleet remains session-owned; no UI helper close may kill accepted fleet work.                       |
| Windows logout           | Session ends                                    | Exact owned Job Object cleanup may escalate; never kill by image name or PID alone.                 |
| Maintenance              | Durable fence, intent retained                  | Drain both roles and require idle/physical proof; restore original intent on same-runtime release.  |

- [x] Bind typed authenticated main controls and safe Worker screen status to the real Session client. A command returns confirmed intent/revision or visible uncertainty; don't update UI intent optimistically after a lost reply.
- [x] Test command UUID/body/lifecycle fences and original peer birth, plus control/event/admission channel separation. On explicit reconciliation read actual Session intent; a restored enrollment `running` flag cannot overwrite a newer Stop.
- [x] Bind `admission_pending`, `inference_proof`, role guard acquire/release and actual Global GPU keeper to W11. The permit is logical authority; the stable role's actual helper owns the physical GPU guard. Refuse any successful stub lease, CPU fallback or model-preload-before-permit.
- [x] Preserve accepted/uncertain attempt drain. `FLEET_DRAIN_PENDING` keeps the real role and durable restart/stop request for bounded recovery. Operator Stop/Restart are not Windows-logout force termination.
- [x] Bind startup-disabled/legacy conflict/helper failure/restart budget/backoff/permission-revoked states and localized guidance. Do not invoke SCM, HKLM service install or a privileged PowerShell manager for a consumer command.
- [x] Complete independent agent/session/app-close/account-signout lifetimes and W25/W29 coordination, then record real main/renderer/agent composition rather than only the injected control core.

### Code checks and later native proof

Use table-driven every-command/state cases with duplicates, reused UUID different body, timeout before/after durable intent, two conflicting controls, restart while draining, revoked backend permission, actual shared runtime late completion, personal request during accepted work, media/tool tree not idle, stale/closed pipe, exact native exit certificate and helper death. Verify response failure does not overwrite authoritative intent. Test lost user intent across app/agent restart and maintenance rollback. Include safe error mapping and forbidden service/CLI refusal.

Run fleet control/runtime/admission plus session/gpu-broker fixture suites, strict typecheck/build and scoped lint/format after relevant changes. Existing historical fleet counts and Windows-only skips remain separate; the typed fixture contract is now corrected. The final source matrix delivers the control transition map, private protocol/capability map, confirmed-versus-uncertain UI and composed drain/handover evidence. W34 must demonstrate actual Windows background claims while UI is closed, stop/restart during a designated job, multiple session lifetimes, sleep/logout and GPU keeper crash cleanup.

## Account-independent controls and snapshot closure

- [x] Connect verified existing session controls before demanding a new model/
      inference Ready receipt. Missing public account config or signed-out UI does
      not remove local Stop/Pause/Drain/Resume for an existing approved worker.
- [x] Keep backend last-check registration state distinct from actual revisioned
      session phase/intent. Full snapshots recover instance changes and unavailable
      transport without HTTP polling or optimistic false Running.
- [x] Test signed-out/config-missing controls, absent/corrupt Ready, transport loss,
      instance/revision change, stale response and requested Stop while draining.

## Completion record

- Implementation files and review: main/fleet trusted modules, agent/fleet real shared-runtime factory and fixed bootstrap, fleet view/command contract and focused fixtures.
- Commands/results and evidence: historical 69 fleet fixtures and 99 worker regressions with 2 Windows-only skips remain in the original record. The final closure matrix records later source/composition/control checks and exact test boundaries.
- Unrun native/toolchain checks: real Windows helper, GPU, enrollment/control and logon/logout checks remain W34.
- Remaining limitations and next task: actual Windows native admission/session/claim/logon lifetime remains W34. Verified existing controls attach without account/Ready; starting a new role still requires current operational Ready. W25 reviewed Force remains explicit and independent of ordinary accepted-job-preserving controls.

## Final source closure record

- [x] Review every implementation/code/detailed/snapshot requirement against Main/preload/Worker → actual SessionClient/Supervisor/role factory and the portable proof mapped in the final closure matrix.
- [x] Keep ordinary Stop/Restart/drain policy unchanged when adding separate reviewed Force controls. No hidden force, service/HKLM fallback or optimistic intent rewrite is introduced.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
