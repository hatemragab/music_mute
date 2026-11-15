# W08 — Build automatic Prepare, recovery and repair

- Status: code-complete / Windows pending; automatic Main lifecycle and signed cold-to-warm Operations composition now have portable proof.
- Code dependencies: [W04](W04-electron-shell-and-navigation.md), [W06](W06-runtime-and-model-package-layout.md), [W07](W07-directml-selection-and-qualification.md).
- Accepted scope points: P04, P05, P06, P19.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [preparation foundation](../evidence/W08-prepare-foundation.md).

Preserve earlier source checkpoints and their checked fixtures. Continue source
implementation only within explicit authorization on the Mac; actual installation/
GPU checks stay in W34.

## Current source audit — 2026-10-10

[Requirement → production entry → portable proof → native acceptance](../evidence/W06-W09-runtime-prepare-readiness-closure-2026-10-10.md)
records every boundary below. `[x]` in implementation/code sections means source
and portable proof, never Windows execution. Historical completion commands below
remain dated slices; use the current matrix for subsequent changes.

## Existing behavior and design consequence

Mac setup already models missing prerequisites and interrupted commands. Windows needs an equivalent durable coordinator using the new installer/GPU adapters, without confusing local readiness with fleet enrollment.

## Read before editing

- [chrome-extension/macos/MusicMuteLocal.swift](../../../chrome-extension/macos/MusicMuteLocal.swift)
- [chrome-extension/macos/ProcessBridge.swift](../../../chrome-extension/macos/ProcessBridge.swift)
- [chrome-extension/src/companion/app-setup.ts](../../../chrome-extension/src/companion/app-setup.ts)
- [chrome-extension/src/companion/local-setup-error.ts](../../../chrome-extension/src/companion/local-setup-error.ts)
- [chrome-extension/docs/setup-updates.md](../../../chrome-extension/docs/setup-updates.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] On first launch or detected missing setup, open Setup and begin the agreed automatic local preparation. Implement explicit stages for inspection, space/download planning, runtime, model, GPU qualification, activation and helper registration.
- [x] Persist a bounded versioned journal so crashes/restarts resume verified work only. Serialize concurrent app/Chrome setup requests and ensure one owner performs installation.
- [x] Show simple stage/percentage/download/disk information with cancel, retry and repair. Use indeterminate progress for unmeasured operations; never fabricate a percentage or leave a success badge after a failed child.
- [x] Make cancel terminate owned activity and release locks while keeping only safe resumable state. Handle network interruption, invalid signatures, low disk, permission errors, unsupported GPU and native-helper version mismatch with actionable localized messages.
- [x] Keep local readiness independent of Google/admin enrollment. If fleet credentials already exist and saved intent permits startup, resume through its controller; otherwise local setup completes without fleet access.
- [x] Verify every prerequisite before Ready; include browser registration status separately so a Chrome issue does not incorrectly label model readiness. Keep repair bounded and preserve valid cache/account/worker identity.
- [x] Add complete setup state transitions and recovery fixtures; no actual runtime installation on the development Mac.

## Code validation checklist

### Recorded implementation slices

- [x] Implement the bounded journal, stage coordinator, native mutex lease and stale completion fences with code fixtures.
- [x] Implement signed consumer bundle verification and real streaming ZIP planning/extraction with traversal/alias/link/cancellation fixtures.
- [x] Implement pinned model download, private file fingerprints and versioned runtime/readiness parsers with code fixtures.
- [x] Wire measured progress, cancel/retry/repair actions and safe errors through the main/preload boundary; headless renderer fixtures pass.
- [x] Implement the fixed owned qualification entry and separate personal/backend-approved fixture validation; native execution remains unrun.
- [x] Capture/recheck the current native boot witness around guarded qualification and publish mandatory ReadyReceipt v2; prior installed bytes may support network-disabled offline requalification but cannot reuse old GPU readiness. See [current boot checkpoint](../evidence/W07-W09-boot-witness-and-session-serialization-2026-10-09.md).
- [x] Bind production GPU maintenance/admission, complete runtime repair/staging cleanup and native browser registration before closing the full task.

- [x] Test every setup stage failing/cancelling/restarting, stale owners, concurrent requests, expired receipts, valid partial reuse and missing disk space.
- [x] Assert Ready cannot be produced by file existence alone, rejected GPU evidence, failed activation or a stale completion message.
- [x] Headless-test simple progress/error/retry states and signed-out Prepare without launching the UI.

## Windows acceptance — deferred until W34

- [ ] Run fresh and interrupted Prepare on real Windows, including network loss, process crash, reboot/logout, low disk and repair.
- [ ] Confirm standard-user operation, correct staging cleanup, UI responsiveness and actual GPU-ready state.

## Agent execution contract — planning review 2026-10-09

Prepare is a local prerequisite workflow, independent of Firebase, account quota,
worker enrollment and backend-approved fleet qualification. Its output is an
activated verified runtime/model and personal readiness proof, plus a separate
browser-registration result. A Chrome error must not turn valid local GPU
readiness into a false model failure.

| Boundary      | Current source and required invariant                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator   | `main/prepare/controller.ts`: version-1 journal has transaction UUID, target, SID, state and an ordered completed-stage prefix; one native lease owns work.            |
| Target        | `bundle.ts`: identity binds explicit consumer profile, signed archive/version/sequence, shared model pin, preparation fixture and qualification policy.                |
| Private files | `private-files.ts`: native ACL/reparse/hardlink checks and descriptor fingerprints; arbitrary renderer paths are refused.                                              |
| Qualification | `qualification-runner.ts` + fixed `agent/prepare.cjs`: verified release/model/fixture and qualified candidate, owned native Job and physical GPU guard.                |
| Activation    | `operations.ts`: strict runtime proof and DPAPI ReadyReceipt version 2 with current native boot witness; publish only after full verification and owned qualification. |
| Presentation  | Narrow main/preload contracts: measured bytes where known, indeterminate work where unknown, safe error codes and cancel/retry/repair actions.                         |

### Implementation order and boundaries

1. [x] Trace `PREPARE_STAGES` and each `perform/reuse/repair` branch together;
       verify there is no path to Ready through a completed journal alone. Every
       reusable stage must independently establish its exact target-bound proof.
2. [x] Close W06 transfer-to-activation composition before describing fresh-user
       Prepare as complete. Fresh resumable runtime/model source now exists;
       validate it with actual extraction/recovery adapters. Packaged/pre-staged
       verification remains separate from real network acceptance. Preserve
       upstream-only model distribution.
3. [x] Reconcile stage disk estimates with archive/extraction/model/qualification
       staging and W22 reservations. Check actual private-root volume availability;
       report an unknown measurement as unavailable, not unlimited free space.
4. [x] Integrate W11/W29 maintenance: block new admissions, drain personal work,
       preserve fleet saved intent, acquire the fixed selected GPU guard and prove
       all relevant owned trees/pins settled before runtime replacement. No blanket
       taskkill, service stop or account credential deletion.
5. [x] Verify every candidate failure/cancel tears down its exact Job before
       the next candidate. Personal qualification uses the signed app fixture;
       enrolling fleet needs the separately approved fixture exchange.
6. [x] Review proof-before-rename and receipt-last activation recovery. Commit
       runtime sequence monotonically, bound receipt to model file identity and GPU
       evidence, then create the W09 cheap-status capsule. Never promote a stale
       transaction's completion into the new target's readiness.
7. [x] Integrate W26 HKCU browser registration and expose its own status/repair.
       Finish bounded deletion of only settled owned staging/archives; preserve
       Library, outbox, installation identity and fleet credential/state roots.
8. [x] Review first-launch, automatic setup, Retry, Repair and relaunch through
       the actual main composition/headless renderer. A local setup action must
       remain usable signed out and with missing backend configuration.

### Races and fault fixtures to close

- [x] Inject failure/cancel at every stage, every journal write and every final
      rename. Restart with missing/stale/corrupt journal and assert exact reuse or
      explicit Repair state; never silently reset damaged records into success.
- [x] Concurrent app/Chrome/fleet setup demand, delayed lock acquisition,
      abandoned owner, replacement target and late success from cancelled child:
      only the current owner can advance/publish.
- [x] Failed signature/download/archive/model hash, low disk, Native helper
      protocol/version mismatch, ACL rejection and qualification with CPU nodes:
      Ready is false; retry does not weaken validation or change processing mode.
- [x] Cancel while decoder/GPU descendant remains alive or teardown is unknown:
      keep protected scratch/runtime ownership until proof arrives. Button-level
      cancellation is not process-exit evidence.
- [x] Valid local setup with Chrome registration failure; ready model while
      offline; missing account/backend; prior approved fleet credential with saved
      stop/start intent. Assert separate local/browser/fleet states.
- [x] Fault after release rename but before receipt, after receipt but before
      startup capsule, and during old-release deletion: recover the exact activation
      or retained predecessor without deleting an active consumer's files.

Extend existing Prepare controller/records/view, archive/model, readiness and
qualification fixtures. Fake native ports must record tree/lease ownership;
failure tests must not fabricate safe shutdown. Use synthetic fixture media,
temporary directories and injected HTTP; no Mac runtime installation or model
inference. Record focused tests and component checks separately.

### Deferred machine evidence and deliverables

- [ ] Fresh standard-user Windows 10 22H2/Windows 11 Prepare, real HTTPS runtime
      and upstream model download, actual signed inventory/ACL/DLL checks and GPU
      qualification, with no elevation and no preinstalled tools.
- [ ] Real network disconnect, forced app/helper death, reboot/logout, low disk,
      repair, cancelled GPU child and maintenance contention. Verify source/media,
      outbox and approved fleet identity survive.
- [ ] Deliver a stage/proof/reuse table, crash-boundary matrix, simple state/UI
      screenshots after W34, measured byte/disk evidence and clean-user run log.

Primary constraints checked: [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
support child-tree ownership; last-handle termination requires the kill-on-close
flag. Actual zero-process proof remains necessary before reuse/deletion. Chrome
documents [per-user native messaging registration](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging);
registration correctness and extension communication are separate W26/W34 tests.

## Actual transfer-to-activation fixture return

- [x] Compose real downloader → signed ZIP planning/extraction → injected owned
      qualification → activation using temporary signed fixtures, not unrelated
      success-returning stage adapters.
- [x] Fault partial checkpoint, verified rename, receipt/sequence write and
      completed-archive deletion; test cancel→repair and exact prior offline
      activation with expired metadata without authorizing a new download.
- [x] Return after W11 admission and W29 maintenance exist; test conflicting
      consumers, preserved accepted work and exact owner cleanup before Ready.

## Exact remaining portable composition return

- [x] Real signed ZIP → bounded injected HTTPS → real Operations/extraction →
      injected owned qualifier → receipt-last activation → offline cheap controller,
      plus failure/restart/repair/cleanup fixtures (R03–R17, P02–P10).
- [x] Bind actual Main admission/settlement and separated browser registration;
      Controller/Gate/domain and renderer/preload tests are executable portable
      proof. Model assistance uses only typed actual model I/O failures (P10).
- [x] Execute the production automatic first-launch/observe-settlement decision
      through a bounded reusable Main orchestration seam: signed-out cold startup,
      authenticated warm bypass, headless/cloud no-Prepare, maintenance deferral,
      failed retained cleanup and post-Ready approved recovery. The actual Main lifecycle, real Controller/Maintenance/Gate and signed
      Operations cold-to-warm fixtures now execute that binding; see
      [the lifecycle return](../evidence/W08-desktop-lifecycle-2026-10-10.md).
- [ ] Capture real Windows Setup UI, DLL/GPU/network, HKCU/Chrome and fault logs.

## Completion record

- Implementation files and review: `windows-desktop/src/main/prepare/`, `src/agent/prepare.ts`, host/main/preload/contracts and renderer integration; see evidence.
- Commands/results and evidence: focused and full code checks in [W08 evidence](../evidence/W08-prepare-foundation.md).
- Unrun native/toolchain checks: all Windows execution/installation/GPU/UI checks.
- Current source return: P01–P10 and R03–R17 prove the actual domain composition, failure/cancel/restart matrix, retained admission and repair. Main auto-launch/observe-settlement now has the dedicated actual lifecycle and signed Operations fixtures: 141 tests/11 files passed at 02:46:21; whole TypeScript, scoped lint/format, source build and two boundaries passed. See [the lifecycle return](../evidence/W08-desktop-lifecycle-2026-10-10.md). Genuine W31 resources and all Windows execution remain pending.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
