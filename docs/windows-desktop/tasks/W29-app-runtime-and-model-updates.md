# W29 — Implement signed updates and coordinated rollback

- Status: code-complete / Windows pending (production source and portable checks complete; native/live/signed-release acceptance deferred).
- Code dependencies: [W06](W06-runtime-and-model-package-layout.md), [W09](W09-startup-and-readiness-receipts.md), [W11](W11-gpu-admission-and-handover.md), [W20](W20-background-account-saving-and-outbox.md), [W21](W21-verified-cache-and-community-reuse.md), [W22](W22-storage-budget-and-cleanup.md), [W24](W24-worker-controls-and-saved-intent.md), [W26](W26-chrome-native-host-and-registration.md).
- Accepted scope points: P07, P21, P27, P29.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [W29 consumer update core](../evidence/W29-consumer-update-core.md); code evidence only, native/release acceptance deferred.

This task document does not itself authorize updates or source execution. Follow the latest user instruction; after implementation is authorized, complete code/fixture work without a Windows connection. Actual installer execution, native activation and publication remain separate deferred operations.

Checked implementation/code rows refer to the actual receiving production source and meaningful portable tests in the [final source closure matrix](../evidence/W23-W24-W25-W29-final-source-closure-2026-10-09.md). Actual Windows/live/release acceptance remains unchecked.

## Existing behavior and design consequence

Existing manifests/rollback mechanisms are reusable, but a consumer update must coordinate UI, Chrome, personal and fleet leases without invoking elevated service maintenance or losing durable state.

## Read before editing

- [chrome-extension/macos/DesktopUpdater.swift](../../../chrome-extension/macos/DesktopUpdater.swift)
- [worker/src/platform/windows/release-manifest.ts](../../../worker/src/platform/windows/release-manifest.ts)
- [worker/src/platform/windows/update-plan.ts](../../../worker/src/platform/windows/update-plan.ts)
- [worker/src/platform/windows/user-updater.ts](../../../worker/src/platform/windows/user-updater.ts)
- [worker/src/platform/windows/active-release.ts](../../../worker/src/platform/windows/active-release.ts)
- [chrome-extension/docs/setup-updates.md](../../../chrome-extension/docs/setup-updates.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

For the sequential execution order, checkbox rules and current partial-source gaps, read [execution plan](../EXECUTION-PLAN.md), [feature acceptance](../FEATURE-ACCEPTANCE.md) and [resume gaps](../RESUME-GAPS.md).

## Implementation checklist

- [x] Define independent app/runtime/model version and compatibility policy, signed channel metadata and immutable artifact identity. Preserve separate consumer versus legacy-service release targets.
- [x] Implement optional automatic update discovery and explicit installation controls with clear required/optional policy behavior. Update discovery is not permission to replace active files or enroll/start work.
- [x] Verify trusted signatures, expected publisher/artifact inventory, hashes, sizes and safe URLs before activation. Protect against rollback/replay except through an explicit authorized recovery policy.
- [x] Acquire maintenance leases across app, Chrome, personal engine and fleet. Drain accepted work, preserve saved intent and outbox/cache pins, and never overwrite an executable/model still in use.
- [x] Stage updates per-user, journal every transaction boundary and atomically switch compatible releases. Run bounded health checks, invalidate readiness/qualification as needed and roll back after failure.
- [x] Preserve account vaults, worker identity, Library, preferences, outboxes and registration during normal replacement. Repair stable launcher/Chrome paths idempotently.
- [x] Bound rollback/archive retention and cleanup only after safe confirmation. Handle disk-full, antivirus/open-file denial, interrupted logout/reboot and incompatible schema transitions with actionable recovery.

## Code validation checklist

- [x] Fault-test signature/hash/version/profile mismatch, manifest replay, partial downloads, every activation journal boundary and health-check rollback.
- [x] Test concurrent personal/Chrome/fleet leases, accepted jobs, pending account save, Windows open-file errors and intent restoration.
- [x] Run package/update fixtures using temporary directories; distinguish fixture success from Authenticode/native activation proof.

## Windows acceptance — deferred until W34

- [ ] Perform actual signed app/runtime/model updates and failed-update rollback on Windows while consumers are idle and active.
- [ ] Verify interrupted update recovery, preserved data/credentials, rebuilt registration and correct GPU requalification without elevation.

## Detailed AI-agent handoff — reviewed 2026-10-09

### Current production source and validation boundary

The consumer transaction, exact old-model archive/retention, immutable active-fleet resolver/refresh and native installer certificate consumption are implemented in [update modules](../../../windows-desktop/src/main/update/) and [update contracts](../../../windows-desktop/src/shared/update-contracts.ts). Actual Main activity/startup/recovery/quit/rebind and localized UI now bind those factories. Cold app updates retain absent runtime/model/Ready without Prepare or GPU. Optional catalog trust and signed package resource grammar are implemented; approved real release inputs and actual Windows/native/installer/GPU acceptance remain open. The final closure matrix distinguishes tested code, reviewed receiving source and deferred native proof.

The earlier source gaps are addressed by retention reservation before packet writes, immutable exact old model archives and a separately validated local active-runtime overlay that preserves original backend approval. Later closure added shared Advanced dispatch/recovery/Force, separate signed consumer catalog selection and installed-source loading through actual PreparationOperations. Checked source rows are mapped to portable tests; actual native behavior remains unchecked below.

### Component boundaries

| Layer                       | Responsibility                                                                                      | Must preserve                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Signed channel metadata     | Independent app/runtime/model versions, compatibility, artifact identities and anti-replay sequence | Consumer `windows-user`/AMD64 target and approved signing/URL trust              |
| Update transaction          | Explicit install, staging, preservation, maintenance, activation, health, rollback and retention    | Atomic durable state; no live-file replacement before proven idle                |
| Prepare/session             | Full verified inventory/GPU qualification and exact activation/bootstrap                            | Ordinary warm launch remains a cheap receipt check                               |
| Native installer port       | Fixed private verified installer, Authenticode/publisher/asInvoker checks and fixed destination     | No arbitrary executable/args, elevation or app-controlled machine install        |
| Fleet preparation / backend | Original approved machine capability and new local active-runtime proof                             | Machine IDs/credential, accepted work, approval policy and stopped/paused intent |
| Library/outbox/storage      | Actual process pins, captured copies and account fences                                             | No data/token/identity loss or stale-account reassignment                        |

### Ordered implementation/review sequence

- [x] Inventory the existing update/runtime-manifest paths before editing. Keep app, runtime and model versions/compatibility independent; reject service-profile payloads, unknown schema upgrades and unsupported target architectures. Preserve the minimum Win10 22H2/native AMD64 contract.
- [x] Validate exact signed channel schemas, canonical bytes, trusted key, immutable sequence→hash binding, pinned HTTPS origins, content type, size and hashes. An installer artifact hash and logical app payload identity must be separate to avoid a circular self-hash. Bound metadata and rollback history.
- [x] Require approved package resources for feed/keys/origins/publisher and current app payload identity. Missing resources return Update unavailable. Optional discovery defaults off; explicit installation, rather than discovery, starts a transaction. Do not invent production feed/artifact URLs or keys.
- [x] Define timestamp/expiry/replay recovery precisely. New activation needs current trusted metadata; an expired record is usable only for the exact already activated DPAPI-bound target or journal-bound prior rollback, preserving the highest accepted sequence.
- [x] Stage immutable verified artifacts through the existing bounded downloader and private native path checks. Reserve disk budget for staged plus rollback bytes; handle redirects/inactivity/abort/length/hash failures. Never execute a partially downloaded installer or unpack an unverified archive.
- [x] Reserve retention/index capacity atomically before creating backup packets; journal each boundary and roll back partial backup writes. Retain bounded known transactions/previous targets and report Cleanup pending when the limit is reached. Prevent a fourth untracked orphan backup when the three-entry source limit is already full.
- [x] Snapshot exact prior active release/bootstrap/startup/config/Ready state and any locally refreshed fleet preparation state needed for rollback. Preserve secrets in their original protected namespace; do not copy credentials to logs/browser/renderer or duplicate them unnecessarily in backup records.
- [x] Preserve the exact old model blob at an immutable hash-bound location before changing the active model. A backup receipt alone cannot restore overwritten `models/<filename>` bytes. Verify model/runtime/app compatibility against the real runtime loader; an app's pinned model constant cannot authorize different bytes silently.
- [x] Acquire the current-user Prepare mutex and authenticated session maintenance fence. Block new personal/Chrome submissions, drain accepted/uncertain fleet work, preserve outbox/captured copies and Library/media pins, then prove exact owned-role Jobs and GPU activity idle. Timeout returns busy/pending without force-cancelling accepted work.
- [x] For app replacement, verify actual Authenticode trust, exact approved leaf publisher pin, hash/size, `asInvoker` manifest and fixed per-user destination before typed independent launch. Accept a signed x86 NSIS wrapper only when the installed payload/helpers are x64 and actual native host support is enforced. No generic shell or arbitrary `/D` destination.
- [x] Journal restart-required before quitting the UI after installer-start acknowledgement. Keep installer lifetime independent of the closing UI helper; the next app resumes the same protected transaction. Await exact old agent exit before starting the new control authority, and retain whole-Job cleanup proof separately.
- [x] Activate runtime/model through full signed Prepare verification and guarded selected-GPU qualification, then repair verified stable launcher/Chrome resources and publish matching activation/Ready receipts. Ordinary startup must not rerun model inference or full model hashing.
- [x] Implement an approved fleet refresh/recovery adapter: preserve original backend-approved capability identity and credential, requalify the relevant approved fixture under the new active runtime, bind a separate local active-runtime proof, invalidate stale capacity receipts, and restore prior local/fleet state on rollback. Coordinate W23/W25/backend policy review before choosing a server lifecycle change.
- [x] Do not call the initial enrollment report/fixture upload as a fabricated activated-worker refresh. Current backend report/grant/confirm paths accept restricted/reported installations, not active installations. Never rewrite an old report to claim new runtime approval or auto-reenroll the machine.
- [x] Run concrete health checks for verified runtime/bootstrap, current adapter qualification, session release, browser registration and fleet readiness. Resume only previously allowed fleet intent after a successful health result. Failure restores the exact authorized previous target and data, while preserving the anti-replay floor and explicit recovery state.
- [x] Bound archives/backups/quarantine and remove only app-owned obsolete signed release trees proven unused under the maintenance lock. Open files, unknown ownership or absent tree proof preserve data and return cleanup pending. Library, preferences, account credentials and outboxes are never ordinary release-cleanup targets.

### Fault/transaction matrix

| Fault boundary                                                                    | Required assertion                                                                                         |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Metadata signature/profile/sequence/URL/publisher mismatch                        | Fail before download/launch/activation; do not lower sequence floor                                        |
| Download abort/disk-full/antivirus file denial                                    | Preserve prior release/data; bound partial scratch and recover idempotently                                |
| Backup limit full or process exits midway through packet/index writes             | No untracked unlimited backup; reserve or rollback exact partial records                                   |
| Personal job, browser playback pin or accepted fleet claim appears during staging | Maintenance proof, not earlier idle observation, decides activation                                        |
| Old authority acknowledges retire then remains alive                              | Wait exact process exit; do not connect accidentally to stale release                                      |
| Installer succeeds but new runtime/model qualification fails                      | Roll back exact signed prior app/runtime/model bytes and activation state                                  |
| Updated model uses the same filename as the previous model                        | Old blob remains restorable by hash; no destructive overwrite masquerading as rollback                     |
| Active fleet report binds the old manifest digest                                 | New local runtime proof/approved lifecycle required; preserve IDs/credential, do not fake backend approval |
| Logout/reboot occurs after any journal boundary                                   | Resume or safely roll back that boundary without duplicate install/start/enrollment                        |
| Revocation service unavailable, changed signer or unknown open executable         | New installer unavailable/blocked; no silent trust weakening or forced deletion                            |

### Code-only validation and deliverables

- [x] Extend strict metadata/replay/compatibility fixtures and controller fault tests across every journal boundary, including cancellation after fencing and exact previous-target recovery.
- [x] Test the concrete production factory with temporary directories and injected download/native/session adapters. Assert actual preservation pins/outboxes, archive model restoration, backup reservations, fleet active-proof refresh/rollback and correct registration resources; generic no-op ports are insufficient.
- [x] Test exact old-agent process waiting separately from owned-tree proof, restart-required recovery, installer launch failure and UI helper closure. Include signed x86 NSIS wrapper + x64 payload fixtures and rejected elevated manifests.
- [x] Test staged/backup/release cleanup with unknown files, reparse/hardlink attempts, case/ADS names, open files and crashed current consumer; no recursive deletion of unrelated roots.
- [x] Run focused update/session fixtures, worker native-wrapper checks, desktop typecheck/scoped lint/format/build and package trust fixtures after source changes. Record native signing/execution separately.
- [x] Deliver the signed channel/resource schemas, concrete activation/health/rollback adapter, preservation/retention inventory, approved fleet-refresh decision and exact fixture/native test record. Never substitute an abstract port for an unfinished production operation.

Historical planning checkpoint: 56 session/update fixtures passed across five files; this is not factory end-to-end, Authenticode or actual update proof. The older typed-lease mismatch was later corrected. Later concrete factory/source/retention/installed-loader and Main composition checks are recorded in the final matrix. No real installer, update feed/artifact or native release deletion was used by these code checks.

### Deferred Windows acceptance

- [ ] Perform real signed per-user app/runtime/model updates and rollback from exact prior installer/model bytes on Win10 19045 and covered Win11 targets without UAC.
- [ ] Exercise active personal/Chrome/fleet work, accepted-job drain, browser playback pins, account outbox copies, interrupted logout/reboot, antivirus/open-file denial and disk exhaustion in authorized temporary profiles.
- [ ] Verify native signature/publisher/timestamp/revocation behavior, independent installer lifetime, startup/registration repair, exact new-agent release and real strict DirectML requalification.
- [ ] Verify original machine identity/approval/credential and saved intent survive successful update and rollback; new local proofs must reflect actual runtime/GPU, with stale capacity receipts invalidated.

### Primary references and their consequence

- [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater): built-in Windows mechanisms depend on package format; a custom NSIS transaction is not automatically the built-in Squirrel/MSIX updater.
- [WinVerifyTrust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust) and [WINTRUST_DATA](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_data): trust success is exactly zero; close verification state, suppress UI and specify revocation/cache policy explicitly. Publisher pinning remains an additional check.
- [NSIS installer command line](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage): `/D` has special last/unquoted semantics; the project must enforce its fixed destination rather than accept arbitrary caller-controlled installer arguments.

## Concrete factory and headless-consumer closure

- [x] Include UI/headless account authority, app proxy, all origin-bound media
      grants and their process/pin lifetime in maintenance. An invisible authority
      can retain an executable or media FD and is not implicitly idle.
- [x] Define one validated active-fleet identity resolver used by launch, Doctor,
      Advanced, capacity and benchmarks. Keep original backend report/credential/
      approval immutable; local overlay binds new runtime/model/GPU/approved
      fixture, invalidates old capacity and rolls back atomically.
- [x] Test actual factory adapters for backup reservation before writing and exact
      old-model blob restoration. No-op transaction ports cannot prove these paths.
- [x] Reject a new model incompatible with the currently pinned app/engine or
      coordinate an approved app/runtime/model transition; do not accept a receipt
      for bytes the compiled model pin rejects.
- [x] Test update while headless cloud/media is active, retirement reply/old-peer
      exit races and rollback with saved Stop/Pause, Library and outbox preserved.
- [x] Follow the cycle-free integration sequence: W29 schemas/loader/factory,
      W31 approved package resources, W29 concrete activation/fleet proof, then W32
      policy/distribution closure. Missing public inputs stay honest prerequisites.

## Completion record

- [x] Add configured updater initialization and independent protected read-only
      startup inspection before automatic Prepare/session activation. Pending,
      corrupt/oversized/invalid UTF and missing configuration remain fenced;
      no-state cold startup remains available. This cannot authorize a cached
      target, install, clear state or invent recovery success.
- [x] Require native positive consumer whole-role inference proof before stopped,
      uncertain scratch cleanup/replacement and permit release; preserve all-slot
      stop ordering, active GPU evidence and legacy omitted-hook behavior.
- [x] Review actual Main startup/idle-event recovery/settlement ordering and test the production loader/controllers/entry/IPC/lifecycle boundaries with portable fixtures; passive attach and pending/corrupt/configless fencing are preserved.
- [ ] Exercise Windows recovery/whole Job census/keeper/installer locks/live media authority on the connected supported target.

- Implementation files and review: updater metadata/loader/controller/factory/storage/staging/retention/model archive/installer/lifecycle/Advanced dispatch; immutable fleet active/recovery modules; native certificate and actual Main/preload/UI receiving graph, mapped in the final closure matrix.
- Commands/results and evidence: preserve historical 56 and later 273 Desktop/95 worker checkpoints; final matrix records subsequent focused checks and any intermediate failure instead of treating old totals as current hardware proof.
- Unrun native/toolchain checks: native compilation/signing/WinVerifyTrust, real signed app/catalog update/rollback, NSIS/monitor/Job/ACL/AV/open-file faults, actual GPU/boot/driver qualification and live fleet/backend behavior.
- Remaining limitations and next task: W31 approved signed package/feed/catalog inputs and W34 actual supported Windows acceptance. No production feed/URL/key was invented by source implementation.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Implemented source checkpoint — 2026-10-09

- [x] Reserve bounded rollback retention before packets/blobs; exact independent old-model bytes are hash-verified, fsynced, restored before receipts and rebound to the new real file identity.
- [x] Preserve immutable original fleet approval and consume one current validated active-runtime/model/GPU/approved-fixture resolver from fleet start, Doctor and capacity/benchmark context; no activated initial-report endpoint or automatic reenrollment.
- [x] Retire exact old session authority before new model/bootstrap mutation, retain fail-closed consumer activity/maintenance requirements, and defer Main rebind until target health or verified rollback.
- [x] Consume native at-most-once installer monitor/certificate status and bind full fixed pin/nonce WAL; missing/unknown/running authority never proves completed installation or permits duplicate launch.
- [x] Support signed app-only update before Prepare with explicit absent runtime/model identities, selected artifact-only staging, truthful required-update policy and no model/GPU side effect.
- [x] Gate staged monitor removal on exact native completed/monitor-exit proof and authorize nested installer assistance from the signed protected transaction/WAL plus actual issuer certificate. Never reacquire the update's own Prepare/session lease or infer an installer completion from absent PID.
- [x] Run portable fault/regression/type/build/lint/format checks recorded in [W29 evidence](../evidence/W29-consumer-update-core.md): historical 273 Desktop/95 worker and earlier 268/94 counts remain dated checkpoints; the final matrix records later source validation.
- [x] Revalidate actual Main consumer activity/startup recovery/quit/rebind composition, including cold UI, browser/headless cloud playback and pending durable completion/account save.
- [ ] Close actual signed Windows installer/native/GPU/fleet update and rollback acceptance after W31 package prerequisites and the connected Windows machine.

## Current-witness metadata-only update and rollback checkpoint

- [x] Separate fully attested installed metadata from operational Ready, preserving real prior runtime/model identities in a frozen app-only plan for cold/stale-witness/current-GPU-denied installation.
- [x] Requalify exact restored model/runtime bytes before publishing current-witness Ready/capsule; valid legacy v1 metadata can migrate only through fresh guarded qualification. Separately refresh an enrolled fleet against its original approved fixture.
- [x] Bind production fleet recovery return and independent logged-in bootstrap with real idle/Prepare/activation fences; selected approved secondary adapter aligns PERSONAL and original fleet fixture proofs before resuming only saved intent.
- [ ] Prove every signed native/update/GPU acceptance case on the connected supported Windows targets.

See [current-witness source and portable evidence](../evidence/W23-W25-W29-current-witness-recovery-2026-10-09.md). The stable hardware descriptor is not a persistent physical serial; no missing witness is inferred, original backend approval remains immutable, and native/live/release boxes remain open.

## Separate consumer catalog and Advanced integration closure

- [x] Load optional separately sealed `worker-catalog-update-channel.json` using the existing full consumer metadata/trust schema and same publisher/profile/sequence discipline. Missing catalog is unavailable, not app-channel or legacy-service fallback.
- [x] Freeze catalog/app source and descriptor in the same durable transaction/recovery. Catalog keeps the exact installed app identity, stages runtime/model only and requires actual operational qualification; it never launches an app installer or silently approves new hardware.
- [x] Resolve authenticated protected installed catalog metadata before the unchanged app's older packaged runtime. Actual Main Operations uses the installed loader and refreshes its target after settled health/rollback before rebind; retained login capsule carries approved catalog trust. Real Operations tests reject corrupt/missing trust without fallback and keep stale-boot Ready denied.
- [x] Keep repair source URLs/redirect origins derived only from verified signed metadata and sealed trust. Consumer metadata attests archive bytes rather than expanded size; unknown expansion uses the existing bounded ZIP ceiling and actual verified archive scan, not a fabricated exact size. Expired installed metadata never grants new network repair.
- [x] Carry reviewed force only through exact protected Advanced owner/transaction/revision context; actual Native Session receiver owns exact fleet escalation. A pre-effect stale confirmation is distinct from uncertain ACK/tree cleanup and cannot waive personal idle proof.
- [x] Authorize pending Advanced update recovery only through matching protected updater transaction/machine authority/source/signature proof and existing controller. Cancellation and final journal/finally settle before app-handle retirement/rebind; no self-await or parallel lifecycle is introduced.
- [x] Review every implementation/code/detailed/retention/factory/deliverable requirement against the final entry/source/proof/native matrix. Real Windows/live/release prerequisites remain open.
