# W29 consumer update and active-fleet core — code evidence

Date: 2026-10-09. Environment: macOS source workspace, installed component tooling; no Windows machine, native compilation/execution, installer invocation, real GPU/model inference, enrollment, deployment or publication.

## Scope implemented

- Packaged feed/key/publisher, app identity, native manifest and initial runtime metadata reads repeat the ASAR-sealed resource binding; Electron production cannot fall back to an unconfigured sidecar. Private installed runtime/model/DPAPI proofs keep their existing verification.
- Signed independent app/runtime/model target metadata, stable consumer profile, sequence/identity replay fences and explicit discovery/install/recovery remain separate. Installed components use real nullable runtime/model identities; complete signed targets remain nonnullable. A cold app update is app-only: no runtime/model transfer, Prepare, GPU qualification, fictitious Ready or placeholder SHA. Existing unqualified model bytes remain untouched.
- Backup retention is reserved before any packet or model copy. Immutable exact old model bytes are streamed, hashed, independently copied, fsynced and verified before replacement. Partial capture remains tracked within the three-entry bound. Restored Ready binds the actual restored file identity; explicit verified rollback recaptures the existing startup capsule without inference.
- A required consumer-activity authority fences new cloud/browser/file intake and proves real consumers idle. Session maintenance drains role work; its actual authority commits retirement and exact PID/birth exit **before** installer/model/bootstrap mutation. The retired-session callback closes the captured old handles and schedules rebind only after the updater command and Prepare lock settle. No missing authority becomes successful idle.
- Native installer inspection/recovery now supplies the exact fixed pin, monitor/process birth, nonce and observed whole-tree completion. App WAL is bounded v3; same-pin launch is at-most-once. Lost ACK is adopted only from a native certificate. Missing/unknown certificate, different nonce, still-running tree or uncertain old-session exit retain fences. Completed zero exit alone does not prove the current app payload or runtime healthy.
- The independent native monitor runs from its fixed protected staging copy. Cleanup calls `removeCompletedInstallerMonitor` and waits exact monitor-birth exit plus certified installer-tree completion before superseding the certificate or clearing staging; Node never unconditionally deletes the monitor executable.
- Nested installer assistance uses `authorizeConsumerInstallerAssistance` to intersect the protected live activating/restart-required transaction, original signed metadata, full WAL pin and exact running native issuer/nonce. The launching/null-nonce window is accepted only with the actual matching certificate. Unknown, completed, foreign-birth or mismatched authority cannot acquire assistance; it never relaunches an installer.
- Original fleet credential/report/backend approval remains immutable. A separate bounded DPAPI `fleet/active_runtime` proof binds the current release/archive/manifest/model to a new qualification of the original approved fixture and approved recipe digests. Current physical GPU/driver and Ready must match. Initial enrollment report/grant/confirm is never fabricated as an active-worker refresh.
- Fleet start, Doctor/inspection and capacity/benchmark context consume the same active-identity resolver. Changed machine authority retires stale overlay/capacity only after the new enrollment write succeeds. A replacement machine cannot inherit the prior proof. Qualification invalidates stale capacity; local evidence alone never grants two workers.
- Once target health has passed, an uncertain Main rebind/finalization retains the health-check journal/fence and reports `UPDATE_FINALIZE_UNCONFIRMED`; it never restores a model underneath a potentially started target authority. Recovery retries verified finalization without repeating activation. Complete is persisted only after the actual maintenance/activity commit.
- The completion producer exposes truthful event-driven activity and waits actual reconciliation/pin cleanup on disposal, so Main can retain the Host/helper during pending durable account capture.

## Production API and composition requirements

`createWindowsConsumerUpdater({host, resourcesRoot, native, session?, consumerActivity, onInstallerStarted, onSessionRetired, fetch?})` returns `ConsumerUpdateController`.

`consumerActivity.acquire(transaction, signal)` is required and returns `assertIdle(signal)`, `release()` and `commit()`. Main must fence **all** real account/proxy/cloud/browser/media/file/outbox producers, await actual consumer quiescence/exit and keep its Host plus independent update helper alive until protected cleanup. This source does not supply a no-op activity implementation.

Ordering: stage → preserve consumers → consumer activity fence/idle → session maintenance idle → reserve/capture exact backup → durable activation checkpoint → actual session retire/exact exit → installer or runtime/model qualification/activation → current signed identity/Ready/DXGI/fleet/browser health → retired-session notification/deferred rebind → activity commit → bounded cleanup. A restart-required transaction retains durable intake protection and resumes before enabling ordinary app/Chrome submissions. The callback must not open the replacement session while the factory holds Prepare/session authority; Main rebinds after the command settles.

`authorizeConsumerInstallerAssistance({host, resourcesRoot, native, receipt:{issuer, certificateNonce}, signal})` returns the exact `{transaction, identity}` or `null`. Main uses the native-verified receipt to reassert its existing update activity lease and acknowledge the nested fixed installer request; it does not reacquire the updater's Prepare/session lease or wait on its own in-flight updater command.

Cold recovery accepts the actual new packaged app only after the native installer certificate proves completion; runtime/model/Ready remain absent. When no prepared session exists, cold maintenance uses the actual native SID-wide session singleton. A live authority owning that mutex blocks the update.

`refreshFleetAfterConsumerUpdate` requires the actual Prepare mutex lease, exact update transaction and verified current snapshot. It uses only the already approved cached fixture and preserves original IDs/credential. `readActiveFleetIdentity` is the common protected resolver; malformed/stale overlay never falls back silently.

`PersonalCompletionProducer.activity()` returns `{pending, queued, accepting, idle}` and `subscribeActivity(listener)` reports changes without timers or HTTP polling. Counts follow the real coalesced reconcile promise; `dispose()` awaits it.

## Executed checks

From `windows-desktop/`:

```sh
npx vitest run tests/update-factory.test.ts tests/update-installer.test.ts tests/update-trust.test.ts tests/update-staging.test.ts tests/update-storage.test.ts tests/update-readiness.test.ts tests/update.test.ts tests/fleet-active-runtime.test.ts tests/fleet-update-preparation.test.ts tests/fleet-advanced-inspection.test.ts tests/fleet-advanced-authority.test.ts tests/fleet-controller.test.ts tests/fleet-runtime.test.ts tests/session-browser.test.ts tests/session-admission.test.ts tests/session-observer.test.ts tests/session-supervisor.test.ts tests/session-personal-owner-proof.test.ts tests/session-control.test.ts tests/admission-broker.test.ts tests/fleet-admission.test.ts tests/prepare-records.test.ts tests/prepare-controller.test.ts tests/readiness-cache.test.ts tests/outbox-activity.test.ts
npx tsc --noEmit
npm run build
```

Latest result (18:03 UTC): **25 files / 273 tests passed**; full desktop TypeScript and build passed. Full desktop Oxlint found **0 errors/0 warnings across 370 files**; scoped Prettier check passed. The earlier 268-test checkpoint and separate temporary esbuild bundle of the **production updater factory dependency graph**, Node 24 CommonJS, remain historical evidence (0 warnings, no app execution). New fixtures cover native monitor exit gating and exact nested assistance authority.

From `worker/`:

```sh
npx vitest run tests/enrollment-report.spec.ts tests/capacity-receipt.spec.ts tests/capacity-benchmark.spec.ts tests/windows-consumer-native.spec.ts
npx tsc --noEmit
```

Latest result: **4 files / 95 tests passed** and full worker TypeScript passed. The earlier 94-test checkpoint remains historical. The required consumer inventory fixture includes the real `consumer_personal.py` payload; no signed package requirement was relaxed. Native certificate SDK/policy fixtures are synthetic source checks.

The updater factory fixtures run real controller/backup/retention/model-file operations with generated test signatures, temporary private files and synthetic model bytes. Native, qualification, registration/session and staging boundaries are fixture adapters. A sealed-resource fixture detects later updater metadata replacement and rejects a mismatched publisher. The staging test runs the actual bounded artifact downloader plus private file hashing with synthetic HTTP bytes; only Windows path spelling is adapted. These tests do not establish Authenticode, native ACLs, actual DirectML or a real installer.

Initial isolated failures were corrected in owned fixtures/source: new certificate methods were added to the updater native fixture; a temporary staging directory was made private for the real downloader; cold maintenance now permits a journal-bound staged transaction with no prepared session. Earlier concurrent cloud-admission TypeScript errors were fixed by their owner; the final full TypeScript checkpoint passed.

## Deferred closure

- [ ] Revalidate the new concrete Main/UI lifecycle, event-driven account/proxy activity, browser clouds/playback, all file/outbox writers and startup recovery gating. Main updater/private installer/cold UI bindings now exist; their separate composition evidence must cover the whole activity and exit ordering. Preserve current account generation/saved fleet intent.
- [ ] Verify real signed feed/current app identity/trust resources and complete W31 signed installer payloads without inventing release URLs or signing keys.
- [ ] Compile/execute native certificate, mutex, Job/keeper, DPAPI and asInvoker installer code on Windows 10 22H2 x64 and Windows 11 x64.
- [ ] Exercise signed NSIS replacement, old app/headless PE locks, monitor crash/ACK loss/reboot/logoff, cross-logon recovery and exact monitor/installer tree completion.
- [ ] Run real cold app-only update, prepared GPU update, approved-fleet refresh/capacity invalidation, exact old-model rollback and startup capsule restoration with actual current DXGI evidence.
- [ ] Revalidate retention/open-file/antivirus/disk-full faults and preservation of account, Library, pins, outbox, credentials, registration and allowed saved intent under genuine consumers.

Native inspect/recover now reports the requested different pin as absent only after a prior certificate has validated completed/exit/whole-tree proof, allowing sequential or rollback installers; different noncompleted pins remain conflicts. The app coordinator tests both boundaries.

No native acceptance or release-readiness claim is made. Overall W29 remains in progress.

## Contract preflight

Read the current [official Zalando RESTful API/Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/) on 2026-10-09 before extending the shared update view. Rules 100, 123, 106/107 and 109 shaped contract-first review, explicit nullable installed identities, complete unchanged signed targets and bounded validated state. Existing component-internal camelCase is retained; REST routes/status/OpenAPI rules do not apply to this private IPC/DPAPI contract. No backend endpoint or external signed metadata schema changed.

## Startup recovery and consumer inference proof — 2026-10-09

`ConsumerUpdateController.initialize()` reads protected state before automatic
session launch/Prepare. Pending journals publish blocked recovery even with
discovery disabled; corrupt state is never reset. It verifies the cached signed
target at its recorded checkpoint without feed fetches, leases, writes, activation
or current runtime/model access.

`inspectConsumerUpdateStartup(host)` in `update/storage.ts` is the independent
read-only fallback when sealed updater configuration cannot create a controller.
It reads only account/consumer_update_state, rejects more than 16 KiB and invalid
UTF/shape, and returns `{recoveryRequired, invalidState, transaction, problem}`.
Pending/unreadable state fences intake even without a feed. It cannot authenticate
a target or authorize recovery/install. No-state and terminal complete/rolled-back
records permit normal startup; native read uncertainty is bounded
`UPDATE_STATE_UNAVAILABLE`. Retrieved bytes are zeroed.

Consumer fleet initialization and aggregate teardown now require positive native
`inferenceIdle()` for the exact bound role Job after all-slot supervisor stop.
False/failed proof cannot mark idle or release GPU authority. The optional
consumer-only WorkerRuntime terminated-attempt hook preserves scratch and forbids
replacement engine restart on uncertain whole-role proof, while remaining slots
can still stop. Legacy profiles omit this hook. Physical guard acquisition uses
the resolved active runtime's full GPU identity rather than original approval.

Final desktop fleet/update/account/usage/realtime check: **27 files / 269 tests**,
full TypeScript, full lint **392 files / zero warnings/errors**, source build passed
(test-process 19:24 Africa/Cairo = 16:24 UTC). The independent startup slice passed
**4 files / 74 tests**. Worker runtime **52 tests**, TypeScript/source build and
scoped format/lint passed. New false/failed query cases retain actual fixture
scratch and block restart; positive proof allows cleanup. An intermediate native
share union TypeScript error was fixed by its owning agent; final full types pass.

These are synthetic native adapters and owned temporary files. Actual Windows
DPAPI/Job census, Main startup/installer/media authority ordering and DirectML
remain deferred; pending native acceptance boxes stay open.
