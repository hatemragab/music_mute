# W11 — Coordinate personal, Chrome and fleet GPU use

- Status: code-complete / Windows pending; current qualified per-adapter routing, exact cleanup/recovery, isolated native test-source and actual personal/Chrome waiting presentation have source evidence.
- Code dependencies: [W07](W07-directml-selection-and-qualification.md), [W10](W10-per-user-agent-and-worker-lifetime.md).
- Accepted scope points: P22, P23, P25.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [serialized admission core](../evidence/W11-admission-core.md), [current requirement/entry/proof matrix](../evidence/W11-W12-current-admission-and-personal-closure-2026-10-10.md).

Continue source work only within explicit implementation authorization. Portable
source tests can run without Windows; actual GPU/Win32 execution stays in the
connected-machine W34 phase.

## Existing behavior and design consequence

The existing broker is Mac-specific but already encodes accepted-work handover. Windows needs a protected broker, physical-adapter identity and cross-session contention handling; process names and PID-only locks are insufficient.

## Read before editing

- [worker/src/runtime/personal-admission.ts](../../../worker/src/runtime/personal-admission.ts)
- [worker/src/runtime/personal-reservation.ts](../../../worker/src/runtime/personal-reservation.ts)
- [worker/src/runtime/worker-runtime.ts](../../../worker/src/runtime/worker-runtime.ts)
- [chrome-extension/src/companion/worker-admission.ts](../../../chrome-extension/src/companion/worker-admission.ts)
- [chrome-extension/src/companion/acquisition-gate.ts](../../../chrome-extension/src/companion/acquisition-gate.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

For the sequential execution order, checkbox rules and current partial-source gaps, read [execution plan](../EXECUTION-PLAN.md), [feature acceptance](../FEATURE-ACCEPTANCE.md) and [resume gaps](../RESUME-GAPS.md).

## Implementation checklist

- [x] Port the admission/reservation state machine through the Windows native transport without duplicating scheduler rules. Personal app and Chrome share one personal reservation authority per user/adapter.
- [x] When personal work requests priority, stop new fleet admission, let accepted fleet work and owned cleanup finish, then grant personal access. Release the reservation only after the personal child tree has actually exited.
- [x] Make requests idempotent and bind leases to owner/session/PID/creation-time/nonce, selected physical GPU and generation. Bound frames, clients, deadlines and recovery; reject stale/replayed grants.
- [x] Implement the no-admin cross-session per-adapter guard source and deny unsafe ownership as busy. Keep private data/IPC separate. B05 and the isolated native test source cover policy; actual namespace/DACL/fast-switching verification remains below.
- [x] Detect legacy-service contention without controlling that service. Handle broker crash/restart, abandoned owners, cancelled waits and simultaneous Chrome/app starts without duplicate inference or lost saved worker intent.
- [x] Keep backend capacity/recipe eligibility independent from local reservations. A reservation does not authorize claims or increase slots, and cloud requests do not reserve local GPU.
- [x] Provide simple Waiting for worker/Preparing/Busy states and cancellation while waiting, with advanced diagnostics showing only redacted ownership reasons. Actual event-driven broker → Role gateway → Runner/Controller → Desktop/Chrome receiving is proved in [waiting evidence](../evidence/W11-personal-wait-reason-2026-10-10.md); no private GPU/owner identities enter labels.

## Code validation checklist

- [x] Run deterministic concurrency/fault tests for claim-before-reservation races, active jobs, post-child cleanup, duplicate requests, stale generations, PID reuse and broker restart.
- [x] Test multiple users/adapters and legacy conflicts through native fakes; assert no private cross-user messages or unauthorized process termination.
- [x] Verify failed transport/ownership checks deny admission, and releasing personal work restores only previously allowed fleet activity.

## Windows acceptance — deferred until W34

- [ ] Run real app+Chrome+fleet contention and accepted-job handover on Windows; verify no overlapping unqualified inference.
- [ ] Test lock/logout/crash/fast-user-switching and real named synchronization permissions across users and sessions.

## Detailed AI-agent handoff — reviewed 2026-10-09

### Current source and authority boundaries

The [serialized broker](../../../windows-desktop/src/main/admission/gpu-broker.ts), [session integration](../../../windows-desktop/src/main/admission/session-admission.ts), [personal admission adapter](../../../windows-desktop/src/main/personal/broker-admission.ts), fleet controls and [native guard source](../../../worker/native/windows-consumer/gpu.hpp) exist. The current B01–B12 matrix supersedes the earlier six-core-fixture boundary: actual current-witness/runtime-qualified role accessors, per-LUID broker bank, production role/client/router/controller composition and exact certificate retirement are exercised. Those code checks do not establish real named objects, Job cleanup, cross-user contention or model inference.

| Layer                       | Authority                                                     | Required evidence                                                                |
| --------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Session broker              | Logical request, generation, durable reservation and priority | Authenticated actual peer belongs to the exact current role Job/receipt          |
| Fleet WorkerRuntime         | Existing serialized claim/preload/drain lifecycle             | Accepted/uncertain claims and owned cleanup finish before yielding               |
| Personal controller         | Per-job lifecycle and cleanup                                 | Exact inference-tree stop and storage cleanup before release                     |
| Role native guardian/keeper | Physical cross-user adapter mutex                             | Guard bound to exact Job before inference; retain until whole tree exits         |
| Prepare/Advanced            | Temporary guarded qualification/benchmark                     | Same physical guard and maintenance fence; never infer on an unguarded candidate |
| Backend scheduler           | Approval, recipe/capacity eligibility and worker leases       | A local GPU permit grants none of these permissions                              |

### Ordered implementation/review sequence after authorization

- [x] Trace the existing WorkerRuntime `PersonalAdmission` path and broker first. Keep one scheduler: pause new fleet admission, drain accepted work, then grant personal app/Chrome access through one protected per-user authority.
- [x] Validate full qualified adapter bindings from W07 against native DXGI inventory: source `DXGI EnumAdapters1/GetDesc1`, 16 lowercase hexadecimal LUID without a colon, current ordinal, vendor/device/subsystem/revision, driver version and memory limits. Driver/adapter change invalidates the old binding; a display name or available VRAM alone does not qualify a GPU.
- [x] Keep logical and physical ownership separate. The broker delegates fixed `guard_acquire`/`guard_release` to the actual personal/fleet role helper, rather than holding a second central mutex. Persist the logical reservation before allowing model execution; the role verifies its physical guard before preload/inference.
- [x] Bind admission RPC to SID/logon/session, actual helper PID/birth, owning Node/Job nonce, role generation, request/job ID and full qualified GPU. Verify child helper membership in the owner's Job; do not confuse Node PID equality with an authenticated peer.
- [x] Serialize personal-priority handover with fleet `admission_pending`, `inference_proof` and guard controls. Wake the existing WorkerRuntime loop, prevent new claims/preload, wait for zero accepted/uncertain work and successful supervisor stop, then release its guard before granting personal work.
- [x] Finish cancellation at every acquisition boundary. A rejected acquire must leave no executable permit; if a physical guard was already granted, preserve the request and call `cancelAfterCleanup` only after exact child stop plus cleanup, so the broker can release the matching logical nonce.
- [x] Use separate regular/admission/event control lanes to avoid Stop → broker → role proof/release deadlocks. Keep role proof/control alive long enough for an acknowledged release; do not terminate its server immediately after scheduling an asynchronous yielded message.
- [x] Review the global fixed `MusicMuteDirectML-v1-<LUID>` name and minimal public contention ACL: authenticated users receive only mutex synchronization/modification/read-control rights, SYSTEM has its required rights, and private data/IPC remain user/logon-only. Reject unknown owners, broader/unsafe DACLs or name squatting as busy.
- [x] Finish keeper/watchdog lifetime invariants. A failed helper/Node/keeper must not make the named object disappear while inference descendants survive. Retain an independent mutex reference and exact Job handle, terminate/wait that Job when necessary, and deny abandoned ownership until trusted prior-tree proof exists.
- [x] Persist recoverable role/guardian receipts and authenticated whole-Job exit certificates. On broker restart, pending maps may be empty; recovery must use the durable owner receipt and actual Job proof. PID absence or an abandoned mutex alone must never produce a recovered permit.
- [x] Bound clients, pending requests, frames, timers and recovery records. Use event notification/subscriptions for progress and certificate changes; expose redacted Waiting/Busy/Recovering reasons without leaking private identities or creating HTTP status polling.
- [x] Resume only the fleet intent and eligibility already allowed before personal work. Cloud mode never reserves this local GPU; legacy-service contention may block access but does not authorize service management.

### Required race/fault scenarios

| Fault/ordering                                                    | Invariant to assert                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Fleet claim races personal reservation                            | Accepted claim drains normally; no new inference begins after the fence                     |
| Personal acquire is aborted before/after physical grant           | No leaked executable permit; eventual exact-nonce release only after cleanup                |
| Duplicate job/request ID with changed owner or GPU                | Reject conflict; immutable first binding cannot be replaced                                 |
| Node exits but Python/FFmpeg remains in its Job                   | Busy until whole-Job zero-process certificate; no second model starts                       |
| Keeper dies while watchdog/guardian remains                       | Retained mutex reference and tree termination prevent a fresh-object bypass                 |
| Watchdog dies first, or multiple guardians fail during logout     | Fail closed; record missing proof and do not infer safety from source alone                 |
| Broker restarts with persisted active lease and empty pending map | Recover only from matching durable Job proof; no permanent false success or PID-only unlock |
| Fleet Stop waits while broker asks for proof                      | Separate lane/deferred shutdown serves proof without nested-pipe deadlock                   |
| Same user in two sessions or two different users request one GPU  | Exactly one physical guard; no cross-user private control or credentials                    |
| Current adapter ordinal/driver/LUID differs from receipt          | Requalify or block; never silently move to an unguarded/default device                      |

### Code-only test sequence

- [x] Expand deterministic broker fixtures for FIFO/idempotency, personal priority, accepted/uncertain fleet work, persisted recovery, failed vault writes, cancelled acquisition and false exit proofs.
- [x] Run integration fixtures with actual production role adapters and injected transport/native handles. Assert permit → physical ownership → model order, separate control lanes and release → resume ordering.
- [x] Add native isolated fixtures for named-object ACL/squatting, current-SID versus cross-user mutexes, abandoned-object retention, suspended child assignment and keeper/watchdog failure. The isolated GUID-only `gpu_keeper_tests.cpp` now covers unsafe DACL/type squatting, current/foreign ACE policy, watchdog-first cleanup and two lost guardians with a surviving production watchdog. Actual foreign tokens, loss of every reference and logout remain W34; these native sources have not compiled or run.
- [x] Test malformed full GPU identities and mismatches between Python/native ordinal, LUID, driver and device fields; missing DirectML/unsupported GPU denies local inference with no CPU fallback.
- [x] Deliver bounded recovery records and trace diagrams for normal handover, aborted grant, session crash and logout. Record exact fixture commands/results separately from Win32 and real inference evidence.

### Deferred Windows acceptance and completion gate

- [ ] Prove actual standard-user Global mutex creation/ACL inspection without elevation, different-user and fast-session contention, and separate-adapter independence.
- [ ] Run app + shared Chrome + accepted fleet work against real DirectML. Record physical guard ownership and inference process/timing; demonstrate no overlap and no interruption of accepted fleet work during ordinary handover.
- [ ] Kill each guardian component with live inference descendants, then attempt a competing user/session acquisition. Require verified Job zero before any new permit; test simultaneous loss/logout separately and retain busy on unproven cleanup.
- [ ] Repeat after driver update/device removal/reboot with new qualification; record exact adapter identities. Do not claim all vendor/driver support from one GPU.

### Source completion gate

- [x] Mark W11 code-complete only after production factory/role integration and meaningful portable fault tests are complete. Native crash/ACL/DirectML proof remains explicitly pending W34; a keeper source file alone does not close this task.

### Primary references and their consequence

- [Mutex objects](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects): ownership is thread-bound and abandonment signals recovery, not safe inference handover.
- [Global kernel namespace](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces): use a fixed cross-session object; distinguish mutexes from privileged global file-mapping creation.
- [Job accounting/lifetime](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): retain handles and verify descendants, rather than relying on a parent PID or a single notification.
- [DXGI driver identity](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiadapter-checkinterfacesupport): query the supported interface's driver version; Direct3D device creation/qualification remains separate.
- [DirectML overview](https://learn.microsoft.com/en-us/windows/ai/directml): DirectX 12 compatibility is an initial hardware condition, not proof that this model/recipe passes strict GPU-only qualification. Keep the agreed Windows 10 support; do not switch silently to a different execution provider.

## Reboot and identity lease closure

- [x] Require current personal ReadyReceipt/configuration boot witness before
      model/permit creation; witness change with reused LUID fails closed. The
      [current checkpoint](../evidence/W07-W09-boot-witness-and-session-serialization-2026-10-09.md)
      also re-ran broker/session-admission and exact personal cleanup fixtures.
      Fleet overlays and actual reboot/keeper behavior retain their separate gates.

- [x] Bind live physical permits to current verified device/logon/process birth
      and release identity; never restore an old permit solely from a persisted
      LUID, matching brand or abandoned mutex.
- [x] Test restarted/reordered/reused-LUID device policy alongside injected
      cross-user guard contention; actual device/session execution stays W34. Rebinding cannot bypass whole-Job cleanup or accepted-work drain.
- [x] Join real broker/role/personal/fleet adapters in portable composed fixtures:
      uncertain claim/acquire reply, simultaneous Stop/event/release and broker
      restart. Actual WorkerRuntime uncertain-claim/drain fixtures execute separately;
      the role composition does not make live backend claims. Changed GPU, abandoned
      mutex and unknown tree proof are distinct
      recovery states; no successful logical lease substitutes for native proof.

## Completion record

- Implementation files and review: `main/admission/{current-gpu,broker-bank,gpu-broker,session-admission}.ts`, actual `agent/session-agent.ts`, personal admission/controller/runner and Backend current-GPU FleetRoleControl receiver; native isolated `gpu_keeper_tests.cpp` plus production completion seam. See B01–B12 for each boundary.
- Commands/results and evidence: current broad W11/W12 Desktop257 tests/34 files, worker scheduler/admission/DLL95/3 and Python personal/trimmer12 passed. The Desktop TSC following that slice reported only unrelated moving `session-state-store` literal fixture types; earlier owned slice154/17 plus whole TSC/full lint518/build/2boundaries passed. Exact follow-up and final checks are recorded in the linked matrix.
- Unrun native/toolchain checks: new isolated CTest source is not compiled/executed; all genuine Win32/GPU/multiuser/keeper acceptance remains W34.
- Current receiving closure: actual safe wait presentation passed 98 tests/12 files at 03:11:57; full shared Chrome passed 2,341 tests/four existing skips/83 files. Root subsequently passed 31 tests/five files for renderer/admission/localization, including truthful terminal GPU_BUSY retry text. Whole TypeScript, scoped lint24, source build and two boundaries passed after that return. The GUID-only GPU fault-test source exists but is uncompiled/unrun. W07 real upstream checks also pass independently. All actual Native/GPU acceptance remains W34.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
