# W31 — Prepare the per-user installer and release tooling

- Status: code-complete / Windows pending; native compilation, approved release inputs and actual acceptance remain unrun.
- Code dependencies: [W10](W10-per-user-agent-and-worker-lifetime.md), [W26](W26-chrome-native-host-and-registration.md), [W29](W29-app-runtime-and-model-updates.md), [W30](W30-diagnostics-and-security-review.md).
- Accepted scope points: P06, P25, P27, P29.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [requirement-by-requirement source ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md) plus dated historical records below.

Implementation has been explicitly authorized and source checks executed. This ledger is source-only: no Windows compiler, install, signing, Chrome/GPU/device or live release operation ran. Checked source rows below cite the actual production chain and portable proof; all native acceptance rows stay open.

## Existing behavior and design consequence

A Windows consumer release requires a real x64 app/native launcher/runtime bootstrap and a no-admin installer. A fixture archive or installer assembled on the Mac is not fresh-user Windows proof.

## Read before editing

- [worker/RELEASING.md](../../../worker/RELEASING.md)
- [worker/src/platform/windows/release-builder.ts](../../../worker/src/platform/windows/release-builder.ts)
- [worker/src/platform/windows/pe-audit.ts](../../../worker/src/platform/windows/pe-audit.ts)
- [chrome-extension/docs/setup-updates.md](../../../chrome-extension/docs/setup-updates.md)
- [docs/r2-storage/README.md](../../../docs/r2-storage/README.md)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

For the sequential execution order, checkbox rules and current partial-source gaps, read [execution plan](../EXECUTION-PLAN.md), [feature acceptance](../FEATURE-ACCEPTANCE.md) and [resume gaps](../RESUME-GAPS.md).

## Implementation checklist

- [x] Implement a website-first per-user x64 NSIS installer with app identity, icons, version metadata, minimum-OS/native-architecture guards and bundled native host/helper dependencies. Provide generated-script/manifest validators for standard-user execution; actual generated candidate execution remains a Windows gate. **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Implement app-file installation under LocalAppData and register only owned HKCU startup/native messaging entries. No machine-scope selection, SCM/WinSW, HKLM, administrator requirement or manual prerequisite installation. **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Implement ordinary uninstall that stops owned processes and removes owned app/registration artifacts while preserving data by default. Keep purge and fleet revoke explicit; check shared-runtime references and leave legacy services untouched. **Source proof: P-retention** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Prepare reproducible Windows build/package/signing scripts, Authenticode publisher/timestamp verification, PE architecture/inventory audits, checksums, license notices and secret-free build configuration. **Source proof: P-sign** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Add release checks that reject placeholder hosts, missing native binaries, test fixtures, unsigned production executables where signing is required, wrong profile/architecture and credentials in artifacts. **Source proof: P-input** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Prepare immutable release paths/manifests in the designated public downloads bucket only; keep application media private and model at its approved upstream source. Do not invent or publish URLs in this task. **Source proof: P-distribution** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Document how authorized publishing will upload, read back hashes/sizes, test a real downloaded installer and verify rollback. Store submission and signing-account procurement remain external release decisions, not coding blockers. **Source proof: P-distribution** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).

## Code validation checklist

- [x] Run installer configuration/static-script and package-fixture tests for per-user scope, quoting, architecture/minimum-OS guards and uninstall allowlists. **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Run host-buildable bundle/inventory/license/secret checks; record all native packaging/signing operations not run. **Source proof: P-graph** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Verify release candidate validation fails closed on placeholder downloads or missing signatures/native payloads. **Source proof: P-input** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).

## Windows acceptance — deferred until W34

- [ ] Build and sign the actual x64 installer using an authorized signing setup, then test a clean non-admin Windows install/update/uninstall.
- [ ] Verify downloaded-file signature/reputation behavior, fresh runtime preparation and exact published artifact readback only after publication is authorized.

## Detailed AI-agent handoff — reviewed 2026-10-09

### Current source and build boundary

The [desktop package manifest](../../../windows-desktop/package.json), [bundle script](../../../windows-desktop/scripts/build.mjs), [boundary fixtures](../../../windows-desktop/scripts/build-boundaries.test.mjs), [native build gate](../../../windows-desktop/scripts/native-check.mjs) and [Win32 CMake source](../../../worker/native/windows-consumer/CMakeLists.txt) are exercised source tooling; the per-requirement ledger identifies actual release/signing/maintenance bindings. They do not establish approved inputs, a compiled/signed NSIS package, native PE or Authenticode success. Source-only checkboxes and actual package/Windows checkboxes are distinct.

### Fixed release contract

| Item                   | Required contract                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                   | Windows 10 22H2 build 19045 minimum and Windows 11, native AMD64; no ARM/emulation/x86/Server promise                                                                                                          |
| App install            | Fixed current-user `%LOCALAPPDATA%\Programs\MusicMute Local`; `asInvoker`, no all-users mode/elevation helper                                                                                                  |
| Payload                | Actual x64 app, `musicmute-native.exe`, `MusicMuteSession.exe`, `MusicMuteChromeHost.exe` and verified CJS role entries                                                                                        |
| NSIS wrapper           | A signed x86 NSIS bootstrapper is acceptable only with x64 payload and verified native-host guards; wrapper PE architecture is distinct from payload support                                                   |
| Mutable runtime/data   | Existing private per-user roots outside the app, verified runtime/model installed by Prepare; ordinary replacement/uninstall preserves data                                                                    |
| Browser/login/protocol | Owned HKCU Chrome views, startup and reviewed `musicmute-local` URI registration only                                                                                                                          |
| Trust/resources        | Real native/launcher/browser manifests, runtime trust metadata/keys, app update channel and optional approved worker catalog channel/current payload identity, approved shared extension key and public config |
| Distribution           | Website-first approved release artifacts; application media remains private R2, no fabricated download URL or publication in this task                                                                         |

### Ordered implementation/review sequence after authorization

- [x] Inventory the real build graph and runtime/native dependencies before adding packaging files. Define reproducible pinned tooling, source/version identity and allowlisted staged inputs; generated output never proves a missing input exists. **Source proof: P-graph** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Implement explicit per-user NSIS configuration for pinned electron-builder 26.15.3: `oneClick: true`, `perMachine: false` and `packElevateHelper: false`, plus the fixed current-user destination, `asInvoker` manifest and generated-script guards rejecting `/allusers`/destination overrides. `allowElevation: false` alone is insufficient: v26 applies that option to assisted installers, and `oneClick: false` with `perMachine: false` still exposes an install-mode choice. Audit the actual generated script/PE/payload rather than infer no-admin behavior from flags alone. **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Enforce actual native AMD64/minimum build at installer, launcher and runtime boundaries. Reject ARM64 emulation, x86 hosts and old Windows before writing/starting payload. A 32-bit wrapper must query native host architecture rather than infer it from its own process bits. **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [ ] Build all real native executables for x64 on Windows with intended static/dependency linkage and `asInvoker`. Bundle Node/CJS entry dependencies and required notice files. Reject placeholder executables, export-only role bundles, missing DLLs or developer-only path references. **Source proof: N-build** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w03-security-and-native-source)).
- [x] Stage only approved release resources with exact schemas/hashes/sizes: helper, installed session launcher, Chrome host/entry/shared extension manifest, runtime/fixture trust and update/current app identity. Missing public configuration or trust input blocks a production package; do not fill it with demo keys or guessed endpoints. **Source proof: P-input** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Keep thin fresh install honest. The small native host can explain Setup needed; Prepare has real signed runtime/model/fixture metadata and approved downloads before the app can claim Ready. An already prepared developer machine is not a fresh-user release test. **Source proof: P-input** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Register stable app identity, icons/version, current-user shortcuts and approved URI handler safely. The URI dispatch accepts only the bounded public cloud handoff fields; no arbitrary executable, auth/rights token or automatic billing parameter. **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Install/repair only owned HKCU startup/Chrome/protocol bindings. Respect disabled startup and enterprise/browser policy. Treat a foreign registry binding as a conflict rather than replacing an unrelated installation; no HKLM/SCM/WinSW/driver prerequisites. **Source proof: P-retention** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Implement replacement/update sequencing with W29 maintenance and exact owned process proof. App files may change only after the necessary active consumers are safely fenced; do not force-kill accepted fleet work merely to satisfy an installer deadline. **Source proof: P-maintenance** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Implement normal uninstall with an explicit owned-artifact allowlist: stop the current owned consumer processes, remove app/owned registrations/shortcuts, and preserve runtime/model/Library/preferences/account vault/fleet identity/outboxes by default. Purge/revoke are separate explicit actions; leave legacy services and other users untouched. **Source proof: P-retention** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Define signing order: compile and sign relevant inner PEs, derive final byte/hash manifests, bundle/sign app and installer, then compute final distribution digest/size and sign channel metadata. Keep logical app payload identity separate from installer artifact digest to avoid a circular hash. **Source proof: P-sign** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Implement approved publisher, timestamp and trust-policy verification for every required signed PE/installer. Do not embed signing secrets in the repository/package. Signing-account procurement and SmartScreen reputation are external evidence, not a reason to substitute a fake signature. **Source proof: P-sign** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Prepare immutable approved artifact names/manifests, checksum/notice inventory, SBOM/dependency license record and secret scan. Public release downloads must not include private media, fleet credentials, Firebase Admin/R2 keys, local vaults, user files or test fixtures. **Source proof: P-notices** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Prepare the authorized publication procedure only: upload reviewed exact bytes to the designated downloads destination, read back size/hash/signature, download the public candidate and repeat fresh install/update/rollback. Do not publish from this task or claim a public link until actual verification. **Source proof: P-distribution** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).

### Package/installer failure fixtures

| Input or failure                                                      | Required rejection/preservation                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| x64 process running on ARM64 or Win10 19044                           | Reject unsupported native host before installation or Prepare                                         |
| Signed I386 NSIS wrapper + approved AMD64 payload                     | Permit only with verified fixed scope/host guards; do not reject solely because the wrapper is 32-bit |
| `/allusers`, changed `/D`, elevated manifest or packed elevate helper | Reject scope override; no UAC/machine install path                                                    |
| Missing helper/launcher/browser entry/trust resource                  | Package/validation fails; no placeholder successful Prepare/Chrome capability                         |
| Shared extension manifest key/ID differs from approved Mac source     | Reject package, preserving one extension identity                                                     |
| Reinstall sees startup disabled or foreign Chrome/protocol key        | Preserve user choice/foreign key; return explicit repair/conflict state                               |
| Uninstall interrupted with pending outbox/fleet identity              | Preserve user data/credentials and allow bounded owned cleanup recovery                               |
| Signer untrusted/changed, wrong final hash or unknown file in stage   | Reject release candidate and require approved input/review                                            |

### Code-only checks and deliverables

- [x] Test installer configuration plus generated/static script assertions for fixed scope, override rejection, host guards, quoted Unicode paths and uninstall allowlists. Include negative fixtures; configuration snapshots alone are insufficient. **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Run existing desktop bundle/package-boundary fixtures, typecheck/build and exact resource parsers. Inspect staged inventory/import/license/secret reports without running Windows executables on the Mac. **Source proof: P-graph** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Test verifier behavior with synthetic PE/manifest/signature metadata only where the check is portable; label this separately from real Authenticode and NSIS execution. **Source proof: P-sign** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
- [x] Deliver production build/package/signing scripts, required approved input checklist, executable/inventory/notice reports, uninstall retention table and a dated release-candidate evidence template. No task checkbox may mean signed/published when only source or synthetic fixtures passed. **Source proof: P-distribution** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).

### Deferred Windows acceptance

- [ ] Build/link x64 native source with actual Windows tooling, sign under the authorized publisher, inspect final manifests/imports/payload architecture and verify final installer bytes.
- [ ] Fresh-download install under a clean authorized standard-user Win10 19045 profile and each covered Win11 build; verify no UAC, no manual prerequisite, real Prepare/GPU and actual same-extension Chrome handshake.
- [ ] Test repair/reinstall/update/rollback/uninstall with spaces/Unicode, disabled startup, active consumers, open-file/antivirus failure and retained outbox/data. Record exact owned registry readback and no service/HKLM changes.
- [ ] Verify signature/timestamp/revocation and downloaded-file/SmartScreen behavior separately. A valid signature does not guarantee established reputation or absence of warnings.
- [ ] Publish only after separate user authorization and real release-candidate acceptance; verify public readback and fresh downloaded install after that action.

### Primary references and their consequence

- [Stable electron-builder v26 NSIS configuration](https://www.electron.build/v26/docs/nsis/) and [v26 NsisOptions](https://www.electron.build/v26/docs/api/electron-builder.interface.nsisoptions/): use version-matched semantics for the [26.15.3 package lock](../../../windows-desktop/package-lock.json), not unversioned/prerelease documentation. The installed `app-builder-lib/out/targets/nsis/nsisOptions.d.ts` declares the same assisted-versus-one-click mode rules; verify the pinned declarations and generated installer before release.
- [NSIS command-line semantics](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage): destination overrides are real installer inputs and must be constrained by the fixed-scope design.
- [Windows Run keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys) and [Chrome native messaging registration](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): use stable owned current-user bindings and platform-specific registry views.
- [WinVerifyTrust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust): actual trusted signature verification is distinct from a synthetic PE/metadata audit.

## Implemented tooling and pending approved resource checklist

Actual build/NSIS/signing/inventory tooling is source-implemented and portable-tested.
Approved production inputs and the generated/signed Windows candidate remain absent;
source output is not an installable release.

- [x] Write actual package scripts/configuration and source-audit the pinned NSIS transform; audit generated candidate on Windows: **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
      `oneClick=true`, `perMachine=false`, `packElevateHelper=false`, fixed user
      destination and no machine/elevation/destination override.
- [x] Require approved app build/payload identity, helper/host/CLI inventories, **Source proof: P-input** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
      extension identity, public account config, runtime-source descriptor, model/
      fixture pins, update trust and publisher. Missing inputs fail release pack;
      fixture assets never become production resources.
- [x] Define signing order; separate logical payload, final signed PE hashes and **Source proof: P-sign** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
      installer hash to avoid circular pins. Verify publisher/resource inventory
      after signing and before publication.
- [x] Implement separate signed-wrapper versus AMD64 payload/helper audit: 32-bit NSIS **Source proof: P-installer** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
      does not authorize x86/ARM support. Host gates remain x64/22H2 plus Win11.
- [x] Prepare fixtures/dry-run without signing credentials or installed-state **Source proof: P-input** ([ledger](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source)).
      mutation. Real signing/install/native/public download proof stays separate.

## Completion record

### Independent worker/package source closure — 2026-10-09

- [x] Code-test pinned installer/asset/notice source and mandatory independent `agent/login-worker.cjs` entry, including missing-entry rejection with no published output.
- [x] Source-preserve private worker shim, approved public capsule, runtime/model, DPAPI credentials and Run across ordinary GUI uninstall; explicit Stop/Remove/Purge remain distinct authorities.
- [x] Complete package/harness/source checks in [audit evidence](../evidence/W03-W31-W33-2026-10-09-audit.md), including Root's 1,424-test Desktop checkpoint and actual CJS build.
- [ ] Build/sign/inspect real NSIS/x64 payload and perform standard-user install/update/uninstall plus retained-worker relogin on Windows. Approved production inputs/signing/publication remain separate requirements.

### Source checkpoint — 2026-10-09

Later concrete source fixes and checks are in the
[native/package audit](../evidence/W03-W31-W33-2026-10-09-audit.md).
The exact pinned v26 startup transform retains default signed-uninstaller
generation, exits its temporary generator before installed-folder mutation,
and tests every ExecWait launch error. Fixed signed-parent native preflight
retains bounded ancestor/directory references through extraction/uninstall.

- [x] Require exact Noto Arabic font/OFL, pinned Electron MIT and Google brand
      attribution/usage notice in source-derived staging, verify actual inside-ASAR
      copies and record their hashes in payload evidence; temporary real-ASAR
      inclusion/mismatch fixtures pass. This is package-source proof, not a signed
      release or Google branding/OAuth approval.

- [x] Add a strict approved-input recipe and ASAR-sealed resource loader, including
      explicit numeric build metadata, approved publisher/name, actual shared
      extension identity, signed consumer runtime source and update trust.
- [x] Validate the pinned v26 per-user/asInvoker/fuse configuration schema and
      portable inventory/hash/secret/placeholder/peer/ACK-loss fixtures.
- [x] Bundle and audit all nine actual executed entry graphs and collect their existing dependency
      notices; fail a candidate with absent resources or a missing trusted entry.
- [x] Write real signing/uninstaller/final-inventory and authenticated maintenance
      source, with exact owned-file cleanup and DPAPI protocol-prefix recovery.
- [ ] Run the actual Windows compiler/signing/NSIS pipeline and audit its generated
      candidate. No installed/native/release checkbox above is closed by source.

See the linked evidence for current source/typecheck scope and unrun native cases.

Task/index/progress reconciliation is Root-owned; this task’s source proofs are recorded individually above. Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.

## Requirement ledger return — 2026-10-09

Every source/code checklist above cites the production-entry, resource/authority,
actual implementation, portable test and native-only gate in [W31 package and release-tooling source](../evidence/W03-W10-W26-W31-W33-2026-10-09-closure.md#w31-package-and-release-tooling-source).
Historical checked evidence is retained with its date. Current native compiler,
registry/PE/Job/Chrome/GPU/logon and signed candidate checks remain unrun.

## Final source closure supplement — 2026-10-10

The [latest receiver ledger](../evidence/W22-final-native-library-cleanup-2026-10-10.md)
records current Native Source digest
`64699a82b582061626a2fac619d8f35a9d2ac14c63e93839bd26fdbd208234fd`,
current executed source checks and the remaining native gates. Historical
`2399865...`, `3bf83...` and `64714e9f...` checkpoints retain their date and do
not cover later changes. Source/test-source receipt is separate from compiling
C++ or installing a signed candidate. No Windows checkbox is promoted.

`packaging/inventory.cjs` audits all executed Main/preload/renderer/browser-host
and session/login-worker/personal/fleet/Prepare bundle graphs for notices and
private/test inputs. Required source-built full shared extension inventory and
licensed Noto OFL/Google/Electron assets enter the approved app input/sealed index.
The optional worker-catalog update trust resource is accepted only when supplied
as a genuine approved input. Per-user oneClick:true/perMachine:false/
packElevateHelper:false, fixed path/asInvoker and pre-mutation minimum/native-x64
guards remain version-locked to electron-builder26.15.3. A signed x86 NSIS wrapper
may carry only the approved AMD64 payload on actual AMD64 hosts. Ordinary GUI
uninstall preserves the independent verified runtime/login Run bootstrap/data.
Native tool commands now require exact tools-v2/target/output/ACK and isolated
Job-zero guard; no raw PATH CMake/tool-close success fallback exists. Actual
compiler/approved asset bytes/signing/NSIS/installed/publication proof stays open.
