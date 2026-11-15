# W23 — Implement approved per-user worker onboarding

- Status: code-complete / Windows pending (production source and portable checks complete; native/live/signed-release acceptance deferred).
- Code dependencies: [W05](W05-backend-platform-and-contract-support.md), [W07](W07-directml-selection-and-qualification.md), [W10](W10-per-user-agent-and-worker-lifetime.md), [W14](W14-complete-account-experience.md).
- Accepted scope points: P19, P20, P26.
- Execution phase: A source implementation and portable checks; W34 native/live acceptance remains deferred.
- Evidence: [W23/W24 source and fixture checks](../evidence/W23-W24-fleet-core.md).

Checked implementation/code rows refer to the concrete production source and portable fixtures mapped in the [final source closure matrix](../evidence/W23-W24-W25-W29-final-source-closure-2026-10-09.md). They do not claim native execution. A dependency's pending Windows proof does not block source work; preserve every W34/native/live/release gate below.

## Existing behavior and design consequence

Personal Prepare is account-free; fleet enrollment is deliberately restricted to Google-authenticated, administrator-enabled accounts with qualified hardware. Per-user installation changes identity/lifetime, not authorization.

## Read before editing

- [chrome-extension/macos/DesktopWorker.swift](../../../chrome-extension/macos/DesktopWorker.swift)
- [chrome-extension/macos/DesktopWorkerView.swift](../../../chrome-extension/macos/DesktopWorkerView.swift)
- [worker/src/enrollment/report-builder.ts](../../../worker/src/enrollment/report-builder.ts)
- [backend/src/worker-fleet/enrollment/worker-enrollment.service.ts](../../../backend/src/worker-fleet/enrollment/worker-enrollment.service.ts)
- [backend/src/worker-fleet/enrollment/user-worker-installation.controller.ts](../../../backend/src/worker-fleet/enrollment/user-worker-installation.controller.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Implement the current worker eligibility journey with Google provider, recent-auth and backend worker-registration permission checks. Display concise ineligible/pending/ready messages without inventing approval.
- [x] Build a consumer-profile qualification/enrollment report using the actual selected GPU/runtime/model and current-user installation identity. Preserve server validation and anti-replay/idempotency boundaries.
- [x] Install fleet state and credentials in their separate private namespace, reference the shared verified runtime, then start automatically only when onboarding and saved intent permit it.
- [x] Recover interrupted install/enroll/finalize steps without duplicate worker identities, leaked credentials or unintended claims. Make retry/reconnect bounded and deterministic.
- [x] Restore an existing valid installation independently of app account login. Explicitly distinguish local preparation, fleet enrollment, worker connection and backend permission.
- [x] Handle permission revocation, invalid credentials and backend downtime without weakening authorization or disabling unrelated personal processing.
- [x] Prepare fixture enrollment flows only during development; do not enroll or change a real worker/fleet until specifically authorized.

## Code validation checklist

- [x] Test Google/email/signed-out/admin-disabled/expired-auth combinations and valid/invalid consumer reports.
- [x] Fault-test each installation/enrollment boundary, duplicate responses, resume, revoked credentials and account switching.
- [x] Assert fleet secrets never enter app account exports and local Prepare remains usable when enrollment fails.

## Windows acceptance — deferred until W34

- [ ] Perform an authorized enrollment against a designated account/backend and verify per-user identity plus DirectML evidence.
- [ ] Verify automatic startup/recovery and continued account-free local use when fleet eligibility is absent or revoked.

## Detailed agent execution handoff

### Authorities and persistent phases

Reuse [FleetController](../../../windows-desktop/src/main/fleet/controller.ts), [fleet store](../../../windows-desktop/src/main/fleet/store.ts), [approved preparation](../../../windows-desktop/src/main/fleet/preparation.ts), [real agent factory](../../../windows-desktop/src/agent/fleet.ts), [enrollment client](../../../worker/src/enrollment/enrollment-client.ts) and [backend lifecycle](../../../backend/src/worker-fleet/enrollment/worker-enrollment.service.ts). Personal Ready is not a fleet grant. Google linkage, current Google authentication, recent authentication, backend registration permission, installation credential, activated machine credential and local model/GPU readiness are separate requirements.

- [x] Complete the real eligible/ineligible/pending/ready journey from current account/registration snapshots. Client JWT decoding is only preflight; the server validates identity/provider/auth-time and permission. A fresh token refresh does not replace Google reauthentication.
- [x] Bind invitation/exchange → backend approved artifact/fixture → owned DirectML qualification → exact output upload/confirmation → report/revision → activation/finalize → saved machine state. Persist stable IDs and the phase before retryable boundaries. Preserve worker/installation/machine IDs and verify every response belongs to the captured operation.
- [x] Verify signed `windows-amd64-user` artifact identity/profile, model pin, fixture grant/length/hash and runtime inventory. Qualification uses the backend-approved fixture and actual SID/GPU/driver/provider dispatch, never the personal synthetic fixture. No WARP/software/CPU fallback is acceptable.
- [x] Bind fleet credentials only in its current-user private DPAPI namespace. App account tokens stay separate. Existing credentials can restore independently of MusicMute sign-in; backend revocation still blocks claims. Start follows the single saved Session intent and actual enrollment/approval/preparation, never a cached onboarding `running` boolean.
- [x] Install the fixed no-secret child config, verified release module imports and private authenticated control/event/admission channels. Reject foreign SID/session/process birth, wrong owned tree, stale ticket/nonce and helper/release hash mismatch before any model preload or backend claim.
- [x] Coordinate W24/W11 actual drain/admission, W25 mutation serialization and W29 runtime activation. Keep local personal processing usable when account/enrollment/backend is unavailable. No no-op production runtime factory or fake admission grant can close this task.

### Historical fixture blocker — resolved in source

The preserved `VaultFleetStore.write` patch requires native `acquireMutex`/`releaseMutex` and the native 16 KiB bound. Historical documentation checkpoints first lacked fixture methods, then returned a string instead of `ConsumerMutexLease | null`. During the later authorized implementation the typed fixture lease and contention/refusal/finally-release/oversize cases were repaired and verified. The 2026-10-09 W25 checkpoint passed current Desktop typecheck/source build and 162 focused fleet/Advanced/session/Prepare tests. `writeIfCurrent` now compares stable machine credential/identity/revision authority under the same native cache mutex so a late confirmed revoke cannot overwrite a newly enrolled machine. See [W25 evidence](../evidence/W25-consumer-advanced-core.md); this portable fixture/source proof does not establish real Windows mutex/native behavior.

### Failure and completion tests

Test guest/email/linked-Google-but-email-session/old-auth/permission-denied eligibility, A→B during invitation/qualification/report, phase replay after every lost acknowledgement, missing/wrong artifact profile, expired grant, invalid uploaded output, changed model/driver/fixture, stale revision, duplicate UUID with different body, helper failure and machine revocation. The actual shared WorkerRuntime factory must receive verified paths and physical admission before preload; a passing report must not authorize a claim alone.

Run focused fleet controller/preparation/configuration/runtime/admission tests, consumer backend DTO/artifact/qualification fixtures and component static/build checks. Do not call live enrollment/claim/R2 endpoints. Deliver actual main/session/UI composition, protected journal schema/ID map, recovery matrix and separate personal/fleet readiness examples.

### Runtime-update return task

Activated installations reject new initial enrollment reports and qualification-output grants: backend `report` accepts only restricted/reported, and qualification service uses the same open-phase gate. The implemented W29 return uses a separately validated local `active_runtime` overlay bound to immutable original approved capabilities. It preserves machine IDs/credentials/permission, genuinely requalifies the approved fixture, invalidates incompatible capacity and includes the overlay in rollback. Current boot/DXGI/driver proof and unique approved secondary-adapter selection also align the PERSONAL receipt used by the admission broker. No automatic re-enrollment, credential adoption, original-report rewrite, invented endpoint or fake capacity is permitted. The final matrix maps actual Main recovery and independent logged-in bootstrap receiving paths.

W34 later uses explicitly designated account/backend enrollment to prove DPAPI/SID, backend output validation, real GPU/driver, startup/restart and independence from account signout. Source/static proof is not that enrollment.

## Production enrollment and intent integration return

- [x] Test UI/account event → current Google/recent-auth eligibility →
      administrator-allowed enrollment → approved fixture/report activation →
      durable session intent composition. No real enrollment in code checks.
- [x] Fence account/machine replacement at every response; no duplicate enrollment.
      Cold Chrome/headless account probes cannot enroll a new worker.
- [x] Preserve approved credentials/intent across personal sign-out/missing config.
      Destructive actions use W25 exact-machine confirmation, no boolean bypass.

## Completion record

- Implementation files and review: main/fleet trusted modules, agent/fleet real shared-runtime factory and fixed bootstrap, fleet view/command contract and focused fixtures.
- Commands/results and evidence: historical 69 fleet fixtures and 99 worker regressions with 2 Windows-only skips remain in the original record. The [final closure matrix](../evidence/W23-W24-W25-W29-final-source-closure-2026-10-09.md) records the later focused source/composition/renewal checks and their limits.
- Unrun native/toolchain checks: real Windows helper, GPU, enrollment/control and logon/logout checks remain W34.
- Remaining limitations and next task: designated Windows native/GPU/logon/enrollment acceptance remains W34; approved signed release inputs and publication remain W31/W32. Production Main/renderer/session and account-independent restore source now exist.

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Current-witness recovery source checkpoint

- [x] Preserve original enrollment/report/approval and separately validate current-witness active-runtime authority; legacy/missing/stale witness requires fresh approved-fixture qualification.
- [x] Provide account-independent recovery with actual consumer/session/Prepare fences, machine/process-birth journal, partial-acquire cancellation and retained uncertainty. Personal Ready alone does not authorize fleet readiness.
- [x] Bind genuine Main and independent logged-in bootstrap return/startup composition; restore only existing Session intent and retain uncertain cleanup fences.
- [ ] Prove that return/startup on the connected supported Windows targets, including actual original approved secondary GPU and logged-in worker lifetime.

## Final source closure additions

- [x] Add explicit same-UID fresh-Google/admin invitation renewal only for an expired invitation phase, preserving the exact worker/key/request identities under full-record CAS. Lost exchange ACK and renewed replay namespaces are covered in frontend/backend fixtures; later phases cannot reset.
- [x] Require explicit eligible enrollment after a strict purge marker; malformed/unreadable marker never enables automatic registration, and completed explicit re-registration preserves saved Stop.
- [x] Review every implementation/code/detailed/production requirement against the actual receiving source and meaningful tests in the final closure matrix. Native/live acceptance remains unchecked.

See [current-witness source and portable evidence](../evidence/W23-W25-W29-current-witness-recovery-2026-10-09.md). The stable hardware descriptor is not a persistent physical serial; no missing witness is inferred, original backend approval remains immutable, and native/live/release boxes remain open.
