# W25 — Port worker Advanced, diagnostics and maintenance

- Status: code-complete / Windows pending (production source and portable checks complete; native/live/signed-release acceptance deferred).
- Code dependencies: [W09](W09-startup-and-readiness-receipts.md), [W11](W11-gpu-admission-and-handover.md), [W22](W22-storage-budget-and-cleanup.md), [W24](W24-worker-controls-and-saved-intent.md).
- Accepted scope points: P21, P22, P27.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [consumer Advanced core](../evidence/W25-consumer-advanced-core.md).

Checked implementation/code rows refer to the concrete production source and portable fixtures mapped in the [final source closure matrix](../evidence/W23-W24-W25-W29-final-source-closure-2026-10-09.md). They do not claim native execution. A dependency's pending Windows proof does not block source work; preserve every W34/native/live/release gate below.

## Existing behavior and design consequence

Existing Windows maintenance helpers may still invoke privileged service operations despite their names. Reuse domain behavior and reports, but route consumer execution through the per-user agent.

## Read before editing

- [chrome-extension/macos/DesktopWorkerView.swift](../../../chrome-extension/macos/DesktopWorkerView.swift)
- [worker/src/cli/app-control.ts](../../../worker/src/cli/app-control.ts)
- [worker/src/platform/windows/user-health.ts](../../../worker/src/platform/windows/user-health.ts)
- [worker/src/platform/windows/user-maintenance.ts](../../../worker/src/platform/windows/user-maintenance.ts)
- [worker/src/platform/windows/user-benchmark.ts](../../../worker/src/platform/windows/user-benchmark.ts)
- [worker/src/platform/windows/diagnostic-bundle.ts](../../../worker/src/platform/windows/diagnostic-bundle.ts)
- [worker/src/platform/windows/user-removal.ts](../../../worker/src/platform/windows/user-removal.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Implement Advanced jobs/history, bounded logs, health/doctor, diagnostic export, eligible cleanup, capacity details/benchmark, runtime update, recovery, revoke/remove and purge journeys.
- [x] Map every existing command to its required authority, idle/drain requirement, data effects and consumer-safe adapter. Do not surface arbitrary CLI execution.
- [x] Keep heavy benchmark/repair/update actions mutually coordinated with personal and fleet work; preserve accepted jobs and require explicit in-product confirmation for destructive operations.
- [x] Preserve capacity receipt binding and backend approval requirements; a benchmark result alone cannot increase authorized capacity or claim production readiness.
- [x] Redact and bound diagnostic exports, keeping private media/tokens/grants out. Personal diagnostics remain local; preserve the existing authorized fleet reporting contract.
- [x] Separate revoke, uninstall and purge. Remove only this consumer's registration/state; inspect shared-runtime references before cleanup and never remove legacy services or browser profiles.
- [x] Implement recovery from interrupted maintenance with durable status and actionable errors. Do not hide a failed native operation behind a generic success.

## Code validation checklist

- [x] Test each maintenance command's authorization/state gate, unsupported service adapter refusal and redaction schema.
- [x] Fault-test benchmark/update/cleanup/removal cancellation and restart, active leases and retained shared runtime.
- [x] Test bounded history/log retention and sanitized report exports with adversarial secret-like fields.

## Windows acceptance — deferred until W34

- [ ] Run non-destructive health/doctor/history/export on Windows and authorized benchmark/update recovery scenarios.
- [ ] Run revoke/removal/purge only with explicit authorization in a disposable installation and confirm isolation from source files, other users and legacy services.

## Detailed agent execution handoff

### Implemented production source and execution boundary

The production consumer core is now implemented in [Advanced](../../../windows-desktop/src/main/fleet/advanced/factory.ts), with [closed commands](../../../windows-desktop/src/shared/fleet-advanced-contracts.ts), current-machine one-use confirmations, DPAPI recovery, local descriptor-based history/doctor/log/performance views, actual sanitized ZIP export, independent revoke/remove/purge, physical guarded benchmark dispatch and private capacity receipt selection in the real fleet runtime. It never calls the service/elevated operator adapters. The original shared validator checkpoint (27 passes/one skipped) remains historical.

The historical 2026-10-09 checkpoint passed Desktop typecheck/source build and 162 focused tests across 13 files, including 41 new Advanced tests; Worker typecheck/build and 30 shared domain tests across 7 files also passed. Typed mutex repair and contention/finally-release/oversize cases remain in fleet regressions. The final source matrix records later whole composition, rich benchmark, force/catalog and recovery checks. Native compilation, real DirectML measurements, live grants/backend operations and Windows acceptance remain unrun.

- [x] Implement production no-admin Advanced command/identity/journal/maintenance core and bound readonly reports.
- [x] Implement fixed DirectML benchmark child dispatch, guard-before-launch/all-descendant cleanup, approved-fixture separation and storage writer-to-native ownership handoff.
- [x] Persist/validate local two-worker evidence and intersect selection with backend policy; stable slot identities enter the real WorkerRuntime only after valid evidence.
- [x] Test stale confirmation/machine replacement, acknowledgement loss, exact revocation recovery, owner birth, guard/tree uncertainty, report forgery/fallback, retention and real ZIP reading.
- [x] Bind Advanced Main/preload/renderer/native export and local notifications; verify confirmation/cancel/filter/export, rich benchmark options, Arabic keys and dialog/busy behavior through portable tests. Native accessibility/operation remains separately pending.
- [x] Consume the legitimate W29 active-fleet runtime overlay from fleet/Doctor/capacity/benchmark contexts without rewriting immutable backend approval/report; portable update/rollback resolver tests pass. Real Windows qualification remains deferred.
- [x] Implement file-benchmark baseline/candidate/group1/saved-audio/report core through readonly source and claimed trusted destination capabilities. Verify installed candidate inventory/code, source preservation, bounds and destination/pin/handle lifetime in code fixtures.
- [x] Revalidate complete rich Main/preload/UI picker/streaming-export/locale/accessibility composition from the new production bindings; source tests do not establish real dialogs or Windows export.
- [ ] Exercise real Windows/native/toolchain/GPU/maintenance/update/removal acceptance after W34 authorization.

Use `createWindowsFleetAdvanced({host,native,operations,session,files,fileOwner,storage,exportArchive,updates?,onChanged?})`; it returns controller/inspection/benchmark plus awaited `close()`. Updates are optional and truthfully unavailable when unconfigured. Missing Ready produces failed/unavailable Doctor/version checks while existing history/status remains readable. `storage` supplies actual planned processing pins, Node writer `handoff()` before launch and exact owned Prepare workspace tracking. A launch with a lost ACK and no exact native owner receipt stays recovery-blocked: no PID-only exit proof is fabricated.

Read [Mac Advanced UI](../../../chrome-extension/macos/DesktopWorkerView.swift), [app command protocol](../../../worker/src/platform/macos/app-control-protocol.ts), [operator logic](../../../worker/src/platform/shared/operator-cli.ts), [operational logs](../../../worker/src/platform/shared/operational-logs.ts), [investigation](../../../worker/src/platform/shared/investigation.ts), [performance report](../../../worker/src/platform/shared/performance-report.ts), [capacity report](../../../worker/src/platform/shared/capacity-benchmark.ts), [capacity receipt](../../../worker/src/runtime/capacity-receipt.ts), [session maintenance](../../../windows-desktop/src/main/session/maintenance.ts) and [qualification guardian](../../../windows-desktop/src/main/prepare/qualification-runner.ts).

Existing `worker/src/platform/windows/user-health.ts`, `user-maintenance.ts`, `user-benchmark.ts` and `user-removal.ts` call service/administrator paths. Their names do not make them consumer-safe. Reuse domain schemas/report mathematics through actual per-user adapters; do not call SCM/ProgramData/HKLM/privileged PowerShell as a fallback. The existing engine supervisor is `MachineSupervisor`, not an invented `WorkerMachineSupervisor` API.

### Authority and deliverable map

| Journey                       | Required authority/state                                                                | Concrete result and constraints                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Versions/status/active jobs   | Protected current user and actual owned role                                            | Signed app/runtime/model versions, saved intent versus observed phase; mark stale/unavailable instead of using PID-only status.      |
| Jobs/history/performance      | Private bounded retained events, explicit filters                                       | Existing job/attempt lifecycle, recipe/timing/error investigation; no recurring backend status read.                                 |
| Logs/follow/errors/explain    | Validated local event files and fixed filters                                           | Lines/level/code/job/attempt/since bounds, redaction, file-publication subscription, explicit clear confirmation.                    |
| Quick/full health/doctor      | Private installation/receipt checks; heavy provider checks require idle admission       | Structured passed/failed/not-run/unsupported checks with actionable guidance; quick mode cannot claim unrun GPU health.              |
| Diagnostics/export            | Fixed allowlisted content and explicit destination capability                           | Bounded metadata/health/events/report only; no media, token/config values, grants or private provider URLs.                          |
| Cleanup preview/apply         | Preview is readonly; apply drains and holds real maintenance/protection authority       | Exact app-owned eligible scratch/log/unused-release candidates; retain recovery, active/pinned/outbox/shared-runtime data.           |
| Local/file/capacity benchmark | Signed fixed runtime, exact fixture/model/GPU and physical guard                        | Real DirectML dispatch/timing/quality evidence; current consumer SID and ordinal; no CPU inference.                                  |
| Capacity details/selection    | Bound unexpired local PASS plus current backend machine policy                          | One/two worker intersection; never elevate allowed capacity from a producer's PASS flag alone.                                       |
| Runtime update/recovery       | W29 signed update transaction and real session maintenance                              | Verified app/runtime/model/tool identity and rollback; no arbitrary archive/CLI path or duplicated updater.                          |
| Revoke                        | Exact current machine credential, explicit one-use confirmation and accepted-work drain | Existing backend unpair confirmation persisted before local credential effects; no fake confirmation after an ambiguous response.    |
| Remove/uninstall              | Defined fleet-role versus app-installer scope, explicit confirmation, real drain        | Preserve personal/account/shared runtime when referenced; use W31 consumer uninstall for actual app removal.                         |
| Purge                         | Separate destructive confirmation, idle/lease proof and exact private namespace         | Delete only approved consumer fleet data; never source files, other users, legacy service, browser profile or globally shared media. |

### Concrete agent sequence

- [x] Inventory every Mac Advanced command/parameter/result and map it to a typed, versioned consumer command. Record unsupported hardware-specific settings explicitly; DirectML group size remains the validated value, never an excuse for CPU substitution. UI must include versions, jobs/history, filtered logs/follow, errors/explain, performance, health/doctor, diagnostics, cleanup preview/apply, file/capacity benchmarks, capacity selection, runtime update/recovery, revoke, remove/uninstall and separate purge.
- [x] Implement protected fleet-root read/write ports and actual role identity validation before reading status/events. Bound file count/bytes/lines and reject links/reparse points/hardlinks/foreign roots. Reuse pure report validators and sanitize output before renderer or export. Do not statically bundle worker launch modules whose module-relative/import-meta paths need the verified release tree.
- [x] Add safe readonly views and fixed filters; use file publication/raw snapshots for live changes. Distinguish retained history from current active attempts. Implement real native export/share destination capabilities, with cancellation and bounded cleanup; don't report a JSON stub as a ZIP/native export.
- [x] Implement durable maintenance phases and `createSessionMaintenancePort` binding. Acquire its fence, preserve saved intent, finish accepted fleet work and require personal/all-child/physical GPU idle before a heavy action. Release restores same-runtime authority; `commit` retires old authority only for the updater's changed runtime. Persist uncertainty and recover before another mutation.
- [x] Add only a strict fixed benchmark discriminator to the signed Prepare entry, with no arbitrary command/module/path arguments. Hold the current-SID Prepare mutex. A real guardian must acquire the actual Global GPU guard **before** `launchOwned` ACK/resume. Native prelaunch Prepare guard creates an independently kept nested GPU Job, and the child joins both Role and GPU Jobs before running. Use exact owned-tree stop/certificate before physical guard release; `runOwnedMediaOperation` is CPU-tool authority and must not launch unguarded model benchmarks.
- [x] Bind backend-approved fixture for fleet capacity, and a separately rights-confirmed read-only file capability for an explicit local file benchmark. Freeze fixture bytes/hash, actual SID/model/release/engine/driver/GPU identity, recipe, warmup/measured count and bounded runtime. Stage only fixed private paths and preserve selected source. Existing engine cohort quality/throughput gates, worker process identities and full timeline/output verification remain mandatory.
- [x] Persist honest local benchmark evidence and an unexpired capacity receipt bound to machine/release/model/fixture/hardware/driver/host. Current backend allowed slots/policy is separate authority. Integrate selected slot identities into the actual runtime only after both pass; expired/changed context reduces/refuses safely. A local benchmark does not create administrator approval, production readiness or new authorized workers.
- [x] Delegate signed runtime updates/recovery to W29 instead of writing a second downloader/activation journal. Resolve the W23 activated-report/update incompatibility before automatic fleet resume. Include old fleet/local active-runtime/capacity state in rollback and test shared runtime references.
- [x] Implement explicit one-use bounded confirmation tokens tied to exact action, machine, Windows owner, revision and data scope. Revoke/remove/purge are separate; no hidden force option interrupts accepted jobs. Persist confirmed unpair before dropping credentials. Serialize identity compare/mutation with enrollment writes so a late A cleanup cannot erase B/new machine state.
- [x] Bind the real Main broker and localized Advanced UI, including safe errors/progress/cancel/retry/recovery. A missing helper/approved fixture/update target is unavailable, not a successful adapter placeholder. Complete production callback wiring before checking implementation done.

### Meaningful code-only tests

Use fixtures for every command/authority/state pair and exact parameter rejection; current/stale/foreign role birth; corrupt/oversized/log-link files; adversarial secrets in strings/nested report fields; fixed export allowlist; no service/administrator fallback. Fault drain, maintenance journal/write/ack, helper death, guard contention, benchmark startup/progress/result, cancellation and **every-child** stop uncertainty. Recover interrupted phases without losing saved Pause/Stop or resuming a stale runtime.

Benchmark tests must reject LocalService in a consumer context, wrong current SID/ordinal/driver/model/fixture/manifest, CPU node dispatch/fallback, fabricated throughput/quality, reused cohort PIDs, expired receipt and backend allowed capacity below the requested value. Test file descriptor change and source preservation, output/report bounds, optional saved benchmark audio remaining private and excluding media from diagnostics. Mocked GPU reports test validation only; real DirectML performance waits for W34.

Removal tests cover wrong-machine unpair, lost response, backend conflict while accepted attempts exist, stale confirmation token, mutation race with new enrollment, scope-isolated purge, shared-model/runtime references, browser registration conflicts and partial deletion/restart. Never call live unpair/purge while developing fixtures. The final source record includes focused worker capacity/benchmark and consumer Advanced tests, relevant session/admission/update regressions, strict component checks and source builds. The typed fixture/mutex contract is corrected without weakening production safety.

### Deliverables and Windows acceptance

Deliver command/authority table, complete per-user production dispatch, sanitized views/export, durable maintenance/confirmation/recovery journals, fixed guarded benchmark code and slot/backend intersection, all Mac Advanced controls/filters, and executable failure evidence. W34 later compiles native source and runs non-destructive health/history/export plus designated GPU benchmarks and crash/guard faults on the connected Windows x64 machine. Real revoke/uninstall/purge needs explicit authorization in a disposable installation. A Mac code fixture establishes none of those native results.

## Production UI, confirmation and export closure

- [x] Compose `createWindowsFleetAdvanced` in main; expose validated command/view
      types through preload. Notifications use local file/session events, no polls.
- [x] Bind every report/filter/action with English/Arabic, focus/busy/recovery and
      truthful unavailable updates; retain simple defaults under Advanced.
- [x] Export actual bounded ZIP through a one-use native destination capability,
      exact path identity and exclusive/atomic publication. No raw renderer path
      or source overwrite.
- [x] Route revoke/remove/purge through exact-machine one-use confirmation/run;
      remove generic boolean-revoke bypass. Machine/state change invalidates it.
- [x] Test factory→IPC→view composition, readonly reports without Ready, stale
      confirmation, export cancellation and close ordering. Real destructive
      actions and GPU measurements remain separately authorized/deferred.
- [x] Implement worker-credential retirement/minimal purge tombstone/recovery and
      accepted consumer-fleet purge scope. Fixture tests cover confirmed receipt,
      partial cleanup, deletion ACK loss and replacement enrollment; personal
      auth, Library/outbox/shared runtime/model/legacy service data stay outside scope.
- [x] Recover a lost child-launch acknowledgement only with an exact native owner
      receipt. If unavailable, retain blocked recovery; never fabricate PID-only
      zero-tree proof. Add concrete cleanup/remove/journal fault fixtures.
- [x] Bind the W29 configured updater and W28 final localized UI through the same durable updater lifecycle; source absence returns truthful unavailable. These integration returns do not create circular foundation dependencies.
- [ ] Supply/verify approved W31 signed release/catalog inputs and exercise actual Windows operations. Source fixtures cannot create or approve real keys/artifact URLs.

See [production bindings](../evidence/W04-W18-W27-production-bindings.md) and the final source matrix for current UI/export checks.

## Completion record

- [x] Bind aggregate consumer inference-idle/maintenance to native whole fleet
      role Job proof after all-slot teardown. Retain uncertain scratch and forbid
      replacement inference until positive proof; preserve legacy shared profiles.
- [ ] Exercise orphaned descendants, multi-slot teardown, helper/query faults and
      actual GPU keeper release on Windows. Supervisor/guardian/Node completion
      alone is not whole-tree proof.

- Implementation files and review: closed Advanced contract/controller/factory/inspection/files/archive/benchmark/candidate/export/purge modules, actual Main/preload/localized UI and authenticated Session Force port; all requirements are mapped in the final source closure matrix.
- Commands/results and evidence: historical 162/13 Desktop and 30/7 worker domain checks remain above; later focused portable counts/commands are recorded in the final matrix rather than replacing historical evidence.
- Unrun native/toolchain checks: actual Win32 compile/signing, DirectML/cohort measurements, native dialogs/export/ACL/tree/keeper behavior and backend mutations remain W34.
- Remaining limitations and next task: approved release inputs and actual Windows acceptance. Consumer fleet-role remove preserves personal/account/shared runtime; actual GUI app uninstall remains W31, not an elevated service removal adapter.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Current-witness Advanced and capacity checkpoint

- [x] Consume only resolved current-witness fleet identity for Advanced inspection, approved benchmark/GPU guard and capacity host binding.
- [x] Refuse same-witness LUID changes, stale/legacy proof and changed hardware; allow explicit fresh cross-witness/unbound-legacy migration only for the immutable approved stable descriptor/model/fixture/recipes, without extra capacity.
- [ ] Verify the actual DirectML/Win32 boot, driver, hardware-change and maintenance cases on Windows; portable fixture success does not close this gate.

See [current-witness source and portable evidence](../evidence/W23-W25-W29-current-witness-recovery-2026-10-09.md). The stable hardware descriptor is not a persistent physical serial; no missing witness is inferred, original backend approval remains immutable, and native/live/release boxes remain open.

## Reviewed Force, catalog and shared updater closure

- [x] Preserve default accepted-job drain; explicit Force Stop/Restart/Update/Revoke requires a separate reviewed immutable one-use confirmation bound to machine authority, current Session revision and request UUID. The signed sole Main receiver validates it before exact old fleet Job escalation. Personal accepted work is not forced by worker update/revoke.
- [x] Persist force/source in the actual confirmation view and durable operation. Authenticated pre-effect stale revision closes only that no-effect attempt; lost ACK/tree uncertainty remains fenced and cannot adopt a replacement Job.
- [x] Offer app-managed versus separately sealed signed consumer worker catalog updates without a legacy service-catalog approval bridge or source fallback. Freeze source/descriptor in the same W29 journal; catalog updates require current app identity and operational GPU qualification and stage runtime/model only.
- [x] Bind Advanced→updater dispatch and private recovery-owner correlation in actual Main. Updater callback defers app-handle retirement while an outer Advanced command is active; cancellation/teardown and final journal/finally settle before disposal/rebind, preventing self-await shutdown.
- [x] Test recreated factory recovery after a successful update followed by failed Advanced completion write using immutable original enrollment authority, without weakening global machine identity checks.
- [x] Review every implementation/code/detailed/production/export requirement against the entry/source/proof/native matrix. No native measurement or destructive/live action is checked complete.
