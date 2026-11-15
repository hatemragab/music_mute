# Store reviewer guide — 15 October 2026

Prepared instructions for the two independent private Store drafts. This is not
a certification submission, a signed installation or completed feature
acceptance. The owner will submit the Microsoft support request separately.

## Products and acquisition

| Product          | Store ID       | Package identity                | Candidate version | Role                                                                       |
| ---------------- | -------------- | ------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| MusicMute        | `9P7VX8JK8B68` | `27120VCHATSDK.MusicMute`       | `0.1.0.0`         | Interface, account, Library, playback, Prepare and full Worker management  |
| MusicMute Worker | `9P4GXB0NRJDG` | `27120VCHATSDK.MusicMuteWorker` | `0.1.3.0`         | Complete processing runtime, logged-in session and native startup controls |

Acquire both through the approved private Store route after Microsoft approval.
The current unsigned Desktop archives cannot replace that installation. Keep
both drafts on manual publishing hold. Do not use a certificate purchase,
self-signing, Windows Developer Mode or an identity bypass for this review.

## Test in this order

1. Use a standard logged-in Windows account on a supported native x64 PC.
   Confirm both registered package identities and Store origin. Record the
   installed versions; Microsoft's fourth version node may differ from the
   unsigned upload candidate.
2. Open MusicMute and complete Prepare. Verify the independently installed
   Worker, owner-source model download/integrity and real DirectML GPU
   qualification. Executable tools come from Worker; Prepare does not install a
   Mac-style external executable runtime ZIP.
3. Begin signed out with rights-owned local media. Use the default recipe and
   verify progress, complete output, original/voice playback, Library and export.
   Repeat the same input for retained-model reuse; test the existing trim recipe
   separately. Cancel another disposable job and verify cleanup/recovery.
4. Verify account sign-in, captured-account/explicit local saving, online Library
   and selected cloud processing with the dedicated reviewer account. Account
   eligibility, available allowance and network service are prerequisites for
   these online features, not for prepared personal local inference.
5. In MusicMute's Worker view, test explicitly approved fleet enrollment, start,
   pause, finish accepted jobs, resume, stop and Advanced diagnostics. An enrolled
   Worker uses GPU, storage and network resources. App-account sign-out and GUI
   close do not revoke its independent machine enrollment. Stop/drain wait for
   accepted work; Windows sign-out ends the session.
6. Open the separate MusicMute Worker application. Its native window checks
   Windows startup state and requests or disables startup at Windows sign-in.
   Startup is initially disabled. Disabling startup does not stop an already
   running session; Windows/user/administrator startup decisions remain
   authoritative. Processing and enrollment controls are in MusicMute.
7. In MusicMute Prepare, follow Chrome extension assistance. In Chrome's
   Developer mode, choose **Load unpacked** and the supplied folder. Verify the
   shared extension ID `acmgefmmndomcpdlgnafkjbgobinllep` and native host
   `com.musicmute.local`. Use a permitted source and check connection, playback
   synchronization and account handoff. No public Chrome Web Store listing is
   asserted. Chrome Developer mode is distinct from Windows Developer Mode.
8. Check updates, compatible replacement, logoff/relogin, independent Worker
   behavior after GUI removal and data retention using disposable test data.
   Do not delete real Library/model/account/browser state for a screenshot.

The eight recorded production-core GPU runs and media-tool reconstruction tests
are separate evidence. They do not close these installed checks or establish a
speed guarantee. Use the [actual implementation ledger](IMPLEMENTATION-2026-10-12.md).

## Secure reviewer access — still required

Microsoft's [certification guidance](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options#notes-for-certification)
requests working access to otherwise inaccessible features. The live Additional
Testing Information page has separate **Description** and **Credentials**
controls. Put no passwords or tokens in the description, repository or public
listing.

- [ ] Supply and test a dedicated MusicMute email test account with appropriate
      Library/cloud eligibility and allowance. Do not use the owner's personal
      account or treat the private Store tester identity as an app login.
- [ ] Supply a separately authorized Google test identity if fleet enrollment is
      included; provide the service's PC approval during the review window.
- [ ] Enter only the required credentials in each product's secure certification
      Credentials fields, with access instructions and the intended review scope.
- [ ] Supply rights-owned speech/music test media with filename, complete hash,
      duration, permitted retrieval location and expected test route. The user's
      benchmark songs are not automatically authorized for Microsoft distribution.
- [ ] Confirm authentication, API, model download, selected acquisition source
      and account/fleet services are reachable for the actual review window.

Signed-out local processing is the first reviewer route. A reviewer must not be
required to enroll in fleet processing to test personal processing. The saved
notes identify missing credentials honestly; they do not assert they were supplied.

## Authentic screenshot capture sheet

Both current executables validate Store-origin authority before creating a
window. There is no supported unpackaged screenshot route. The source gates are
[GUI bootstrap](../../../windows-desktop/src/main/main.ts) and
[Worker controls](../../../worker/native/windows-consumer/store_controls.cpp).
Do not weaken them, fabricate an installed screen, use a prototype, or present a
browser-rendered fixture as the native product. Package logos are already bundled;
optional advertising artwork does not replace a required screenshot.

The actual portal requires at least one screenshot for each product/language
listing and recommends four per supported device family. Use genuine Desktop
PNGs at least 1366×768 and below 50 MB; capture at 1920×1080 where practical.
Capture the desktop if the native window is smaller; do not upscale or invent
application content. Captions below are under 200 characters. See Microsoft's
[screenshot guidance](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/screenshots-and-images).

| Capture ID     | Product / actual state                                    | English caption                                                        | Arabic caption                                                            |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| gui-home       | MusicMute Home, real completed owned input and player     | Process an owned file locally and compare original and voice playback. | عالج ملفًا تملك حق استخدامه محليًا وقارن بين الصوت الأصلي والصوت المعزول. |
| gui-library    | MusicMute Library containing the genuine completion       | Keep local results together in your Library.                           | احتفظ بالنتائج المحلية معًا في مكتبتك.                                    |
| gui-prepare    | MusicMute Prepare, actual qualified GPU/model state       | Prepare the model and check this PC's GPU readiness.                   | جهّز النموذج وتحقق من جاهزية بطاقة الرسومات على هذا الكمبيوتر.            |
| gui-account    | MusicMute signed-out form or dedicated reviewer account   | Use local processing signed out, with optional account features.       | استخدم المعالجة المحلية دون تسجيل الدخول، مع ميزات اختيارية للحساب.       |
| gui-worker     | MusicMute Worker view, actual unenrolled/approved state   | Manage optional Worker participation from MusicMute.                   | أدِر المشاركة الاختيارية للعامل من داخل MusicMute.                        |
| worker-startup | Standalone MusicMute Worker, actual Windows startup state | Choose whether MusicMute Worker starts when you sign in to Windows.    | اختر ما إذا كان MusicMute Worker يبدأ عند تسجيل الدخول إلى Windows.       |

Capture English and Arabic against the matching listing. MusicMute's language
selector is in Settings → Preferences. The native Worker follows the Windows
user UI language; it has no MusicMute language switch. Do not change a device's
language or substitute a different test target without the owner's authorization.

For each capture retain file/SHA-256, dimensions, language, product, package/version,
Store-origin evidence, OS/build, actual route/state and owned-media identifier.
Remove private account/media details through the choice of test account and input,
not by inventing screen content. A GUI Worker-tab image belongs to MusicMute and
must not be presented as the standalone Worker window. No screenshots are marked
captured by this sheet.

## Hardware and dependency declarations

| Field                   | Defensible statement                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| System                  | Windows 10 22H2/build 19045 or Windows 11, Desktop                                                                 |
| Architecture            | Native Intel/AMD x64; no ARM, ARM emulation or x86                                                                 |
| GPU                     | A DirectML GPU that passes production qualification; no universal GPU promise or CPU/cloud inference fallback      |
| DirectX technical basis | Native GPU enumeration requires D3D12 device creation at feature level 11.0; this alone is not model qualification |
| RAM / VRAM              | No validated product-wide numeric minimum; the RX580 observation does not establish an 8 GB minimum                |
| Disk                    | Both apps, model, selected media, outputs and temporary work; no validated fixed minimum declared                  |
| Network                 | Store acquisition/initial model preparation and selected account/catalog/acquisition/cloud/fleet features          |
| Privileges              | Standard logged-in Windows user; no administrator service, driver or SYSTEM startup task                           |
| Worker dependency       | MusicMute is needed for Prepare, processing/account/Library and full Worker management                             |
| Browser                 | Optional single shared Chrome extension, currently manual unpacked installation                                    |

Windows 11 Z440 core processing is recorded; physical Windows 10 22H2 and
signed-installed feature/lifecycle acceptance remain open. Do not infer them
from manifests, source tests or the package version.

## Disclosure and submission gates

Acquisition tooling includes Deno/provider/EJS and may evaluate source-platform
challenge code. Signed-out eligible YouTube catalog contribution and its
playback-based media-upload timing must remain accurately disclosed. Playback
acknowledgment is not an express privacy opt-in. Local files are excluded from
that shared contribution path. See the [privacy draft](PRIVACY-REVIEW-DRAFT-2026-10-15.md).

Keep [third-party materials](THIRD-PARTY-MATERIALS-2026-10-15.md), exact final
archive identities, restricted-capability explanations and the hidden-entry
waiver request separate. The owner has deferred that support request. Do not
submit certification or make rights/consent/approval declarations from prepared
text alone. The master [readiness index](STORE-REVIEW-READINESS-2026-10-15.md)
records ready material and actual remaining gates.
