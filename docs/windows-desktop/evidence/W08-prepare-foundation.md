# W08 preparation implementation evidence

Date: 2026-10-09. Status: in-progress; production admission/registration and later Windows acceptance remain open.

## Implemented source

The Electron main process starts the preparation coordinator independently of account configuration and exposes only start/cancel/repair commands. The renderer displays actual stage, byte and disk information, indeterminate GPU progress, fixed safe errors and separate Chrome registration attention.

`windows-desktop/src/main/prepare/` implements a bounded checkpoint journal, per-user native mutex lease, signed consumer artifact verification, streaming ZIP planning/extraction, pinned model download, private atomic writes, model fingerprints, owned qualification process orchestration and DPAPI activation receipts. The fixed `src/agent/prepare.ts` entry validates its role/configuration, release inventory, SID, model and fixture before invoking the existing Python qualification module. Fleet qualification uses a separate backend-approved private fixture and does not replace personal readiness evidence.

The receipt binds SID, combined target identity, signed archive proof, release inventory, model, fixture, DirectML policy and qualification. Runtime proof is saved before the staging rename so interrupted installation can recover the exact verified inventory. A cancelled model download removes only its app-owned temporary file. Account credential deletion does not remove preparation identity or journal.

## Executed code checks

- Focused desktop tests: 72 passed across 9 files, covering preparation orchestration, signed metadata/receipts, real temporary ZIP/model streams, private host fixtures, headless UI and GPU broker concurrency.
- Full desktop test snapshot: 197 passed across 22 files.
- Desktop TypeScript check: passed.
- Scoped preparation/admission/main/host/renderer lint: zero warnings/errors.
- Two renderer/preload build-boundary checks: passed.
- Desktop build: passed; the shared pure diagnostic module removed the unused worker `import.meta` warnings in a later build. No Electron binary or UI was launched.
- Formatting was run on root-owned source and tests. Other agents continue editing their owned files; this record does not claim a final whole-component format pass.

ZIP tests use real temporary archive/file streams with simulated native destination validation. Model tests use bounded mock HTTP streams with real temporary file handles. Native host/mutex/DPAPI operations are simulated in these code fixtures. No runtime/model was installed on the development Mac.

## Remaining implementation

- The per-adapter native guard is connected to the owned qualification guardian. Six source fixtures cover guarded launch, fast exit, cancellation, missing reports, CPU rejection and teardown failure. Accepted-work maintenance handover still requires session-broker composition; do not call W08 complete.
- Finish Chrome native-host registration and replace the explicit unavailable registration port in main. A failure currently yields attention-needed, never registered.
- Complete bounded abandoned staging cleanup and repair of a corrupt installed release without touching active leased runtimes or user media.
- W09 ordinary startup receipt checks and offline reuse now have source implementation and evidence. Cross-process readiness/activation composition remains open.
- Supply actual Windows runtime/native/agent binaries and externally signed metadata through W31 packaging. No fabricated release URL, signing key, native binary or installed Ready state was supplied.
- Extend production adapter integration/fault fixtures as these dependencies land.

## Fresh runtime/model transfer integration — 2026-10-09

`WindowsPreparationOperations` now uses the sealed metadata-bound runtime source
and the private resumable transfer adapter. Source-bound unpacked/archive size
planning occurs before network I/O; actual ZIP planning is checked against the
declared expanded size before extraction. Model production transfer uses the
exact shared 66,759,214-byte/SHA pin with reviewed upstream redirects. Completed
private archives are removed after durable activation; packaged resources are
not deleted. `snapshotReady` and `snapshotMediaTools` caller APIs are unchanged.
The constructor adds only an optional sixth `{fetch?}` code-fixture seam.

The W06 checkpoint records **99 passing tests/nine files**, passing desktop
TypeScript/source build and scoped lint/format. Fixtures cover fresh bytes,
interrupted/ranged resume, validator/prefix/size/digest faults, private cache
publication, signed source binding and the exact-active offline expiry rule.
No real network runtime/model acquisition or Windows/GPU execution was run.
Maintenance/repair/journal/native packaging gates above remain separate; this
checkpoint does not close W08 or claim installed readiness.

## Deferred Windows work

Actual native compilation, installation, DPAPI/ACL behavior, DirectML execution, GPU handover, interrupted setup, browser registration and UI responsiveness require W34. All are unrun; fixture/build results are not Windows acceptance or a released installer.
