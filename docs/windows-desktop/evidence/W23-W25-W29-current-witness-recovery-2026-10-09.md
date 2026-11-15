# W23/W25/W29 current-witness recovery — 2026-10-09

Portable source/fixture evidence only. No Windows/native/GPU/installer operation,
backend enrollment, production permission, deployment or release was executed.

## Implemented boundaries

- Original fleet enrollment/report/credential/approval remains immutable. Local
  `active_runtime` v2 requires the actual current volatile user-hive boot witness.
  Fleet start, Advanced inspection and capacity use `readActiveFleetIdentity`;
  missing/legacy/stale witness refuses execution. Capacity host identity includes
  the witness, so old local two-slot evidence cannot authorize a new boot.
- Fresh approved-fixture qualification may rebind LUID/ordinal after a changed
  witness, or explicit unbound legacy migration, only with the exact originally
  approved stable hardware descriptor, model, fixture, recipes and signed runtime.
  This descriptor is not a persistent physical serial. Same-witness LUID changes,
  changed descriptors, stale/missing evidence and CPU dispatch remain denied.
  Actual current DXGI identity and volatile witness are rechecked immediately before publication. Old local capacity
  is deleted before the overlay is written; no extra backend capacity is granted.
- `refreshApprovedFleetRuntime` works without an app update or account login. It
  verifies the retained backend-approved fixture and original approved
  qualification, uses the owned guarded GPU runner and requires a real Prepare
  lease plus the caller's real idle/drain fence. It does not reenroll, rewrite the
  original report or call initial-report/activation endpoints.
- `createWindowsFleetRecovery` coordinates actual consumer activity, session
  maintenance and Prepare mutex. A protected bounded CAS journal binds machine
  authority, consuming Node birth, selected runtime/witness and old session birth.
  Lost retirement ACKs require durable supervisor idle/retired state AND exact
  process-birth exit. Node death alone is insufficient. Partial maintenance is
  cancelled; uncertain cleanup retains the journal/fence. Saved intent belongs
  solely to SessionState. Rebind is scheduled after Prepare release and command
  settlement, with no replacement role started while the old authority is held.
- `inspectWindowsFleetRecovery` is a read-only startup fence without account,
  model or GPU dependency. Missing state permits startup; unreadable/corrupt state
  stays fenced and is never reset.
- The updater separates attested installed byte/version metadata from operational
  Ready. Legacy v1/stale v2 can select fully verified signed installed runtime/model
  bytes without authorizing inference. Cold/unqualified installations freeze an
  app-only transaction, preserve truthful present/absent old runtime/model
  identities, stage only app bytes and do not automatically Prepare or qualify.
- Prepared rollback restores exact archived model bytes, then
  `WindowsPreparationOperations.requalifyInstalled` performs genuine fresh guarded
  PERSONAL-fixture qualification before publishing v2 Ready/current witness and
  the existing startup capsule. Activation time and sequence are preserved;
  downloads/registration/activation are not qualification shortcuts. A complete
  enrolled fleet is separately requalified against its approved fixture before
  operational rollback acceptance.

## Production APIs and composition

```ts
createFleetRecoveryMaintenancePort(host, native, sessionClient);
createWindowsFleetRecovery({
  host,
  operations,
  consumerActivity,
  maintenance,
  onSessionRetired,
});
// run(signal): Promise<"none" | "current" | "requalified">
// activity(), subscribeActivity(listener), close()
inspectWindowsFleetRecovery(host);
// Promise<{ recoveryRequired: boolean; invalidState: boolean }>
refreshApprovedFleetRuntime(
  {
    host,
    operations,
    prepareLease,
    transaction,
    runtimeIdentity,
  },
  signal,
);
WindowsPreparationOperations.requalifyInstalled(signal);
```

Production omits qualification fixture adapters. `onSessionRetired` closes captured
old handles and schedules rebind after `run()` settles; it cannot launch a new
session while Prepare is owned. The actual Main consumer gate includes cloud,
browser/playback/pins and pending writers. A no-op idle port cannot close
composition. Independent logged-in worker bootstrap may use low-level refresh
only under its own genuine no-session/tree-exit and Prepare/activation fences;
it must defer unresolved recovery journals. Source integration evidence for those
bindings belongs to W10/W24/W29 and is separate from this core checkpoint.

## Checks actually run

From `windows-desktop/`:

```sh
npx vitest run tests/update.test.ts tests/update-storage.test.ts tests/update-staging.test.ts tests/update-factory.test.ts tests/update-readiness.test.ts tests/update-installed-runtime.test.ts tests/update-installer.test.ts tests/update-trust.test.ts tests/update-startup.test.ts tests/update-desktop-lifecycle.test.ts tests/fleet-controller.test.ts tests/fleet-preparation.test.ts tests/fleet-recovery.test.ts tests/fleet-active-runtime.test.ts tests/fleet-update-preparation.test.ts tests/fleet-advanced-authority.test.ts tests/fleet-advanced-composition.test.ts tests/fleet-advanced-benchmark.test.ts tests/fleet-advanced-controller.test.ts
npm run typecheck
npm run lint
npm run build
```

Latest combined result at **21:44 Africa/Cairo: 19 files / 236 tests passed**.
The final exact-helper-birth Prepare-lease refusal and current-witness-at-publication additions then passed **22 tests / 2 files** at 21:46. Earlier full Desktop TypeScript passed; lint found **0 warnings/errors across 426 files**;
source build and a scoped Prettier check of 22 affected source/test files passed.
An earlier broad run found one missing newly required witness fixture in
`fleet-preparation.test.ts`; truthful Ready/result/native witness fields were
added and the final run passed. Earlier 234-test and 74-test checkpoints remain
historical, not separate native evidence.

Factory fixtures execute the real controller, protected-state emulation,
generated test signatures, temporary model/backup byte hashing and lifecycle
ordering. Native, DirectML, runtime inventory and installer/session boundaries
use explicit fixture adapters. Direct requalification tests exercise the actual
method with bounded model-file/guarded-runner adapters: fresh result before Ready,
restored file identity, valid legacy migration, changed witness/bytes and CPU
output refusal. Recovery fixtures cover partial acquisition/cancellation failure,
concurrent commands, lost retirement ACK, controller death/new witness, original
approval preservation, exact helper/Node birth, corrupt journal and read-only
startup fencing. This is not actual DirectML/Win32 filesystem proof.

## Deferred acceptance

- [ ] Record finished Main recovery and independent logged-in bootstrap source
      bindings, with pending/corrupt journal fencing and original saved-intent restore.
- [ ] Compile/run Win32 boot-hive witness, DPAPI/cache/Prepare/session mutexes,
      exact Job-tree stop/keeper and process-birth exit on Windows 10 22H2 x64 and
      Windows 11 x64.
- [ ] Run real DirectML reboot/hive-unload/driver/adapter-change, same-witness LUID
      denial and backend-approved fixture qualification.
- [ ] Run signed app-only/prepared updates, exact old-model rollback, lost ACK,
      controller crash/reboot, NSIS monitor certificate/open-file/antivirus faults.
- [ ] Perform separately authorized backend enrollment/revocation/release checks.

The final full typecheck after the exact-target addition encountered concurrent
native SDK `consumer-native.ts` lines 80–81 type narrowing errors; its owning agent
was notified. This intermediate failure remains historical; the subsequent actual
full typecheck at 21:45 passed after the owning agent's correction.

Historical evidence counts and every native/live/release acceptance checkbox
remain unchanged. Overall W23/W25/W29 closure is not claimed here.

The final post-publication-guard check at 21:47 passed full Desktop TypeScript,
source build and scoped Prettier. Full lint then encountered one concurrent,
peer-owned `tests/library-controller.test.ts` unused `localTrackId` import
(427 files); its owner was notified and that check is not reported as passing.
The earlier actual 426-file zero-warning lint pass remains historical.

## Desktop retirement adapter — 21:51 checkpoint

`createDesktopFleetRecoveryActivity(gate, retireCallback)` returns
`{consumerActivity, commit, finishCommitted, ownsReservation}`. It uses the real
`DesktopMaintenanceGate` with exactly one accepted pending command. Uncommitted
maintenance releases normally. A commit attempt is marked before its asynchronous
retirement, pending/successful commits deduplicate, and failed/uncertain retirement
retains the exact intake fence. Same-transaction retries keep that proof;
unrelated transactions are refused. The coordinator's post-retirement release
only marks its lane settled; `finishCommitted` requires confirmed commit, released
coordinator lane and matching reservation, and is called only after the protected
journal is clear and command has actually settled. An old adapter cannot clear a
later transaction's gate.

The startup inspector now requires only `Pick<HostContext,"native"|"identity">`,
so an independent logged-in bootstrap can check its protected journal without
constructing account metadata or a fabricated HostContext.

The real gate/lifecycle plus coordinator slice passed **33 tests / 4 files**;
full Desktop TypeScript, lint **434 files / zero warnings/errors** and source build
passed. No native helper or account/backend operation was executed. Read-only Main
review identified one remaining composition risk: a failed rebind settlement must
retain its own intake/retry fence even after the domain journal is clear and
ConsumerUpdateLifecycle releases busy. This was reported to Main's owning task;
no Main source was changed here. Source bindings/native acceptance remain separate.

## Approved secondary adapter and PERSONAL alignment — 22:13 checkpoint

An existing original/active fleet proof is operational only when its actual current
DXGI stable descriptor, LUID, driver and boot witness match. `readOperationalFleetIdentity`
performs these checks and resolves the actual current ordinal by stable LUID;
ordinal reorder alone does not authorize different hardware or require reenrollment.
Driver/adapter changes cannot return `current` from the recovery coordinator.

`readApprovedFleetGpuSelection` derives trusted selection from the latest validated
active proof's witness/LUID, otherwise the immutable original. An older original
witness cannot relax a newer current-witness overlay. Same-witness LUID replacement
is refused. Only explicit fresh cross-witness/unbound migration permits a new LUID
for one exact originally approved stable descriptor; multiple indistinguishable
adapters remain ambiguous and fail before model launch.

`PreparationQualificationRunner.run(release,signal,fixture?,selection?)` adds the
optional fourth trusted `TrustedPreparationGpuSelection`:
`{approvedGpu,expectedBootIdentity,allowLuidRebind}`. It selects exactly one ACTUAL
native enumerated adapter before acquiring the physical guard or writing/spawning
the fixed child config. A larger personal-ranked primary cannot replace the approved
secondary. No Renderer/Chrome ordinal is accepted; existing callers retain automatic
ranking. Missing/changed/ambiguous candidates or a mismatched witness fail closed.

`WindowsPreparationOperations.requalifyInstalled(signal,selection?)` also accepts
this trusted selection for actual guarded PERSONAL fixed-fixture qualification.
`refreshApprovedFleetRuntime` and coordinator operations ports now require that real
method in addition to `snapshotReady`; there is no production no-op fallback.
When PERSONAL Ready selected another GPU, recovery holds genuine Prepare/session
idle fences, aligns PERSONAL using the same signed runtime/model and its fixed app
fixture, and then qualifies the original backend-approved fixture when fleet proof
needs renewal. A still-current fleet proof only needs real PERSONAL alignment.
This keeps W11's single-GPU broker coherent and never substitutes the personal
fixture for backend approval or rewrites enrollment/credentials/saved intent.

`QualificationCleanupUnconfirmed` is an internal typed error for failed exact
engine-tree stop, physical guard release or helper close. Such failures return no
qualification receipt. Consumer recovery retains a durable `fencing-uncertain`
phase and its Prepare/session/intake authority; a subsequent ordinary BUSY cannot
clear it. A genuine completed fresh guarded/tree-confirmed operation can settle it.
The independent login bootstrap must apply its own actual exact-tree proof before
releasing activation/Prepare on this error.

The Advanced Doctor regression was fixture drift: its protected host adapter lacked
the newly mandatory native boot witness. The fixture now supplies the real bound
synthetic witness and explicitly refuses a stale witness and changed driver;
Doctor's production checks were not weakened.

Checks actually run from `windows-desktop/`:

```sh
npx vitest run tests/qualification-runner.test.ts tests/fleet-active-runtime.test.ts tests/fleet-update-preparation.test.ts tests/fleet-recovery.test.ts tests/fleet-advanced-inspection.test.ts tests/update-readiness.test.ts tests/fleet-desktop-maintenance.test.ts tests/maintenance-gate.test.ts tests/update-desktop-lifecycle.test.ts tests/update-factory.test.ts tests/fleet-advanced-authority.test.ts tests/fleet-advanced-composition.test.ts tests/fleet-controller.test.ts tests/fleet-preparation.test.ts tests/readiness-cache.test.ts tests/prepare-records.test.ts tests/prepare-controller.test.ts
npm run typecheck
npm run lint
npm run build
```

Result: **215 tests / 17 files passed at 22:12**. The final shared cleanup-wrapper
follow-up passed **24 tests / 2 files at 22:13**. Full Desktop TypeScript, source build,
lint **436 files / zero warnings/errors** and scoped formatting passed. Three
intermediate no-unsafe-finally lint warnings were corrected through the shared
cleanup-proof wrapper; none remain in the successful lint checkpoint.

These tests use explicit native/guard/runner adapters and temporary protected-state
emulation. They prove selection, ordering, error retention and parser boundaries,
not actual DirectML/Win32/DPAPI/publisher or physical GPU identity. Actual secondary
GPU, driver/reboot, ambiguous adapter, cleanup/keeper and independent-login proof
remains deferred until authorized W34 machine acceptance.

The source was then frozen for the final combined run. A subsequent full typecheck
at 22:14 encountered the Native task's in-progress `LoginWorkerPorts` additions:
`prepareTreesIdle`, `cleanupUncertain`, `recoverUncertainCleanup` were missing from
its `login-worker-runtime.ts` composition and `session-login-worker.test.ts`
fixture. The source build and owned formatting still passed. These peer-owned
intermediate errors are recorded honestly; this checkpoint does not claim the
latest whole-tree typecheck or login bootstrap passed.
