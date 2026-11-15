# Free Microsoft Store package migration

Prepared: 2026-10-12. Implementation is in progress. This ledger distinguishes
source checkpoints from installation, feature acceptance and Store certification.
It does not describe a ready Store release.

The owner selected free Microsoft Store package signing through the existing
developer account. Do not purchase signing, introduce a paid signing dependency,
or export a hardware/cloud private key. The previous website-first distribution
decision is superseded for this route; historical NSIS work remains evidence for
its own scope.

## Current evidence and boundaries

- [x] Study the existing Windows packaging, process authority, runtime, Chrome,
      startup and update implementation and current Microsoft package guidance.
- [x] Root confirmed creation of the **MusicMute** MSIX draft product, Store
      product ID **9P7VX8JK8B68**. A draft product is not a submitted package,
      available download, Store signature, capability approval or certification.
- [x] Reserve and record **MusicMute Worker**, Store product ID
      **9P4GXB0NRJDG**, as a second independent MSIX draft. This is the planned
      route to preserve worker operation after GUI uninstall; it does not prove
      that either package is implemented or installed.
- [x] Record the exact live identity values for both products in the external
      `MusicMuteReleaseInputs/windows-x64/store-identities/` folder and retain
      screenshot evidence. Source: each product's live Product identity page.
      Native manifest Application IDs are recorded in the current manifest;
      they are distinct from the Store-assigned identity or an MSA application ID.
- [ ] Implement and validate this migration. Existing source checks and guarded
      Z440 GPU runs are baseline evidence, not Store package acceptance.

Original task checkboxes below remain unchecked until their complete requirement
passes. Narrow source checkpoints record completed parts without closing a whole
task or its physical gates. Mark a
checkbox only after its specific work actually completes; link dated evidence,
commands, artifact identity, target, result and limitations. A documentation or
source pass cannot close a physical or Store gate. Preserve unrelated dirty
work, earlier containment fixes and historical evidence.

The dated [implementation and validation record](IMPLEMENTATION-2026-10-12.md)
records current source checks, frozen native cohorts, actual Chrome prototype
results and the remaining integration gates.

**15 October current checkpoint:** both fresh current-source GUI and Worker
directories and their new SDK archives passed genuine production receiving
checks on the Z440. Verified copies are in
`C:\Users\hatem\Desktop\MusicMute-MSIX-Current-2026-10-15-ab42e4db`; see the
[new archive evidence](IMPLEMENTATION-2026-10-12.md#15-october--both-fresh-current-source-sdk-archives-verified).
Eight production-core DirectML calls also passed exact output parity, including
default/trim cold/warm model reuse; signed-installed acceptance remains separate.
The original GUI upload was rejected
for a missing `HeadlessAppBypass` waiver. The owner deferred submitting the
prepared support request; there is no case or approval. Neither package is
Store-signed, installed or published. Dated older checkpoints remain historical.

The [release-material index](STORE-REVIEW-READINESS-2026-10-15.md) now records
saved/reopened EN/AR listings, direct Store privacy text and reviewer notes for
both private drafts, with exact inventory/source exports. These completed
material checkpoints leave the whole-task approval, screenshots, credentials,
rights/consent and signed-installed requirements open.

## Product invariants

| Area       | Required result                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Systems    | Windows 10 22H2 x64, build 19045, and Windows 11 x64; reject ARM, ARM emulation, x86 and unsupported hosts.                                                                                |
| Features   | Retain all 30 accepted parity points and their existing journeys in [COVERAGE.md](../COVERAGE.md) and [FEATURE-ACCEPTANCE.md](../FEATURE-ACCEPTANCE.md).                                   |
| Processing | Same model, production recipe revisions, quality, trim behavior and encoding; qualified DirectML GPU inference, no silent CPU or cloud fallback. CPU decoding/DSP/encoding remain allowed. |
| Warm model | Keep the qualified model loaded across songs in the logged-in session; fresh attempt contexts, serial ownership, exact cancellation/error retirement and unchanged GPU exclusion.          |
| Accounts   | Personal local processing works signed out; fleet enrollment retains account and backend administrator approval. Signing out does not revoke an independently enrolled worker.             |
| Browser    | One existing shared Chrome extension, key, ID and protocol. Store packaging must not fork the extension or invent a new identity.                                                          |
| Worker     | Standard-user execution while logged in, independent of GUI windows; no service, administrator prompt, WinSW, scheduled SYSTEM task or new driver.                                         |
| Data       | Preserve existing private Library/model/state/credential boundaries and ordinary replacement/uninstall behavior; no destructive migration or silent data reset.                            |
| Updates    | Store delivers executable code updates. Keep model integrity and compatibility checks; never run a downloaded custom unsigned updater or launcher.                                         |
| Live data  | Reuse existing realtime transport/snapshots; this migration does not authorize status polling or a new backend protocol.                                                                   |

Read [RESUME-GAPS.md](../RESUME-GAPS.md) before treating containment or other
historical source closure as complete. Read the repository guides and affected
component instructions before implementation; follow the realtime handoff when
touching processing/account/live-data paths.

## Intended package and authority split

Preserving the current worker-after-GUI-uninstall behavior requires **two
independently installed main Store packages**. A framework, resource or optional
package automatically owned by the GUI is not a substitute for that independence.

| Package                 | Intended ownership                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MusicMute GUI           | Electron main/preload/renderer, account authority, player/Library UI, public configuration, shared extension assistance and its native Chrome host. Resolve an installed Worker through its exact registered identity.                                                                   |
| MusicMute Worker        | Full private executable runtime: Node, Python/DirectML and complete DLL closure, engine code, FFmpeg/ffprobe, Deno/provider/downloader code, native processing helpers, session/login/personal/fleet/Prepare agent entries and its own login task. No dependency on a surviving GUI EXE. |
| Writable per-user roots | Existing model, media, jobs, Library, cache, preferences, DPAPI credentials, leases and recovery journals; only guarded mutable data outside packages.                                                                                                                                   |

Every executable/script/DLL used in production must belong to one of these
Store-protected package inventories. A copied launcher or external runtime ZIP
does not acquire package trust. Keep both package installations and first-launch
requirements visible and simple; never suppress Windows consent or imply that
reserving a Worker name installs it.

Store authority must be a separate explicit mode: exact OS-registered package
identity and generation, immutable installed root, sealed resource hashes and
live process/file identity. Do not reinterpret a missing Authenticode leaf pin as
success. Keep the legacy NSIS authority strict. Store-managed hardlinks/ACLs need
a separate package-file policy; mutable user files retain their existing
single-link, owner, path, handle and birth checks.

Neither `win32App` with `mediumIL` nor a desktop-app breakaway flag establishes
an approved escape from virtualization. The former still requires the relevant
restricted capability; bundled WindowsApps executables can remain in package
context even when external executables launch outside it. S03 must prove the
actual namespace and activation boundary rather than infer it from token labels.

Package LocalState is removed when its package is uninstalled. Worker LocalState
only survives GUI removal while Worker remains; PublisherCache is not a durable
replacement when the last relevant publisher package is removed. Preserving
ordinary uninstall/reinstall data after **both** packages are removed requires a
deliberate non-virtualized external per-user data root with the existing strict
guards and physical proof. Until that is proved, original data-retention parity
remains open.

## Sequential AI-agent tasks

### S01 — Record both Store identities and acceptance inputs

Dependencies: root's live product creation/identity work.

Affected areas: this ledger, root's public identity record and future Store
packaging inputs; no guessed configuration or secrets.

- [x] Record exact GUI and Worker identity values and product IDs from their live
      Product identity pages; retain the distinction between display name,
      package identity, Publisher CN, PublisherId, family name and application ID.
- [ ] Record requested capabilities, their actual approval status, supported OS
      minimum and the owner-approved version/build numbering strategy.
- [ ] Review the applicable Store and third-party-content policies for bundled
      downloader/YouTube acquisition and independent fleet GPU/network work.
      Preserve existing rights journeys and user consent/resource controls, and
      disclose these functions accurately. Capability approval alone does not
      establish approval of those feature uses or content rights.
- [ ] Define separate source, package-build, physical installed and Store
      certification evidence. Verify identity parsing rejects placeholders,
      foreign products, malformed versions and wrong architecture.

Exit: both identities are real and independently recorded. Reservation does not
close any capability, package or certification gate.

Source checkpoints (2026-10-12):

- [x] Implement exact two-product identity/version/ABI/installed-observation
      receiving contracts and malformed/foreign/unsupported-host denials.
- [x] Record capability declarations, pending approval, initial repository
      version/build choices and x64/19045 minimum in
      [package ownership](PACKAGE-OWNERSHIP.md).
- [x] Review both current and next-effective policies and actual runtime
      redistribution gaps in [the review record](POLICY-REVIEW-2026-10-12.md).
- [ ] Close third-party permission, final redistribution and actual Store
      capability/content acceptance gates.

The reserved GUI identity is `27120VCHATSDK.MusicMute` with family
`27120VCHATSDK.MusicMute_5q1esjnkz8cve`. Worker is
`27120VCHATSDK.MusicMuteWorker` with family
`27120VCHATSDK.MusicMuteWorker_5q1esjnkz8cve`. Both live pages specify publisher
`CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E` and display publisher `VCHATSDK`.
These are package identity values, not an Authenticode private key or a Store
signature. No package was uploaded or submitted.

### S02 — Freeze package ownership and cross-package compatibility

Dependencies: S01.

Affected areas: [architecture](../ARCHITECTURE.md),
`windows-desktop/packaging`, session bootstrap and Worker build inputs.

- [ ] Assign every executable entry, helper, dependency, public resource and
      mutable root to exactly one package/data owner. Keep existing UI/worker
      behavior and account separation.
- [ ] Define supported GUI/Worker version pairs, exact family allowlists,
      installation discovery and visible recovery when either package is absent,
      outdated or unregistered. No framework dependency that removes Worker
      together with GUI.
- [ ] Define GUI uninstall, Worker uninstall, both uninstall, repair, reset and
      reinstall behavior separately. Preserve fleet operation after GUI removal;
      no fallback to an unsigned retained launcher.
- [ ] Review the split against all accepted parity journeys. Test incompatible,
      missing and independently updated package combinations before porting the
      complete product.

Exit: an explicit ownership/compatibility plan without a silently dropped feature.

Source checkpoints (2026-10-12):

- [x] Define independent main-package ownership, supported ABI/version pairs,
      missing/incompatible recovery and separate removal/reset/reinstall effects
      in [the contract](PACKAGE-OWNERSHIP.md); test receiving and pair denials.
- [ ] Port and physically verify the complete product across that split.

### S03 — Prove Chrome registration, activation and namespace feasibility

Dependencies: S01–S02. This is an early physical prototype gate.

Affected areas: `packaging` manifest prototype,
`src/main/browser/registration.ts`, native `browser_registration.hpp`,
`chrome_host.cpp`, `account_authority.hpp` and process launch helpers.

- [ ] Prototype real HKCU native-host visibility from ordinary Chrome, shared
      extension identity/origin checks and package-aware stdio host activation.
      Compare the final opened registry/file locations from packaged and normal
      processes; a successful virtualized write is not registration proof.
- [ ] Test a stable package execution alias versus an exact registered package
      path. Prove framed stdin/stdout, argument validation, authenticated lineage,
      disabled alias behavior, update/relaunch and Chrome starting before GUI.
- [ ] Prototype controlled `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` at the
      original launch boundary if desktop-app breakaway is needed. Measure the
      resulting package identity, namespace and Job membership; it is distinct
      from `CREATE_BREAKAWAY_FROM_JOB` and must not escape processing guardians.
- [ ] If needed, prototype narrowly authenticated bundled code hosted by a fixed
      trusted system executable, with static bounded operations, exact registered
      package code/hash binding, filtered environment and actual ordinary-process
      HKCU readback. Do not expose a shell, arbitrary executable/script path or
      mutable copied launcher as the registration escape hatch.
- [ ] Record whether the limited intended capability set suffices. Do not assume
      approval of `unvirtualizedResources`, `win32App` or any other restricted
      capability. If an alternate namespace/activation mode is needed, record its
      exact manifest requirements and obtain actual Store acceptance. `win32App`
      with `mediumIL` still needs `unvirtualizedResources`; it is not a loophole.
- [ ] Run the prototype on Windows 10 19045 and Windows 11 x64 with ordinary
      Chrome. Use a properly authorized disposable development package or Store
      flight; do not change Developer Mode, trust stores or device policy without
      authorization, and never report a development package as Store-signed.

Exit: an evidenced route that can preserve Chrome/data behavior. If this fails,
continue independent source work but do not claim the full feature set is ready.

Physical checkpoints (2026-10-12, disposable Windows 11 QA package):

- [x] Prove real Chrome native messaging through a protected immutable manifest
      and both stable alias/protected-path routes; verify exact Unicode frames,
      actual package context and owned Job/pipe completion.
- [x] Observe classic filesystem/registry virtualization and prove ordinary
      Chrome registration visibility through a narrowly fixed, catalog-verified
      Windows system broker.
- [x] Prove the explicit paired unvirtualized external private data namespace
      and unchanged file/root identities after GUI-only and both-package removal
      on Windows 11, using exclusive QA files and ordinary-owner observation.
- [ ] Prove reinstall/Repair/Reset, disabled aliases and servicing behavior.
- [ ] Repeat on Windows 10 19045 and obtain actual Store capability acceptance.

These tests used signature kind None (0), a disposable extension/profile and
exclusive QA data. They do not close genuine Store or full shared-extension
processing/account/playback acceptance.

### S04 — Implement registered package discovery and immutable code roots

Dependencies: S01–S03.

Affected areas: `worker/native/windows-consumer/main.cpp`, `startup.hpp`,
`account_authority.hpp`, `browser_registration.hpp`, `login_worker.hpp`,
`launcher.cpp`, native transport and desktop host context.

- [ ] Resolve expected registered package roots using Windows package APIs;
      never derive authority from a caller's path, environment or display name.
      Validate exact family/publisher/architecture/current generation and status.
- [ ] Introduce a bounded package-file authority separate from private mutable
      paths. Retain actual handles, canonical paths and sealed hashes; handle
      legitimate OS deployment hardlinks without permitting mutable aliases.
- [ ] Remove fixed `%LOCALAPPDATA%\Programs\MusicMute Local` assumptions only
      in Store mode. Preserve strict NSIS behavior and existing user-file checks.
- [ ] Test copied executables, wrong family, developer/foreign packages,
      registration loss, reparse escapes, stale versions, changed files and
      concurrent update. A family name string alone must never grant authority.

Exit: exact package discovery and code-file authority with fail-closed evidence.

Source checkpoints (2026-10-12):

- [x] Implement native registered identity/generation/Store-origin discovery,
      immutable held file/code inventory and living process/parent attestation.
- [x] Implement a fixed genuine-GUI code owner for the independent Worker,
      bounded protected internal manifest reads and exact Session OS activation.
      Source/portable checks passed; fresh native compilation and installed
      signed-package positive cases remain open.
- [ ] Integrate every Store caller and prove installed positive/negative cases;
      disposable unsigned S03 code cannot satisfy production Store authority.

### S05 — Bind packaged resources and peer authority to the Store route

Dependencies: S04.

Affected areas: `src/main/browser/package-trust.ts`, `native.ts`,
`account-authority.ts`, native `account_authority.hpp` and `installer.hpp` callers.

- [ ] Implement a discriminated Store trust contract; retain resource/code hash
      seals, ASAR integrity and required resource inventory. Do not replace
      publisher leaf fields with fabricated values or broaden legacy verifiers.
- [ ] Authenticate GUI, Chrome proxy, headless account and cross-package Worker
      peers using exact living handles, SID/session/birth, registered code paths,
      supported package generations and operation-specific capabilities.
- [ ] Treat Microsoft signing certificate rotation as irrelevant to stable
      package publisher identity; do not pin Store leaf thumbprints forever.
- [ ] Test missing authority, copied/modified peers, stale births, wrong roles,
      cross-user/cross-login calls, partial resource seals and mixed package
      generations. Verify sandboxed renderer privileges remain unchanged.

Exit: Store authority works explicitly; missing proof never falls back to trust.

Source checkpoints (2026-10-12):

- [x] Implement strict ASAR resource-index v2 and a GUI bootstrap that derives
      its fixed helper from the running sealed Electron application; caller
      paths, pins, receipts and runtime constructor injection grant no authority.
- [x] Connect Main's packaged resource loader, exact resource/build binding and
      helper lifetime to the explicit Store bootstrap. Deny legacy resource
      authority fallback after Store admission or closure.
- [x] Implement a closed GUI private-data bootstrap, protected deployment
      namespace validation and one-use GUI issuer callback bound to its actual
      spawned helper. Portable tests passed; Windows refresh remains open.
- [x] Implement explicit Store account v2 ticket/port and live creator registry;
      bind Main's actual account-mutex owner and retain it across browser pauses.
      Admit browser peers only through the private actual Chrome attachment.
      Source fixtures passed; native compilation/Store positive cases remain.
- [ ] Complete cross-package Session/Prepare/fleet and installed account/Chrome
      operations, including genuine Store signing and both supported Windows OSes.

### S06 — Assemble complete executable runtimes inside package staging

Dependencies: S02, S04–S05.

Affected areas: `worker/src/platform/windows/consumer-package.ts`,
`consumer-pins.ts`, `consumer-dlls.ts`, `release-manifest.ts`,
`worker/scripts/build-windows-consumer-runtime.ps1` and desktop build staging.

- [ ] Reuse qualified pinned runtime inputs and current engine/agent source.
      Include every required EXE, DLL, Python module, script, Node dependency,
      downloader/provider input and license in a closed package inventory.
- [ ] Audit x64 PE/DLL architecture, relocatability, import closure, expected
      versions and path isolation. Reject incomplete source subsets and ambient
      PATH/site-packages dependencies.
- [ ] Redirect bytecode, model lookup, temp, cache and tool outputs to existing
      guarded writable roots; no package-directory mutation or executable code
      download during consumer Prepare.
- [ ] Probe the relocated staged payload and installed package. A passing source
      environment is not a package DLL/import proof. Record real package size and
      upload limits instead of assuming the full runtime fits.

Exit: complete immutable executable payloads; model and private user media excluded.

### S07 — Port role launch, guardians and process identity checks

Dependencies: S04–S06.

Affected areas: native `launchOwned`, `job_guardian.hpp`, `gpu_keeper.hpp`,
`retained_engine.hpp`, launcher/login peer checks and `worker/src/agent`.

- [ ] Launch fixed package Node/agent/helper paths with existing bounded
      environment, suspended assignment and nonce/role ownership. Keep nested
      Job/GPU guardian guarantees and no-admin/login-only execution.
- [ ] Bind exact package generation and code inventory to each role; account for
      actually observed child package identity rather than assuming inheritance.
      Reauthorize deliberate desktop-runtime breakaway without relaxing lineage.
- [ ] Preserve shutdown, cancellation, timeout and crash proof: positive actual
      tree retirement, handle close and GPU lease release. Avoid orphan processes
      that pin an old package during Store update.
- [ ] Run meaningful native negative fixtures and physical installed tests for
      extra descendants, failed assignment/close, wrong generations and logoff.
      Do not sign out or terminate unrelated user processes for convenience.

Exit: owned process trees behave correctly under actual package activation.

Source checkpoints (2026-10-12):

- [x] Implement fixed Store Worker launch plans and full protected runtime census,
      including distinct ONNX and Torch DirectML DLLs without a quality change.
- [ ] Port actual role/session/GPU guardian entry modes and retirement across
      package updates; launch-plan policy is not process-launch proof.

### S08 — Port runtime/session activation and cross-package bootstrap

Dependencies: S05–S07.

Affected areas: `src/main/session/activation.ts`, `bootstrap.ts`, `context.ts`,
`desktop-client.ts`, `login-worker-runtime.ts`, `login-capsule.ts`,
`src/agent/session-agent.ts`, `login-worker.ts` and native `login_worker.hpp`.

- [ ] Resolve the Worker package code root and supported inventory instead of
      `personal/runtime/releases/<release>`. Keep configs and receipts private,
      with explicit code identity and compatibility binding.
- [ ] Replace copied GUI-dependent executable bootstrap with Worker-owned
      activation/startup. Copy only already-authorized public/data receipts when
      necessary; mutable copies never create executable trust.
- [ ] Preserve a sole per-SID/per-login session/account authority and exact
      GUI/Chrome ownership tokens. Missing Worker shows actionable setup state.
- [ ] Test interrupted bootstrap, incompatible GUI/Worker versions, missing
      registration, concurrently launched callers and stale capsules after update.

Exit: a Worker session starts independently and does not need GUI installation files.

### S09 — Adapt Prepare while preserving model and GPU qualification

Dependencies: S06–S08.

Affected areas: `src/main/prepare` bundle/source/controller/activation,
`src/main/session` activation and Worker qualification code.

- [ ] Detect/install the independent Worker through the approved Store entry and
      supported activation flow. Explain both first-launch/consent requirements;
      do not silently install another product or claim name reservation is setup.
- [ ] Verify installed package runtime code, then retain the same pinned model
      download/hash, private cache, bounded retry/cancel/resume and qualified
      DirectML fixture. Keep existing containment gap work separately visible.
- [ ] Preserve fresh-user, offline prepared-user, repair, low-space and missing-
      runtime journeys without recreating downloaded executable releases.
- [ ] Test staged and actually installed imports/DLLs, damaged model, wrong
      package, download failure and cancellation. Only passing physical GPU
      qualification can produce consumer Ready.

Exit: simple setup with unchanged model/quality and actual installed runtime proof.

Source checkpoints (2026-10-12):

- [x] Implement separate Store model/fixture transfer and bounded readiness
      receiving records, using the living Worker code owner and original model,
      both recipe pins and no legacy executable archive/Ready adapter.
- [x] Add controller-stage source with actual Session qualification/cancellation
      factory calls and retained Prepare ownership on uncertain cleanup; focused
      synthetic/receiving checks passed as recorded in
      [the validation record](IMPLEMENTATION-2026-10-12.md).
- [ ] Connect that source to Main's full personal/fleet/media maintenance and
      complete Worker Node entries, then qualify actual installed Store code.

### S10 — Preserve personal processing and warm model performance

Dependencies: S07–S09.

Affected areas: `src/main/personal` runner/controller/storage,
`src/agent/personal.ts`, Python `consumer_personal.py`, `pipeline.py`,
`separator.py` and native retained-engine methods.

- [ ] Keep serial retained model use with a fresh per-song job context, unchanged
      production recipe/model parameters and no CPU inference fallback.
- [ ] Preserve job-detached quiescence versus actual inference-exit distinction;
      scratch cleanup cannot release a retained engine's physical GPU guard.
- [ ] Test cancellation/error/identity change/model repair/idle fleet yield and
      failed cleanup acknowledgements with new package code roots.
- [ ] Repeat the same production song on the Z440 using installed package code:
      cold then warm timings, stage definitions, actual reused model/session
      identities and byte-identical output against baseline. Report variance and
      package/OS/GPU/driver identities; do not reuse a cached result as inference.

Exit: same quality and evidenced warm GPU behavior in the Store package context.

### S11 — Preserve fleet enrollment, saved intent and GUI independence

Dependencies: S08–S10.

Affected areas: `src/main/worker`, session admission/supervisor,
`src/agent/fleet.ts`, login worker and existing backend registration client.

- [ ] Keep account approval/enrollment and separately stored Worker identity,
      pause/stop/start/drain and recovery intent. Do not change backend permissions
      or enroll/revoke a real worker without the existing authorized journey.
- [ ] Preserve personal-priority GPU admission and safe warm-engine yield; bind
      claims and runtime compatibility to the independently installed Worker.
- [ ] Test GUI close, account sign-out, separate GUI update/uninstall/reinstall,
      Worker unavailable/update and multi-login contention without duplicated work.
- [ ] Prove physical fleet continuation after actual GUI uninstall and later
      logged-in restart; a simulated uninstall or two reserved names is insufficient.

Exit: independent Worker behavior matches the existing product contract.

### S12 — Implement login StartupTask and respect Windows controls

Dependencies: S03, S07–S11.

Affected areas: Worker package manifest, native `startup.hpp`, `launcher.cpp`,
`login_worker.hpp`, session startup port and Worker settings UI.

- [ ] Declare the Worker-owned full-trust StartupTask and implement typed state,
      enable/disable and first-launch registration handling. Do not retain an
      external unsigned launcher or create a SYSTEM/service workaround.
- [ ] Respect disabled-by-user/policy states, delayed launch, saved pause/stop,
      missing setup and supported package versions. GUI close/sign-out is not
      Windows logoff; genuine logoff must retire owned GPU/process trees.
- [ ] Test native StartupTask states and physical login with the user-approved
      device/session procedure. Never re-enable a Windows-disabled task silently.

Exit: standard-user Worker startup with actual Windows state evidence.

Source checkpoints (2026-10-12):

- [x] Implement all native StartupTask states and explicit actions with actual
      foreground Worker-parent checks; never re-enable a user/policy disable.
- [x] Implement independent EN/AR visible Worker startup controls using the
      fixed authenticated helper and owned transient Job cleanup.
- [ ] Complete Worker session/login activation and genuine installed startup,
      saved-intent and logoff/GPU evidence.

### S13 — Complete Chrome and account/protocol activation

Dependencies: S03, S05, S08–S12.

Affected areas: GUI manifest, `src/main/browser`, native browser/Chrome/account
helpers and existing shared extension contracts.

- [ ] Implement the proven HKCU/namespace/activation design from S03, exact shared
      extension origin, stable activation and repair; no profile edits or extension
      identity fork. Capability approval remains a release gate.
- [ ] Register packaged account/product protocols through manifest activation.
      Keep PKCE, browser tickets, headless account authority and bounded commands;
      protocol strings/aliases alone do not authorize privileged work.
- [ ] Preserve Chrome audio/timeline/control journeys and GUI/account behavior
      while signed out, app closed, Worker idle/busy and network disconnected.
- [ ] Prove live Chrome handshake/processing/playback after GUI/Worker updates,
      before GUI opening, with aliases disabled and with missing packages. Test
      altered host manifests, hostile arguments and cross-user peers.

Exit: shared extension and account activation work in actual package deployments.

### S14 — Preserve private data namespaces and migration/recovery

Dependencies: S03–S05, S08–S13.

Affected areas: host roots, private storage/vault helpers, Library/preferences/
outboxes, manifest virtualization policy and existing containment tests.

- [ ] Prove the selected manifest/runtime namespace exposes the same intended
      private roots to GUI, Worker, Chrome host and normal-owner checks. Resolve
      final handles; matching textual `%LOCALAPPDATA%` paths are insufficient.
- [ ] Preserve current private ACL/link/birth/handle checks, account-scoped state
      and ordinary uninstall retention. No blanket ACL relaxation for WindowsApps,
      imported media, private runtime state or cross-package access.
- [ ] Preserve data after both packages are removed and later reinstalled through
      a deliberately non-virtualized external per-user root. Do not substitute
      package LocalState or PublisherCache and claim equivalent retention.
- [ ] Handle existing ordinary-install data, private shadows and interrupted
      activation without silent overwrite/delete. Plan any destructive migration
      separately and obtain direct authorization.
- [ ] Test new/existing/shadowed files, locked paths, unsafe links, package update,
      GUI-only removal/reinstall, Worker-only removal, both-package removal and
      reinstall, and OS Repair/Reset separately. Use disposable authorized data;
      never delete real Library/account data to obtain a passing result.

Exit: actual namespace/data preservation proof and bounded recovery behavior.

### S15 — Replace executable self-update with Store lifecycle handling

Dependencies: S08–S14.

Affected areas: `src/main/update`, package maintenance/lifecycle adapters,
session drain, model updates, release policy and update UI.

- [ ] Add explicit Store update behavior for GUI and Worker, maintain compatibility
      and required-version UX, and exclude custom NSIS installer/runtime ZIP
      activation from Store mode. Keep strict legacy checks intact.
- [ ] Drain/retire exactly owned work for package shutdown/update; do not assume
      NSIS maintenance callbacks run during Store servicing or uninstall. Persist
      safe journals and reconcile supported registrations on next activation.
- [ ] Retain separately authenticated model update rules and qualification; no
      recipe/model change is implied by switching distribution.
- [ ] Test independently updated packages, active warm model/fleet work, aborted
      servicing, forced process exit, stale registrations and old package handles.
      Never resolve failures by killing unrelated processes or weakening trust.

Exit: Store code delivery and recoverable session/data lifecycle.

### S16 — Build auditable Store upload packages and assets

Dependencies: S01–S15 source integration.

Affected areas: new Store packaging source, existing graph/license/resource
audits and pinned electron-builder/Windows SDK tooling.

- [ ] Use the supported pinned builder/SDK package path and an exact custom
      manifest for both products: x64, Windows.Desktop minimum 10.0.19045.0,
      actual identities and approved capabilities/activation extensions.
      `appx` in pinned builder v26 is supported; do not upgrade to unreleased
      tooling solely to change the package suffix.
- [ ] Preserve Electron sandbox/fuses/ASAR integrity and closed execution graph
      audits. Package-mode final hashes must follow all resource/fuse edits. Add
      package auditing instead of bypassing NSIS Authenticode/uninstaller hooks.
- [ ] Generate required Store/logo assets from existing artwork, retain all real
      licenses/provenance, reject builder sample icons, secrets, source maps,
      fixtures, media and ambient dependencies from consumer payloads.
- [x] Record exact package/file inventories, SDK/build versions and upload
      artifacts. A valid unsigned upload package is not an installable Store-
      signed package; do not create fake publisher approval or trust bypasses.

Exit: reproducible, audited upload candidates for both real Store identities.

Source checkpoints (2026-10-12):

- [x] Implement both real-identity manifests, disabled Worker StartupTask,
      hidden console Chrome-host application, actual-artwork assets, closed
      code/resource inventories and fixed guarded MakeAppx/archive audits.
- [ ] Finish complete GUI/runtime inputs and integration, pack/audit both actual
      upload candidates and close all earlier feature/namespace gates.

Package-build checkpoint (2026-10-15):

- [x] Build and production-audit both real-identity x64 unsigned MSIX upload
      candidates on the Z440: GUI `0.1.0.0` and Worker `0.1.3.0`, minimum
      `10.0.19045.0`, Windows SDK `10.0.26100.0`. Actual archive readback verified
      110 GUI files and 19,354 Worker files plus two SDK metadata entries each;
      exact artifact sizes/hashes, guarded SDK results and verified Desktop
      delivery are in the
      [15 October package-first evidence](IMPLEMENTATION-2026-10-12.md#15-october-package-first-resume).
      Both remain unsigned, noninstallable and unpublished. This does not close
      composite S16, earlier feature/namespace gates or S18.

### S17 — Run full source and package security acceptance

Dependencies: S16.

Affected areas: desktop/worker/Python/native/package test suites and dated evidence.

- [ ] Run affected component format/lint/type/build/tests, meaningful native
      security fixtures and complete package inventory/resource/identity audits.
      Review diff scope and preserve unrelated changes.
- [ ] Include negative package authority, mutation/hardlink, birth/role/session,
      cross-package version, callback/cancel, stdio and recovery cases; tests must
      exercise receiving paths rather than mirror implementation literals.
- [ ] Record real commands/counts and any skipped gates. Separate source/fixture
      tests, development package tests and genuine Store-signed acceptance.

Exit: passing applicable source/package checks; physical gates stay explicit.

### S18 — Complete Store-signed device and certification acceptance

Dependencies: S17, actual approved capabilities and signed Store delivery.

Affected areas: W34 evidence, this ledger and root's release/Store workflow.

- [ ] Obtain an authorized Store submission/flight/certification result. Product
      creation authorization does not imply permission to publish a public release
      or alter production infrastructure. Keep spending at zero.
- [ ] Record actual certification acceptance of acquisition/content handling and
      independent background GPU/network features, with their disclosed controls.
      Review current account-type eligibility and the updated developer agreement
      before submission; do not accept legal terms without the required owner
      confirmation. An updated-agreement notice was observed earlier; this
      session did not accept an agreement. Recheck the actual agreement status
      before publication; product reservation is not agreement approval.
- [ ] Test genuine signed GUI and independently installed Worker on Windows 10
      22H2 x64 and Windows 11 x64: fresh setup, accounts, Library/import/playback/
      export/share, same recipe GPU processing, Chrome and all accepted journeys.
- [ ] Prove GUI-close and GUI-uninstall Worker continuation, Worker StartupTask,
      disabled controls, logoff cleanup, independent updates/uninstall/reinstall,
      data preservation after both packages are removed/reinstalled, and
      hostile/copied/wrong-package denial.
- [ ] Record OS/GPU/driver/package/identity/timing/output and cleanup evidence.
      The named Z440 is a Windows 11 GPU target; it cannot close Windows 10
      acceptance merely by compiling with minimum-version settings.
- [ ] Reconcile all task, parity and release ledgers with actual evidence. Report
      incomplete certification/capability/Windows gates plainly; publish or deploy
      only with the applicable direct authorization.

Exit: installable, accepted Store route with feature and physical proof, not only
an uploaded archive or reserved app name.

## Primary guidance and source boundaries

- [Microsoft Store signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options): free Store signing applies to MSIX submissions after certification, not the previous standalone EXE signing path.
- [Currently applicable Store policies 7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policy-archive/store-policy-7-19) and [policy change history](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies-change-history): review content, rights, background behavior, disclosure, account type and certification requirements; version 7.20 takes effect on 2026-10-22.
- [Microsoft Store MSI/EXE package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements): Store package signing is distinct from publisher-signed direct MSI/EXE distribution.
- [Microsoft MSIX signing and package integrity](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview): preserve package contents/integrity instead of assuming individual inner Authenticode signatures.
- [Microsoft flexible virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization): account for real HKCU/AppData visibility, preservation and the Windows 10/11 namespace differences; restricted capability approval is separate.
- [Microsoft desktop packaging extensions](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/desktop-to-uwp-extensions): StartupTask, protocol and execution-alias activation need actual manifest/runtime tests.
- [GetPackageFullName](https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getpackagefullname): query living process identity through held handles rather than trusting caller labels.
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): desktop-app policy is a distinct creation boundary; a successful attribute call alone is not proof of the resulting namespace or lifetime.

These references support the migration design; they do not prove our exact
manifests, capability approvals, Chrome compatibility, Store certification or
installed behavior. Recheck current official guidance at implementation/release
time and retain the evidence boundary in every status report.
