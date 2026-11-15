# W08 automatic desktop Prepare lifecycle return

Source reviewed and portable checks executed on macOS, 2026-10-10. Native
ports and qualification are injected; no Windows installation, Electron UI,
DirectML inference, Chrome registry, model download or live account was tested.

## Production binding

[DesktopPreparationLifecycle](../../../windows-desktop/src/main/prepare/desktop-lifecycle.ts)
is called by [Main](../../../windows-desktop/src/main/main.ts), rather than being
an unused coordinator. Main supplies the actual captured PrepareController,
PrepareMaintenance, Host and maintenance gate through an immutable same-owner
port. Headless, closing, unavailable configuration, update/recovery work,
blocked maintenance and existing Prepare activity prevent automatic admission.
Manual actions suppress duplicate automatic startup.

Cold automatic preparation opens Setup once actual installation work begins.
Explicit user navigation remains authoritative. Authenticated warm inspection
keeps the saved page and does not trigger installation, full inventory verification
or qualification. Prepare remains independent of account and fleet enrollment.

Settlement awaits the original task and its captured maintenance owner before
rebind or approved fleet recovery. Every asynchronous rebind rechecks that same
owner and the closing fence. Replacement authority and shutdown cannot receive
late Ready/recovery callbacks. Unknown cleanup retains the exact original owner
and task; repeated failures remain bounded to one retained entry per owner.
Cancellation starts all distinct captured owners even if one throws synchronously.
Shutdown waits actual preparation and cleanup promises and keeps the safety fence
until their positive settlement; it does not wait its own pending-command count.

## Executed portable proof

[Lifecycle fixtures](../../../windows-desktop/tests/prepare-desktop-lifecycle.test.ts)
compose the real Controller, PrepareMaintenance and DesktopMaintenanceGate.
They exercise cold automatic startup, warm bypass, every automatic policy gate,
held Setup release, manual suppression, stale authority during rebind, shutdown
during a real stage, retained failed cleanup/retry and independent cancellation.

[Signed Operations composition](../../../windows-desktop/tests/prepare-composed-activation.test.ts)
also executes this production lifecycle through actual signed ZIP verification,
extraction, activation and authenticated cheap warm startup. Only native ports,
HTTP fixture transport and owned qualification are injected. Warm event counts
prove no additional download, full inventory verification or qualifier execution.
The complete file includes the signed archive with more than 8,192 entries.

- Lifecycle/controller/maintenance/admission/shutdown: **73 tests / 5 files
  passed at 02:44:42** after the final automatic Setup navigation change.
- Broader composition: **141 tests / 11 files passed at 02:46:21**, 54.33 seconds:

  ```text
  npm test -- tests/prepare-desktop-lifecycle.test.ts tests/prepare-composed-activation.test.ts tests/prepare-controller.test.ts tests/prepare-admission.test.ts tests/prepare-maintenance.test.ts tests/prepare-stage-recovery-matrix.test.ts tests/prepare-recovery-view.test.tsx tests/prepare-view.test.tsx tests/shutdown-coordinator.test.ts tests/desktop-ipc-transport.test.tsx tests/initialization-failure-view.test.tsx --maxWorkers=2
  ```

- Whole Desktop TypeScript passed. Scoped lint and formatting passed for the
  four changed source/fixture files. Source build and both renderer/preload
  package-boundary checks passed again during this status reconciliation.

Counts overlap. The earlier full 1,764-test Desktop checkpoint predates this
return; final combined regression remains W33 work.

## Deferred evidence

- [ ] Real supported Windows cold/warm startup, Setup UI and measured latency.
- [ ] Standard-user runtime/DLL/network/model/GPU preparation and repair.
- [ ] Actual native mutex, Job, DPAPI, HKCU/Chrome and logon/shutdown faults.
- [ ] Genuine approved release inputs, signed installer and connected W34 checks.

These source fixtures close the previously missing automatic Main orchestration
row in [the runtime/Prepare/readiness matrix](W06-W09-runtime-prepare-readiness-closure-2026-10-10.md).
They do not establish native or release acceptance.
