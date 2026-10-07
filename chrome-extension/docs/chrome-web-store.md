# Chrome Web Store submission

MusicMute Local version `0.1.1`, item `acmgefmmndomcpdlgnafkjbgobinllep`, is now an
editable **Draft**. At the owner's request, the earlier review submission was
cancelled so the owner can review all listing and data disclosures. Do not
resubmit or publish until the owner explicitly approves the reviewed data.
The browser archive excludes the companion, model, native runtime, source maps,
profiles, local reports and credentials. A usable public release also requires
an independently distributed MusicMute Mac app.

## Companion R2 downloads — October 7, 2026

The recommended companion is now [MusicMute Local 0.1.1, build 1791395910](https://downloads.music-mute.com/releases/macos-store-companion-2026-10-07/MusicMuteLocal-0.1.1-arm64-development-build-1791395910.dmg).
Its Prepare manifest uses the R2 domain for all seven runtime ZIPs, preserving
their checksums, bytes and runtime identity. The app-data extension installation
and Library Filter/Sort fix remain included. This is still an ad-hoc development
release; it does not change the Store draft or authorize Store publication.
See [R2 distribution evidence](r2-downloads.md) for uploaded files, checksum links
and the precise validation scope. Earlier companion checkpoints below are historical.

## Companion app-data extension update — October 7, 2026

The recommended companion is now
[MusicMute Local 0.1.1, build 1791393571](https://github.com/ahmed-dev-1/musicmute-downloads/releases/download/macos-store-companion-2026-10-07/MusicMuteLocal-0.1.1-arm64-development-build-1791393571.dmg).
Prepare copies the 19 built extension files into
`~/Library/Application Support/MusicMuteLocal/extension`; Setup's Reveal folder
and Copy path actions use this stable location. Users enable Developer mode and
select it through Chrome's Load unpacked action. App updates refresh the copy
through Prepare; Chrome still needs manual Reload and a YouTube page refresh.

The published DMG is **16,104,287 bytes**, SHA-256
`c867a3bc55fcd84f41c20ae710aa559b1eeeac75478611e7e7a068f6dc2ab38a`.
The release includes `SHA256SUMS-build-1791393571.txt`, retains the earlier assets,
and recommends this build. Public metadata confirms the uploaded sizes and digests.
Anonymous downloads of both the DMG and checksum file exactly match the local bytes.

`npm run verify` passed 2,175 tests (four skipped), typechecking, lint, build and
formatting. NativeTests and all 17 disposable packaged offline checks passed,
including exact app-data payload bytes, registration, repair and GUI-closed HELLO.
The DMG matched all 160 mounted inventory entries and passed strict signature
verification. It includes the Library menu fix, preserves the Store identity and
uses the existing runtime components and approved upstream-only model source.

This remains an ad-hoc development pre-release without Apple notarization or a
configured automatic updater. Chrome loading, fresh-Mac security acceptance,
real account/cloud processing and new YouTube acquisition remain unproved.
Evidence is under
`output/macos/build-850a0a34-2d60-41c5-b839-67175953af99.noindex/distribution.noindex/`
and `output/packaged-tools-proof/4b6dfde5-50c9-4288-9a7f-818cca10d2a5.noindex/result.json`.

## Companion Library controls update — October 7, 2026

The earlier Library-controls companion was
[MusicMute Local 0.1.1, build 1791391546](https://github.com/ahmed-dev-1/musicmute-downloads/releases/download/macos-store-companion-2026-10-07/MusicMuteLocal-0.1.1-arm64-development-build-1791391546.dmg).
Library Filter and Sort now use their visible fields as clickable menu labels.
The existing release retains the previous DMG and adds a build-specific checksum
asset. The new DMG is **16,101,287 bytes**, SHA-256
`3dbc4a0c5d8ec5ca8e5ac7379b3f590fba0e7ef7da527b0f46b81114f7918ec8`.
Public release metadata and anonymous downloads match both uploaded assets' local
sizes and hashes.

`npm run verify` passed 2,169 tests (four skipped), typechecking, lint, build and
formatting. Native, Desktop, browser bridge, Worker and Settings suites passed;
UpdaterTests timed out at its quiet-period guard while Rectangle's Sparkle
updater was active. All 16 disposable offline packaged checks passed. The mounted
DMG matched all 160 file/link inventory entries and passed strict signature,
version/build, Store identity and Applications-link checks. Synthetic native UI
checks confirmed Filter and Sort selections and clicking the blank field area.

The Store identity, public configuration and seven runtime downloads are unchanged.
Kim Vocal 2 remains upstream-only. This remains an ad-hoc development pre-release
without notarization or a configured automatic updater. No installed app update,
fresh-Mac security acceptance, account/cloud or new YouTube acquisition was tested.
Evidence is under
`output/macos/build-052e0765-9069-42da-a4a7-c5c742f34cb4.noindex/distribution.noindex/`
and `output/packaged-tools-proof/893f88db-7659-44e4-8700-ecc3686cc8f3.noindex/result.json`.

## Submission and public companion evidence — October 7, 2026

The owner earlier authorized Store submission. Google confirmed “Your extension was
submitted for review” and the status page showed “This draft is pending review”
for item `acmgefmmndomcpdlgnafkjbgobinllep`. The submit dialog's automatic
publication option was enabled for that submission. Review was subsequently
cancelled and the dashboard confirmed **Draft**; this historical submission is
not current publication authorization. Immediately before submission, Package read-back showed version
`0.1.1`, English and Arabic, and the expected `nativeMessaging`, `offscreen`,
`storage` and host permissions. The confirming dashboard read-back was recorded
at **13:40:41 Africa/Cairo on October 7, 2026** (`2026-10-07T10:40:41Z`).

Apple notarization is outside this request at the owner's direction; it is not a
remaining submission task. The separately hosted Mac app remains an ad-hoc
development build. Google review and actual Store-to-companion installation are
separate acceptance steps.

The dashboard Package tab supplied the assigned item ID and its public key.
Their SHA-256-derived identity matched exactly. Google documents this
[stable-ID workflow](https://developer.chrome.com/docs/extensions/reference/manifest/key).
The previous development ID is `dclpfemnpknfdlpcbfcjkmdbnociippd`. Source and native
bundles now retain the actual Store public key, and package/software versions are
`0.1.1`; the wire protocol remains version 1. The initial upload was rejected with
`key field is not allowed in manifest`. The corrected Store packager omits only
`key` from the upload manifest while preserving local/native identity. Native
registration must contain only `chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/`.
Never allow wildcard origins.

The original verified companion download was the
[Store-compatible MusicMute Local 0.1.1 development DMG](https://github.com/ahmed-dev-1/musicmute-downloads/releases/download/macos-store-companion-2026-10-07/MusicMuteLocal-0.1.1-arm64-development.dmg),
published in the
[companion release](https://github.com/ahmed-dev-1/musicmute-downloads/releases/tag/macos-store-companion-2026-10-07).
An anonymous HTTP 200 download matched all **15,253,038 bytes** and SHA-256
`2ca9e8335fa29e4c84c82441548325165218a261e77a9fb22dc727aea8f5679f`;
the release checksum asset also matched. Evidence:
`output/store-submit-2026-10-07.noindex/public-companion-proof.json`.

This is version `0.1.1`, build `1791324892`, with the actual Store public key.
Prepare uses the unchanged seven pinned runtime downloads from the existing
runtime release and the approved upstream-only Kim Vocal 2 model. Those downloads
previously passed an isolated empty-state real-network Prepare test on this Mac;
the final package's offline checks are separate. The older `0.1.0` DMG embeds the
development key and is not the reviewer artifact. Native Setup opens the actual
Store listing with pending-review wording; unpacked testing steps remain in a
development disclosure.

The owner-selected <https://api.music-mute.com/privacy> now serves the unified
Android, iOS, web, Mac and Chrome policy. It includes Limited Use, native runtime
and model downloads, shared saving, local preferences and diagnostics, controls,
retention and service providers. An anonymous October 7 HTTP 200 read matched
**19,468 bytes** and SHA-256
`7c3b76abc77adf0fa88e4706d80a4e9061da0399e05944d75a659311469d1609`.
The public policy version is `2026-10-07`; the existing 15-day account recovery
and 24-hour security fence remain unchanged. Public-page security headers and
service health checks passed. Live evidence:
`output/policy-update-2026-10-07.noindex/live-public-policy-proof.json`.

The earlier Chrome/Mac-specific policy remains published at
<https://github.com/ahmed-dev-1/musicmute-downloads/blob/main/PRIVACY.md> and linked
from the repository homepage. An anonymous HTTP 200 read matched the prepared
10,661-byte policy exactly (SHA-256
`eecc1448c36c5e3aaf8eee5c1090c3a9409ea47415f040ee7d2941f76d4225ea`). It
describes guest shared saving, native downloads, retention and Limited Use. It
remains an existing public supplemental policy, not the current Store privacy
field. The owner requested
<https://api.music-mute.com/privacy>, and that corrected URL was saved in the
editable draft. Publisher contact verification remains recorded; privacy
declarations are under owner review. The support page provides the publisher's
public contact. A local extension page is not used as the public privacy URL.

The draft's Location category is unselected. Web history and User activity remain
selected pending owner review: selected watch URLs and local player state are
used, but the extension does not collect broad browsing history or analytics,
request browser location, or perform IP-location lookups. These draft categories
are not a final privacy declaration.

The owner explicitly retained existing shared saving: YouTube originals, vocals
and metadata may be uploaded for reuse even while signed out, after playback
starts. No opt-in or disabling change is authorized. Keep the packaged policy,
visible popup disclosure, listing and dashboard declarations consistent with that
behavior. Google's
[prominent-disclosure and consent requirements](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
remain a review consideration; corrected copy alone is not a review approval.

Use the exact ZIP and images recorded by the final `test:store` result, which
builds its own fresh production archive. A passing synthetic native/Chrome test
does not verify the final dashboard-assigned identity or live guest acquisition.

### Checked first-draft packet

The October 7 production archive is
`output/store-readiness-2026-10-07.noindex/submission/musicmute-local-0.1.0.zip`:
641,140 bytes, 19 allowlisted browser files, root manifest, and SHA-256
`ec809d2f44c28d2b25a54af9587b1ebb13237f8410dd27b6cb8fcfd272360489`.
The submission folder also contains the inspected 1280×800 screenshot, 440×280
promotional tile, 128px icon, listing-field draft, proposed hosted-policy update
and first-draft instructions. It contains no browser profile, companion, model,
native runtime or user media.

Type checking, lint and 2,150 source tests passed, with four skipped. The native
build was interrupted by a concurrent Swift file edit; a separate build retry
passed, followed by the repository formatting check. Twelve additional harness
runtime-selection tests passed. The first Store E2E attempt selected a worker
service artifact without Python/Node and failed before the companion started.
The harness now resolves the app's validated active runtime and checks executable
availability before launching Chrome, with no worker-state fallback.

The final `npm run test:store -- --long-run` passed 35 checks with zero page
errors, including the native messaging bridge, real offscreen playback, six
minutes hidden playback (24 advancing samples), a 40-second pause/resume,
pause/seek/rate/volume, Stop/mute restoration, ads, SPA navigation, two-tab
ownership, automatic next videos and local diagnostic/cache controls. Evidence:
`output/e2e-1791322126288/results.json`. Its exact archive was copied into the
submission packet only after ZIP digest/CRC/root-manifest verification.

The new registration migration accepts only the known prior development origin,
with an exact existing owned launcher path, safe permissions and marker/header;
it writes only the new bundled-key origin. It does not grant wildcard access or
guess the future Store identity. Sharing/automatic preparation behavior remains
unchanged as instructed. These version 0.1.0 results are historical first-draft
evidence, superseded by the final archive below.

### Previously submitted version 0.1.1

The final archive is
`output/store-submit-2026-10-07.noindex/final-submission/musicmute-local-0.1.1.zip`:
640,779 bytes, SHA-256
`ed81e757978909a3368910b545dc28667460a57ae7f24fad4f4c7886baece8fc`.
All 2,169 source tests passed (four skipped), with type checking, lint, formatting
and the native/browser build passing. NativeTests passed on stable Swift source.

A final browser run exposed a native mute/unmute intent race: an earlier clock
acknowledgement could overwrite observed mute state before its queued browser
event. The fix synchronizes observed state only when restoring a mute owned by
MusicMute. Four deferred-event regressions cover mute/unmute after clock and
repeated Ready acknowledgements; all 212 playback tests pass.

The post-fix exact keyless ZIP passed all 33 standard Store browser checks with
zero page errors: `output/e2e-1791324723097/results.json`. Its manifest is loaded
unchanged into isolated Chrome. Chrome supplies the unpacked path-derived test
ID; the fixture native host permits only that ID. This establishes exact ZIP
functionality with synthetic media, not a Google-signed CRX installation. Source
public-key identity matches the assigned Store item separately. The earlier
six-minute run used the keyed version 0.1.0 candidate, not these final bytes.

The final Mac companion is ad-hoc build `1791324892`, version `0.1.1`, under
`output/macos/build-2b0a636a-3785-4df3-9c1e-2771e0c33458.noindex`. It includes the
Store key, Store setup link and final source. Sixteen isolated offline packaged
checks passed, including actual Setup/Status readiness, exact native registration,
launcher repair and GUI-closed native HELLO. Seven read-only final-DMG checks
passed its bytes/hash, mounted strict signature, all 160 package file/link leaves,
version/build/Store identity, Applications link and detach. These checks did not
perform fresh network setup, inference, account use or GUI acceptance.

The exact final `0.1.1` ZIP was uploaded and its Package version read back before
Submit. The listing retains the final `1280×800` screenshot; the superseded
`0.1.0` screenshot was removed with the owner's explicit approval. The dashboard's
500-character reviewer field saved the 486-character instructions in
`output/store-submit-2026-10-07.noindex/reviewer-instructions-500.txt`, including
the verified companion URL, supported platform, account-free local setup,
playback checks and the guest-access limitation. The full local instructions
remain separate. The old installed app is a different artifact; publishing this
DMG does not prove that installed app was updated.

Google's [review guidance](https://developer.chrome.com/docs/webstore/review-process)
recommends narrow permissions and readable code. The production archive already
has both. [Accurate privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
help reviewers understand the single purpose and each permission. Prepare full
native installation instructions and truthful data declarations. Check the
[pre-submission installation tests](https://developer.chrome.com/blog/cws-review-updates-2026)
after uploading the final package. These measures reduce avoidable friction;
they do not guarantee an approval date.

## Build and test the actual archive

From `chrome-extension/`:

```sh
npm run verify
npm run test:native
npm run package:chrome
npm run test:store
npm run test:store -- --long-run
```

`package:chrome` builds fresh browser bundles into a unique directory beneath
`output/chrome-store/`. Its ZIP contains the manifest at the root and only the
explicit browser asset allowlist. It verifies production host matches,
permissions, version and PNG dimensions, and records every file's SHA-256 in
`package-report.json`. It does not reuse `dist/extension`, so a previous fixture
build or stray private file there cannot contaminate the archive. No package
installation, store upload, signing or publication occurs.

`test:store` extracts and loads the generated ZIP in an isolated Chrome profile,
with its production manifest unchanged. Requests for YouTube are fulfilled with
owned synthetic fixture bytes; this is real Chrome/native/offscreen integration,
not live YouTube acquisition or listening evidence. The fixture companion is
isolated from the installed app's state. Results record the exact ZIP path and
SHA-256. The normal test is headless. `--long-run` opens an isolated Chrome window,
disables the automation framework's default focus override, minimizes the test
window, tests six minutes of actual hidden-tab playback, then a forty-second
pause/resume.
It never uses the user's normal Chrome profile.

The test also generates a 1280×800 listing screenshot containing the actual
popup, and a 440×280 brand tile under its `store-assets/` output directory. The
screenshot explicitly labels its synthetic media. PNG icons are derived from
the existing `musicmute-mark.svg`; the 128px store icon has 16px transparent
padding around 96px artwork. Inspect images before submission. Fixture imagery
does not establish live source matching or speech/music listening quality.

## Listing copy

**Name:** MusicMute Local

**Short description:** Prepare vocals locally on Apple Silicon and play them
with your YouTube video.

**Single purpose:** Prepare and play a voice-only audio track synchronized with a
supported YouTube watch video.

**Detailed description:**

MusicMute Local plays voice-only audio alongside your YouTube video. Use the
waveform control in the player to start. The video pauses while audio is prepared,
then the vocals follow your playback position, pause, seek, speed and volume.
Switch to original sound, mute vocals, or stop at any time.

Requires an Apple Silicon Mac and the separate MusicMute Mac app. The extension
alone cannot process audio. Windows, Intel Macs, live streams, Shorts and
multi-language/described audio-track matching are not currently supported.
Videos must be no longer than 20 minutes. Automatic local preparation is enabled
by default for eligible playing videos; you can turn it off or choose a shorter
limit. Automatic preparation never submits new cloud processing.

Audio acquisition needs an internet connection. Vocal separation runs locally.
YouTube may refuse logged-out guest access; MusicMute does not import browser
cookies or bypass login requirements. Restricted or unavailable sources can fail.
Use content you own or are authorized to process.

Local processing does not require a MusicMute account. The Mac app can reuse
original audio and vocals from MusicMute's shared catalog. New local YouTube
originals, vocals and video metadata may be uploaded in the background for reuse
by other MusicMute users, even while signed out. Shared results can remain after
account deletion; they are stored in private storage and delivered through
authorized access. Signing in can also link results to your account Library.
Personal file uploads remain private to their account.

Select MusicMute cloud in the Mac app to use account-backed processing instead.
A manual start sends the canonical YouTube link to MusicMute's backend and uses
the signed-in account's processing allowance. The Mac downloads the resulting
vocals for playback. Diagnostics stay on your Mac unless you export and choose
to share them.

MusicMute is independent and is not affiliated with YouTube or Google.

## Permission explanations

| Permission                                           | Required use                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nativeMessaging`                                    | Communicate with the separately installed MusicMute Mac app to prepare audio, manage local playback grants and report readiness.                          |
| `offscreen`                                          | Play local vocals independently of the YouTube page while synchronizing media controls.                                                                   |
| `storage`                                            | Keep playback preferences and bounded local diagnostic records in the current Chrome profile.                                                             |
| `https://www.youtube.com/*`, `https://youtube.com/*` | Inject player controls and read the current watch video's identifier and playback/ad state.                                                               |
| `http://127.0.0.1/*`                                 | Retrieve vocals from the Mac app's random-port loopback server using short-lived protected URLs. Production content scripts do not run on loopback pages. |

Browser code is bundled in the ZIP; no remote executable browser code is loaded.
The separate native companion downloads checksum-verified native runtime
components and model data during setup. These components execute in the native
app, not as remotely hosted extension JavaScript. All browser executable code is
bundled in the submission ZIP.

## Privacy declaration preparation

The shipped [privacy page](../src/extension/static/privacy.html) describes current
source behavior and must also be hosted at the publisher's public HTTPS policy
URL before listing submission. Add the publisher's verified contact information
to the hosted policy. Do not invent a contact address or use a local
`chrome-extension://` URL as the store's public policy URL.

Review the publisher dashboard's current categories against these actual flows:

- Website content and activity: current YouTube video identity/metadata and player
  state are handled locally; acquisition sends requests to YouTube/media servers.
- Shared reuse: the native app can look up and contribute YouTube originals,
  vocals and metadata through MusicMute services even while signed out; accepted
  shared audio can be reused by other users and retained beyond account deletion.
- Optional account use: the native app handles MusicMute authentication and
  account Library access. Personal file uploads remain account-private; YouTube
  jobs can reference shared audio. Cloud processing submits the canonical URL.
- Local diagnostics and preferences: retained locally; diagnostic export creates
  a local report. No analytics, advertising or automatic diagnostic upload.

Do not declare “no data handled” or “all data always remains local.” Chrome's
policy guidance covers local handling as well as off-device collection. Publish
only disclosures that match both extension and companion behavior. The extension
requests no general browsing-history or browser-cookie permission.

## Reviewer instructions

Provide the verified, Store-ID-aligned Mac companion download URL and installation
steps: install on Apple Silicon/macOS 14+, open MusicMute, choose Prepare my Mac,
then install the submitted extension and open its popup to check the connection.
Chrome 116+ and at least 2.5 GB free disk space are required. The reviewer needs
the prepared local voice model and suitable permitted source media. Guest use
requires no account credentials. Direct guest acquisition has a recorded bot
challenge; disclose source refusal rather than promising every new video works.
The October 6 live record separately proved shared-original local separation and
authenticated cloud playback. Explain the companion
requirement in the listing prominently; do not ask reviewers to disable OS or
browser security. The synthetic test ZIP is not a production submission: submit
the production archive recorded by `test:store`, never a `--fixture` build.

## Remaining owner review and user-test acceptance

1. Have the owner review all listing content, data declarations and release
   artifacts before any future resubmission or publication. Current status is
   **Draft**, with review cancelled; explicit owner approval is required to
   continue. Google approval and public Store availability remain unverified.
   The owner's requested sharing behavior is unchanged; its disclosure and
   consent implications remain under review.
2. Once the approved item is available, install its actual Google-signed extension
   with the verified `0.1.1` companion. Confirm native messaging permits only
   `chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/`, including Prepare and
   ordinary restart/update. The unpacked synthetic test does not prove this
   Store-installed pair.
3. Before wider user testing, run the final pair on another Apple Silicon Mac and
   test fresh supported-source acquisition, local separation and listening with
   permitted media. Check original/vocals switching, ads/navigation/background
   playback and failure recovery. The known guest bot challenge remains a
   source-dependent limitation; earlier shared-original and cloud playback
   successes do not guarantee every new YouTube source works.

Keep Google review, public artifact verification, installed-app state and live
user acceptance as separate evidence. Apple notarization remains outside this
request. The existing package report's `public_ready: false` is not changed by a
successful upload or submission; it does not represent Google approval.

## Local candidate validation — 2026-10-04

- `npm run verify`: passed type checking, lint, 1,488 tests in 48 files, build and
  formatting on the current shared checkout.
- `npm run test:native`: both native suites passed.
- Python discovery with the installed pinned downloader wheel target: 58 tests
  passed, with no skips. Command: `MUSICMUTE_LOCAL_DOWNLOADER_TARGET='/Applications/MusicMute Local.app/Contents/Resources/runtime/tools/downloader' python3 -I -B -S -m unittest discover -s tests -p 'test_*.py'`.
- `npm run test:store -- --long-run`: 31 Chrome checks passed. This includes real
  offscreen playback, mute controls, pause/seek/rate/volume, ad suspension, forced
  offscreen recreation, exclusive tab ownership, SPA navigation, two automatic
  next-video starts, Stop suppression, diagnostics and local cache clearing.
  Twenty-four samples over six minutes confirmed the minimized player's vocals
  continued advancing. A forty-second pause resumed successfully. The sampled
  foreground drift maximum was 28 ms; this is not a worst-case latency guarantee.
  Fixture logs recorded no `PLAYBACK_CLOCK_STALE` events.
- `npm audit` and `npm audit --omit=dev`: zero reported vulnerabilities.
- A separate `package:chrome` build produced the same ZIP SHA-256 as the tested
  archive. Standard ZIP CRC checks and the package allowlist tests passed.

Tested archive:
`output/chrome-store/v0.1.0-OnFTNx/musicmute-local-0.1.0.zip`

SHA-256: `3914f58a0d2b9cc7eb9b8f975358443b331108feb4c8ee10cb2e89448ce8033f`

Browser evidence: `output/e2e-1791110033872/results.json`. The corresponding
`store-assets/` directory contains the reviewed screenshot and promotional tile.
These ignored local artifacts were present and inspected at this checkpoint.

Earlier timed harness runs passed the playback timing stages but stopped at
unfocused-tab actionability checks. The harness now explicitly activates the
player after closing the second tab and the popup before clicking its tools.
The final complete run above includes those fixes. No autoplay, CORS, or local
network security bypass was used.

This is synthetic browser/native integration. It does not establish live YouTube
acquisition, actual speech/music separation quality, physical listening, system
sleep recovery, store review, notarization or fresh-user installation. No upload,
publish, deployment, installation replacement, commit or push was performed.

## Publication prerequisite recheck — 2026-10-04

The tested ZIP still exists and its SHA-256 matches the successful 31-check
browser record. The most recent inspected local Mac package records still use
`AD_HOC_LOCAL` signing; no `latest-release.json` pointer or successful public
`release-result.json` was found under this component's output directory.

The web client references `https://api.music-mute.com/privacy` and
`https://api.music-mute.com/support`. Direct requests from this environment
returned HTTP 403, so their public accessibility and extension-specific
content remain unverified. This does not establish that normal users cannot
access them. No verified Mac DMG download or Chrome Web Store item URL was found
in the inspected component documentation and public client sources. Publisher
URLs, store identity and public companion release evidence are still needed.

## Official requirements consulted on 2026-10-04

- [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare)
- [Listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Images](https://developer.chrome.com/docs/webstore/images)
- [User data and privacy FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Intellectual property and impersonation](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property)

These sources guide preparation; they do not establish store approval for this
product or resolve the rights for a particular user's media.
