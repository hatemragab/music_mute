# Private Store certification review packet — 15 October 2026

Draft certification/waiver review text, not a submitted certification request or
approval. Both original unsigned MSIX archives passed production readback. The
original GUI archive was uploaded but rejected by Partner Center validation.
Fresh current-source GUI and MDX Worker directories subsequently passed their
genuine production builds and receiving audits on the Z440. Both new SDK archives
passed production readback and verified Desktop delivery. Eight production-core
DirectML calls passed exact output parity and warm-model reuse. New-package
upload and installed qualification remain pending.
Installation, feature/lifecycle acceptance, installed Store GPU acceptance and Windows
10 device acceptance remain open. Exact
artifacts and receipts are in the
[15 October evidence](IMPLEMENTATION-2026-10-12.md#15-october-package-first-resume).

## Submission facts

The [current release-material index](STORE-REVIEW-READINESS-2026-10-15.md) links
the completed EN/AR draft fields, reviewer instructions, privacy text and exact
third-party inventory/source proofs. Both products' draft privacy text and
reviewer descriptions were saved and read back; all four listing-text records
match the prepared copy. This does not close the approval, screenshot,
credential, rights/consent or signed-installation gates.

| Product          | Store ID       | Package identity                | Version   |
| ---------------- | -------------- | ------------------------------- | --------- |
| MusicMute        | `9P7VX8JK8B68` | `27120VCHATSDK.MusicMute`       | `0.1.0.0` |
| MusicMute Worker | `9P4GXB0NRJDG` | `27120VCHATSDK.MusicMuteWorker` | `0.1.3.0` |

Publisher: `CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E`; publisher ID:
`5q1esjnkz8cve`. Both are independent x64 main packages, minimum Windows 10
22H2/build 19045, supporting Windows 11 x64. ARM, x86 and emulated ARM are
unsupported. Current candidates use `unvirtualized-candidate-v1`,
`win32App`/`mediumIL`, requesting `runFullTrust` and `unvirtualizedResources`.

MusicMute owns the Electron UI, account/Library/player functions, shared-extension
assistance and native Chrome host. Worker owns bundled Node, Python/DirectML,
engine, media/acquisition tools and session/Prepare/personal/fleet agents.
Standard-user Worker operation is designed to continue independently of GUI
windows while the user remains logged in; no administrator service, SYSTEM task,
WinSW or new driver is requested. Its `MusicMuteWorkerStartup` task is initially
disabled and must respect Windows/user controls. Fleet work requires explicit
enrollment and backend approval.

The existing model and production recipe remain unchanged: default
`kim-vocals-v2`, revision 6, trim/denoise disabled, MP3 160 kbit/s, 44.1 kHz stereo.
The existing trim variant remains supported. Inference requires a qualified
DirectML GPU; CPU decoding/DSP/encoding is permitted, with no silent CPU/cloud
inference fallback. The model is retained between serial songs in the logged-in
session. Historical warm timings are not signed-package acceptance.

## Capability explanations — separate Partner Center fields

### MusicMute — `runFullTrust`

MusicMute is an existing Win32/Electron desktop application running as the
standard logged-in user at medium integrity. It needs desktop file access for
user-selected media and Library/playback/export, native protected-resource and
process-identity checks, authenticated IPC with the separately installed Worker,
and its bundled native Chrome messaging host. These functions require desktop
APIs and native processes; we are not requesting elevation or a machine service.

### MusicMute — `unvirtualizedResources`

We request visibility of MusicMute-owned per-user data to the independent Worker
and of the native-host registration to unpackaged Chrome. The native-host key is
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.musicmute.local`;
shared private data is under `%LOCALAPPDATA%\MusicMuteLocal`. Package-private
virtualization would separate these consumers. GUI and Worker also share the
volatile current-user boot witness `HKCU\MusicMuteConsumerBoot-v1\id`, used to
bind GPU qualification and runtime readiness to the current boot. Retaining model/Library/state
across ordinary package replacement and uninstall/reinstall is also an intended
requirement. The candidate disables HKCU and AppData write virtualization;
approval and actual namespace/data-retention behavior remain unproved.

### MusicMute Worker — `runFullTrust`

Worker is a separate standard-user desktop runtime. It launches bundled Node,
Python, DirectML, media/provider tools and native guardians for local processing
and explicitly enrolled fleet work. It uses native process/Job and GPU ownership
checks, private user files and authenticated IPC with MusicMute/Chrome roles.
Its session is independent of the GUI process and ends at logoff. No elevation,
SYSTEM service or driver installation is requested; background processing and
network/resource use must remain disclosed and controllable.

### MusicMute Worker — `unvirtualizedResources`

We request access to the same guarded `%LOCALAPPDATA%\MusicMuteLocal` data as the
independently installed GUI and logged-in session roles, including model, jobs,
private credentials and recovery state. Per-package AppData virtualization would
split that shared namespace. Worker code stays in its immutable Store package;
this request does not authorize executing mutable downloaded runtime archives.
The Worker-specific HKCU need is the same guarded volatile boot witness,
`HKCU\MusicMuteConsumerBoot-v1\id`, used by the separate GUI and Worker packages.
The native helper creates the key with `REG_OPTION_VOLATILE`, restricts its ACL
to the current user and SYSTEM, verifies volatility and reads/writes one
64-character hexadecimal boot identifier. The identifier survives process exits
but becomes invalid when the user hive unloads or the machine reboots; it is not
an account credential. Worker Prepare, personal processing/warm reuse and fleet
admission compare that value with their boot-bound qualification/readiness
receipts. Separate package-private witnesses would split that identity despite
the shared filesystem records.

Source anchors: [native key and witness](../../../worker/native/windows-consumer/boot_identity.hpp)
(`consumerBootKey`, line 14; `consumerBootIdentity`, lines 33–55),
[Worker role admission](../../../worker/native/windows-consumer/store_data_policy.hpp)
(line 227), [Worker code binding](../../../windows-desktop/src/main/session/store-node-issuer.ts)
(`codeView`, lines 2096–2124), [Prepare comparison](../../../windows-desktop/src/agent/store-prepare.ts)
(line 66), [personal/warm comparison](../../../windows-desktop/src/main/personal/store-runtime.ts)
(lines 150–165), [fleet comparison](../../../windows-desktop/src/main/fleet/store-worker-runtime.ts)
(line 137), and [GUI-side Worker binding](../../../windows-desktop/src/main/browser/store-native.ts)
(lines 741–758). Microsoft's [virtualization documentation](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)
describes runtime HKCU writes as private per-package by default and the disabled
property as exposing them outside the package. This supports the requested
cross-package witness; it does not establish Microsoft approval or actual
installed namespace behavior.

Worker startup uses the OS [StartupTask adapter](../../../worker/native/windows-consumer/store_startup.hpp)
(`GetForCurrentPackageAsync`, lines 126–131), with no registry Run-key fallback.
Chrome registration remains GUI-owned. The current
[native namespace validator](../../../worker/native/windows-consumer/store_namespace.hpp)
(lines 98–101 and 129–130) also requires both virtualization properties disabled;
a filesystem-only manifest would fail that existing gate. No manifest or native
authority change is proposed by these notes.

**Approval limitation:** Microsoft's
[capability list](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations#restricted-capabilities)
describes `unvirtualizedResources` primarily for certain desktop games and
external-location packages, not ordinary other scenarios. This audio application's
request may be refused. Explain each product's actual need in
[Submission options](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options#restricted-capabilities);
do not present the requested manifest as Microsoft approval.

## Actual upload validation and hidden-entry waiver requests

The complete GUI file at
[MusicMute-0.1.0.0-x64.msix](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/MusicMute-0.1.0.0-x64.msix)
was independently verified as 167,074,767 bytes, SHA-256
`f127ae6344ad510693a99d67a8b985ab4fb3c86157104293854eb6cbe62a0e02`,
then uploaded to MusicMute Submission 1. Partner Center rejected package
acceptance because it detects a headless application and this product lacks the
`HeadlessAppBypass` waiver. The same screen warns that `unvirtualizedResources`
requires approval. Packages cannot be saved with this validation error. See the
[actual error screenshot](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Partner-Center/gui-headless-validation-error.jpg).

- MusicMute `9P7VX8JK8B68`: request `HeadlessAppBypass` for its separate hidden
  `MusicMuteChromeHost` Application. It declares `AppListEntry="none"` and a
  console app-execution alias so Chrome can launch the single shared native
  messaging host without adding a second visible launcher. The main MusicMute
  GUI remains visible. This is a Partner Center waiver request, not a new
  manifest capability to add.
- Worker `9P4GXB0NRJDG`: prepare a separate waiver request for the hidden
  `MusicMuteWorkerSession` Application (`MusicMuteSession.exe`), which declares
  `AppListEntry="none"` and owns the initially disabled StartupTask. The visible
  Worker controls remain available. The equivalent hidden-entry requirement is
  inferred from the current manifest; Worker has not been uploaded and no
  Worker-specific validation response has been observed.

The [existing manifest source](../../../windows-desktop/packaging/store/manifest.ts)
declares those hidden entries at lines 88–95 and 102–109. Neither waiver has been
requested or approved, and neither product has been submitted for certification.
Retain the current manifest/features while requesting the necessary permissions;
do not remove the Chrome host, session or startup behavior to evade validation.

### Ready-to-send Microsoft support request

**Draft only; no support case has been created.** Partner Center's Apps and games
support link opened Engage Center, but its support blade and Home remained at an
empty/loading view after signing in with the developer account and one reload.
The alternative Partner Center request list showed no support requests; the
public support form did not offer an Apps and games category. Do not describe
these attempts as a submitted waiver request.
The owner subsequently asked to leave this prepared request for them to submit
later; no further support submission is authorized by that reply.

**Subject:** Request HeadlessAppBypass for MusicMute and MusicMute Worker

Please review the hidden helper applications for these two desktop products:

- MusicMute, Store ID `9P7VX8JK8B68`, identity `27120VCHATSDK.MusicMute`.
  Its visible main application provides account, Library and playback. Its hidden
  `MusicMuteChromeHost` application supplies a console execution alias used by
  the shared Chrome native-messaging extension. It runs as the logged-in user
  without elevation; it is not a Windows service.
- MusicMute Worker, Store ID `9P4GXB0NRJDG`, identity
  `27120VCHATSDK.MusicMuteWorker`. Its visible main application provides Worker
  controls. Its hidden `MusicMuteWorkerSession` application runs the independent
  logged-in-user processing session and an initially disabled StartupTask. It
  ends at Windows sign-out and does not install an administrator/SYSTEM service.

Both target Windows 10 22H2/build 19045 and Windows 11, Intel/AMD x64 only.
Distribution is restricted to the owner's private tester group, with manual
publishing holds; no public release is requested. The GUI package's upload was
rejected specifically for missing `HeadlessAppBypass`; the screenshot linked
above records that response. The Worker hidden entry has the same manifest
setting but has not yet been uploaded. Please confirm the waiver route and,
if approved, associate the permission separately with both products.

Both products also request `unvirtualizedResources` for guarded shared per-user
data and their shared volatile boot witness; MusicMute additionally registers
its native host for unpackaged Chrome. Those capability requests require their
own review. This request makes no assertion that either permission has already
been approved or that certification has been completed.

## Certification test instructions — expected behavior to verify

1. Use a standard-user x64 Windows account and a qualified DirectML GPU. Acquire
   both products through the authorized private Store route. Confirm their exact
   registered identities and Store signatures; unsigned Desktop archives are
   not an equivalent installation. Test Windows 10 22H2 and Windows 11 separately.
2. Open MusicMute Home and run Prepare. Executable runtime code comes from Worker;
   Prepare obtains/verifies model and qualification data. Test success, cancel,
   offline prepared use and missing/incompatible Worker guidance.
3. With owned test media, process the same song twice using the default recipe;
   verify GPU qualification, fresh jobs, model reuse, playback/export and Library.
   Check cancellation/error cleanup. Do not promise historical timing results.
4. Test signed-out local processing. For account/fleet tests, use a working demo
   account and server supplied separately in secure certification fields. Check
   explicit enrollment, pause/stop and independent Worker behavior after GUI close
   and sign-out. On disposable test data, verify GUI removal while Worker remains,
   Windows startup controls, logoff cleanup and update/reinstall retention.
5. In Chrome, follow the app's extension assistance: open `chrome://extensions`,
   enable Developer mode, choose **Load unpacked**, and select the folder shown
   by MusicMute. Use the single shared extension ID
   `acmgefmmndomcpdlgnafkjbgobinllep` and native host `com.musicmute.local`; do not
   create a Windows-specific extension. Verify host connection, account callback
   and a permitted import. Chrome Web Store delivery is not asserted here.

## Private delivery and signing controls

Both drafts are saved as **Private audience**, **Free**, with the owner's
**MusicMute Z440 Private Testers** known-user group. Its supplied personal
Microsoft-account address is retained privately; no tester address or
credentials are included here. Leave any
**Make this product public on** date unset. Work/school Entra accounts cannot
acquire a private-audience app. See
[private visibility](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options).

Select manual publishing hold while review is incomplete. Certification alone
does not provide a documented signed test download: Microsoft signs during the
[Publishing phase](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process#publishing).
The owner explicitly authorized **private tester-only publication after
approval**; it has not occurred. This remains a release action, although it is
not public release; only then can allowed testers acquire it through the Store.
Public publication and paid signing remain unauthorized. Package flights require an already-published initial
submission, which can be private; they are not the first-draft shortcut.

## Resolve before making submission declarations

- The [policy review](POLICY-REVIEW-2026-10-12.md#actual-runtime-redistribution-gaps)
  initially identified `diffq_fixed` 0.2.4/CC BY-NC 4.0 without a retained
  component-specific commercial redistribution grant, missing Python/native
  notices and FFmpeg/LAME source/relink materials. Five exact notices and their
  independently checked provenance are now required by the Store staging and
  receiving audit. Scratch media-source reconstruction and Windows relink/output
  checks now pass; original-build correspondence and recipient-delivery review
  remain open.
  Package byte audits establish
  neither redistribution rights nor fulfillment of those obligations. Reconcile
  evidence for the intended distribution; do not assert a legal clearance. The
  owner reports no dependency-specific diffq authorization. The original Worker
  archive still contains it. A finite MDX-only Store projection now accounts for
  the unused dependency separately, preserving the original full source lock,
  upstream metadata/license evidence and every retained pin. Its fresh Python
  projection and complete Worker assembly passed on Windows, including source
  and relocated import probes. Eight production-core default/trim cold/warm
  calls subsequently passed exact byte/hash/sample/timeline output parity.
  Source changes do
  not relabel the original archive or establish distribution readiness.
- Exact FFmpeg/LAME source archives, matching licenses, the verified FFmpeg
  signature, observed Windows FFmpeg flags and a six-step rebuild/relink procedure
  are available in the [draft source bundle](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Source-Materials-DRAFT-2026-10-15/MusicMute-Windows-media-source-materials-DRAFT.zip).
  The 13,029,723-byte file has SHA-256
  `c4f41cd43e889fd96242fe50c5db0fe6bf7266a0621363fb04a6aacc7443bf28`;
  all 16 entries passed full-byte and CRC checks. Original Windows LAME build
  configuration/patch provenance was not recovered. A later scratch rebuild on
  the Mac succeeded with a newly installed MinGW GCC 16.2.0 toolchain, followed
  by a modified-LAME static relink. All 10,219 original extracted source files
  stayed unchanged. This is an explicit new reconstruction, not the recovered
  original build recipe or a bit-identical reproduction. The subsequent Windows
  scratch run passed all six calls and complete MP3/decoded-audio byte parity,
  with the diagnostic marker emitted only by the relinked encoder. Its genuine
  configure/compile guard receipts confirmed whole-Job zero and stream EOFs.
  Actual shipped FFmpeg readback recovered `built with gcc 16.2.0 (Rev3, Built by
MSYS2 project)` and the observed configuration, without recovering the original
  toolchain hashes or LAME flags/patch record. See the
  [actual Windows media proofs](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Media-Proofs-Current-2026-10-15-qa09/FILES.json).
  Recipient-delivery qualification remains pending; the earlier draft ZIP has
  not been relabeled as complete corresponding-source or legal clearance.
  The latest [reconstruction proof draft](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Source-Materials-Reconstruction-DRAFT-2026-10-15/musicmute-windows-media-source-proof.draft10.zip)
  retains the actual successful Mac commands/logs, full source archives,
  modified-library relink evidence, all 22 original successful Windows media09
  proofs, the preserved failed media07/media08b history and a portable replay
  adapter. Its 171 entries passed complete census, full-byte/hash and CRC checks:
  13,291,427 bytes/SHA-256
  `37dd28dbd0d25b07b2a3099c5441552dc6cf7cd8047fd604bed1b7541ecebc2a`.
  The complete portable replay build has not itself been rerun; original-build
  correspondence, recipient-delivery qualification and legal review remain open.
- Disclose the separate Worker dependency at the beginning of each relevant
  listing, GPU requirements, background network/resource use and consent controls.
  Explain existing fetched challenge-code evaluation by acquisition tooling in
  certification notes; bundled tools and user assertions do not establish
  third-party service/content permission.
- Supply accurate EN/AR listings, screenshots, privacy/support URLs, test-account
  access and a working backend. Review account eligibility and any updated
  developer agreement with the owner; do not accept terms or submit incomplete
  rights/capability declarations by assumption.
- [ ] Update privacy coverage before certification. The live
      [privacy page](https://api.music-mute.com/privacy), dated October 8, 2026,
      explicitly covers Android/iOS/web/Mac/Chrome and describes Mac Keychain and
      native runtime downloads. Windows independent Worker operation, DPAPI and
      the bundled Store runtime differences are not yet covered. Use this URL
      only as a draft reference until those disclosures are accurate; no backend
      or policy deployment is authorized by this packet.
- [x] Save accurate Windows EN/AR privacy text directly in both private Store
      drafts, using the supported text alternative, and verify exact persisted
      content after reopening. The current [privacy material](PRIVACY-REVIEW-DRAFT-2026-10-15.md)
      covers local/cloud/catalog transfers, DPAPI, the independent Worker and the
      shared extension. The in-app hosted policy and final consent review remain
      open; draft text is not public-policy deployment or Microsoft approval.
- Policy 7.19 remains the applicable dated version on October 15; the published
  [7.20 policy](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)
  becomes effective October 22, 2026. Recheck at the actual submission date.

## Current source checks and remaining Windows proof

Local checks passed: 61 Worker consumer-package tests and 196 focused desktop
Store packaging/staging/projection tests; TypeScript checks in both components;
scoped lint and Prettier checks. The Store-only projection preserves the exact
63-distribution source lock, explicitly expects 62 product distributions,
accounts for 20 existing auxiliary omissions plus 16 pinned unused diffq leaves,
and preserves 14 pinned upstream source/METADATA files. A separate finite
27-leaf development-input curation now runs in the genuine Store assembly hook
before its relocated runtime probe, preserving excluded copies and complete
before/after censuses outside the new package. Legacy verification and receiving
audits remain strict; model, recipe, GPU numerics and shared extension are unchanged.

The fresh Windows Python projection passed its production probe. Earlier failed
build/harness cohorts are preserved in the implementation ledger. The successful
matched17 run independently admitted 8,423 source files, built the full GUI and
then assembled Worker against the same freshly compiled source. Both genuine
production builds and receiving checks passed. The corrected QA20 harness then
completed eight actual production-core DirectML calls, comparing the original
63-distribution and new 62-distribution profiles for default/trim cold/warm runs.
Complete output bytes/hashes, recipe/model digests, samples and trim timelines
matched; warm runs retained the same model graph. Both runtime releases were
fully reverified unchanged afterward. The temporary harness corrections did not
change the products. Actual new-profile timings on the same 283.562-second song
were 50.716/33.031 seconds default cold/warm and 51.165/33.378 seconds trim.
See the [actual GPU parity receipt](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/GPU-Proofs-Current-2026-10-15-qa20/parity20-evidence/parity20-result.json).
Store signature, installation, account/Chrome and feature/lifecycle acceptance
remain open. Both fresh SDK packages also passed
full production archive readback and verified delivery to
`C:\Users\hatem\Desktop\MusicMute-MSIX-Current-2026-10-15-ab42e4db`.
The GUI archive is 167,074,916 bytes/SHA-256
`99ffc7819c3478f2fa2c7966fa66189cf467c22c2f74f6d17f35111b8f7c40f5`;
Worker is 424,942,319 bytes/SHA-256
`aa5d7c08b7edaed2f541d91635f2c845709f167418e499819c3ad92ad93f84a5`.
The [actual new archive receipt](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Build-Proofs-Current-2026-10-15-ab42e4db/msix20/archive-receipt.json)
records unsigned, noninstallable, release-not-ready status. These files have not
been uploaded and do not replace the historical rejected upload record.

The existing Store GUI candidate also rejects unpackaged execution before window
creation. No supported interactive development route was found in the current
source. Authentic Windows feature screenshots remain open; a generic startup
error, a fixture renderer or a mocked view is not an installed feature result.

## Proposed Windows privacy addendum — owner-review draft

**Draft only; not deployed to the privacy page.** The text below describes reviewed
Windows client behavior. The owner must confirm service-side practices and the
installed Store behavior before approving publication.

**Windows applications and local storage.** MusicMute for Windows uses two
separately installed applications: MusicMute for the interface, account, Library
and playback, and MusicMute Worker for processing. User-selected media, local
results, Library records, preferences, model files and temporary work are stored
in guarded per-user Windows locations. Sign-in/session credentials, installation
guest credentials and independently enrolled Worker credentials use the Windows
Data Protection API (DPAPI) for the current Windows user, rather than macOS
Keychain. This credential protection is not a statement that all cached media is
encrypted.

**Local processing and network activity.** Local processing can be used without
signing into a MusicMute account and uses the prepared model on the device's
qualified GPU. It does not silently switch inference to the cloud. However,
"local" does not mean that every related feature is offline: preparation,
public policy checks, online-media acquisition, shared-catalog reuse and account
saving can contact network services.

**Shared YouTube catalog.** The client can look up existing original/vocal pairs
using a video identifier and technical media information, and download matching
results instead of processing them again. This route uses an installation-scoped
guest credential and does not require app-account sign-in. Eligible locally
processed, untrimmed YouTube results can also contribute the original and vocal
audio, with identifying media metadata and hashes, to the shared catalog. Media
upload is deferred until the client verifies first vocal playback; declaration
metadata may be sent earlier. Local file imports are excluded from this public
catalog contribution path.

**Account saving and cloud processing.** Eligible local completions captured for
a signed-in account can be queued to save original/vocal audio and job metadata
to that account. Results created while signed out require an explicit save-to-
account action; signing in later does not supply missing prior ownership. This
account-saving route is separate from public catalog contribution. Selecting
and confirming cloud processing sends the selected media or online-media link
and associated job information through MusicMute's service for remote processing,
with resulting files downloaded to the device. Current Windows cloud submission
requires app-account sign-in.

**Chrome and Worker controls.** Windows uses the same MusicMute Chrome extension
and `com.musicmute.local` native-messaging host as the other supported desktop
route. The extension and app exchange media/playback information and processing/
account commands; the saved processing-location choice is shared with the
extension. Worker runs as the logged-in Windows user and can continue after the
GUI closes. Its login startup task is initially disabled and subject to Windows
controls. Fleet processing requires explicit enrollment and approval; closing
the GUI or signing out of its account does not itself revoke an independently
enrolled Worker. Worker pause/stop/enrollment controls and Windows login lifetime
are separate from app-account sign-in.

**Updates and preparation.** Executable Node/Python/native/processing tools are
bundled in the Store packages; their executable updates use the Store route.
Prepare downloads and verifies model/qualification data, rather than installing
the macOS-style external executable runtime archive. Acquisition tooling's
existing fetched challenge-code evaluation remains a separate disclosure/review
item; this text makes no blanket claim that all network content is non-executable.

Source anchors for this proposed text, not additional public-policy assertions:

- [Per-user DPAPI boundary](../../../worker/native/windows-consumer/README.md)
  and [independent fleet credential storage](../../../windows-desktop/src/main/fleet/store.ts).
- [Guest catalog credentials](../../../windows-desktop/src/main/reuse/guest-credentials.ts),
  [catalog publication rules](../../../windows-desktop/src/main/reuse/publication.ts)
  and [personal YouTube completion path](../../../windows-desktop/src/main/personal/reuse.ts).
- [Captured-account saving](../../../windows-desktop/src/main/outbox/completion-producer.ts),
  [explicit local saving](../../../windows-desktop/src/main/outbox/local-save.ts)
  and [cloud submission API](../../../windows-desktop/src/main/cloud/api.ts).
- [Bundled Store runtime/data separation](../../../windows-desktop/packaging/store/README.md)
  and [shared-extension setup](../../../windows-desktop/src/renderer/setup-assistance-view.tsx).

Before deployment, reconcile exact server retention/deletion, disclosure of
network providers, any catalog contribution controls, and actual Store
uninstall/data-retention behavior with the deployed service and owner-approved
policy. This draft does not invent retention periods, rights grants or installed
acceptance evidence.

This packet itself does not authorize account actions, deployment or release.
Follow the owner's separate authorization for free signing, private tester
delivery and device tests. Preserve the model, recipes, quality and features;
finite packaging omissions require explicit source/pin accounting and actual
Windows validation, rather than an assumed review clearance.
