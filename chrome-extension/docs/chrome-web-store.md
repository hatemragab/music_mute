# Chrome Web Store release preparation

This is a local release candidate, not an uploaded or approved store listing.
The browser archive excludes the companion, model, native runtime, source maps,
profiles, local reports and credentials. A usable public release also requires
an independently distributed MusicMute Mac app.

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

**Single purpose:** Prepare and play a local vocals track synchronized with a
supported YouTube watch video.

**Detailed description:**

MusicMute Local prepares vocals on your Mac and plays them alongside your
YouTube video. Use the waveform control in the player to start. The video pauses
while audio is prepared, then the vocals follow your playback position, pause,
seek, speed and volume. Switch to original sound, mute vocals, or stop at any time.

Requires an Apple Silicon Mac and the separate MusicMute Mac app. The extension
alone cannot process audio. Windows, Intel Macs, live streams, Shorts and
multi-language/described audio-track matching are not currently supported.
Videos must be no longer than 20 minutes. Automatic preparation is off by default;
you can enable it for subsequent eligible videos and choose a shorter limit.

Audio acquisition needs an internet connection. Vocal separation runs locally.
YouTube may refuse logged-out guest access; MusicMute does not import browser
cookies or bypass login requirements. Restricted or unavailable sources can fail.
Use content you own or are authorized to process.

Local playback does not require a MusicMute account. If you sign into the Mac app,
new local results can be saved to your account, including original audio and
vocals. Diagnostics stay on your Mac unless you export and choose to share them.

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
The separate native companion downloads verified model data during setup. Do not
confuse that native installation with JavaScript executed by the extension.

## Privacy declaration preparation

The shipped [privacy page](../src/extension/static/privacy.html) describes current
source behavior and must also be hosted at the publisher's public HTTPS policy
URL before listing submission. Add the publisher's verified contact information
to the hosted policy. Do not invent a contact address or use a local
`chrome-extension://` URL as the store's public policy URL.

Review the publisher dashboard's current categories against these actual flows:

- Website content and activity: current YouTube video identity/metadata and player
  state are handled locally; acquisition sends requests to YouTube/media servers.
- Optional account use: the native app handles MusicMute authentication and can
  transfer originals, vocals and metadata to the user's private account Library.
- Local diagnostics and preferences: retained locally; diagnostic export creates
  a local report. No analytics, advertising or automatic diagnostic upload.

Do not declare “no data handled” or “all data always remains local.” Chrome's
policy guidance covers local handling as well as off-device collection. Publish
only disclosures that match both extension and companion behavior. The extension
requests no general browsing-history or browser-cookie permission.

## Reviewer instructions

Provide the verified Mac companion download URL and installation steps. The
reviewer needs an Apple Silicon Mac with the supported macOS version, Chrome,
working guest acquisition, the prepared local voice model, and suitable permitted
source media. Guest use requires no account credentials. Explain the companion
requirement in the listing prominently; do not ask reviewers to disable OS or
browser security. The synthetic test ZIP is not a production submission: submit
the production archive recorded by `test:store`, never a `--fixture` build.

## Remaining release gates

1. Confirm the publisher and whether this updates an existing store item. A new
   item's store identity must match the native host's allowed extension origin.
   Current local identity is `dclpfemnpknfdlpcbfcjkmdbnociippd`. Preserve its key
   until the actual store identity is known. If the store assigns a different
   identity, update the public manifest key and rebuild/requalify the companion
   registration; never allow wildcard extension origins.
2. Supply verified public companion-download, privacy-policy and support URLs.
   Current popup can open an installed companion but has no invented download URL.
3. Qualify the signed, notarized companion and first installation under normal
   Gatekeeper protections. Follow [macOS release](macos-release.md) and
   [dependency notices](THIRD-PARTY.md); extension checks do not prove these gates.
4. Complete live supported-source matching and listening acceptance with permitted
   media, including original/vocals switching and actual YouTube controls. Synthetic
   browser fixtures do not claim real acquisition or alternate-track matching.
5. Review the generated screenshots, current privacy declarations and store
   policies, then submit only when directly authorized. Chrome review acceptance
   remains Google's decision.

The report deliberately retains `public_ready: false` until these external
release gates have evidence. Local packaging success is independently useful;
it is not public-launch approval.

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
