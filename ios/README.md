# MusicMute for iOS

Native Swift/SwiftUI app with bundle identifier `com.hatem.musicmute`, targeting iOS 17
and newer. Select one owned or permitted audio/video file, review its prepared audio size and duration,
confirm permission, and explicitly start cloud processing for vocals-only MP3 output.
YouTube remains a labelled secondary download option **on the iPhone**. The app keeps persistent history,
plays saved audio, and exports original files through Save to Files. English,
Arabic RTL, system/light/dark appearance, and Dynamic Type are supported.

Open `MusicMute.xcodeproj` in Xcode 26.0.1 or newer. The project and shared scheme are
checked in; XcodeGen is only needed when changing `project.yml` or adding files.

## Why this package

Android's youtubedl-android contains Android-specific native/Python packaging and
cannot be imported into a Swift iOS target. This app uses the native Swift package
[YouTubeKit 0.4.9](https://github.com/alexeichhorn/YouTubeKit/releases/tag/0.4.9),
pinned exactly in `project.yml` and `Package.resolved`. It has no transitive Swift
package dependencies. Its extraction runs in process using Apple's JavaScriptCore.

The alternative [YoutubeDL-iOS](https://github.com/kewlbear/YoutubeDL-iOS) embeds
Python and also declares FFmpeg dependencies. That is unnecessary for this app's
direct, original-audio use case, so it is not included. No Python, yt-dlp executable,
FFmpeg, remote extraction service, or separation backend is included in this iOS app.

YouTubeKit has an optional remote fallback. MusicMute explicitly constructs
`YouTube(videoID: id, methods: [.local])`, so failure never falls back to a server.
No account, cookies, proxy, or client secret is configured.

## Audio quality

Vocal filters for audio-only, natively playable **M4A/AAC** streams, then selects
the highest available bitrate. It downloads the selected HTTPS Googlevideo stream
with URLSession. The YouTube download flow never downloads a combined video stream or re-encodes a
file for saving. Local Files/Photos video preparation is a separate path described below.

This differs from Android's best-audio selection, which may choose WebM/Opus.
iOS deliberately selects the best compatible original AAC stream for reliable
native playback. It does not claim to choose a higher-bitrate Opus stream that its
native player cannot play. YouTube already compresses audio; MusicMute adds no further
compression. Availability and bitrate depend on the video and the streams YouTube
makes available to this client.

Downloaded files are checked with AVFoundation: they must be nonempty, playable,
contain audio, and contain no video tracks. Duration comes from audio frame count;
AVAsset can overestimate the duration of some fragmented YouTube M4A files.
Playback uses AVAudioPlayer, which reads these original files correctly without
modifying them. Exports are independent filesystem copies with unchanged bytes.

## Features and boundaries

- **Home:** Import audio is primary. A secondary YouTube section has an explicit Paste
  button, local validation, canonical video ID extraction, retained URL input, and Download audio.
  Pasting, keyboard submission and focus changes never initiate a download. Video, Shorts, embed, live-video URLs,
  and youtu.be links are accepted; a live URL still needs an available direct file.
  Playlist-only links and untrusted/lookalike hosts are rejected.
- **History:** durable title, date, original format, bitrate, size, duration,
  progress, cancellation, errors, retry, and playback controls. Concurrent starts
  for the same video reuse active work. An explicit later download creates another
  saved copy; retry always gets a fresh attempt ID and directory.
  Active transfers show a progress bar, percentage, and received/total bytes.
  Unknown totals show received bytes with an indeterminate indicator. Progress
  uses URLSession download delegate callbacks and includes resumed bytes.
- **Playback:** play/pause, seeking, background audio, Now Playing and lock-screen
  controls, audio focus/interruption handling, and pause when headphones disconnect.
- **Save to Files:** copies a completed original file, then opens the system export
  picker. Its initial location is MusicMute's Documents folder; users can choose another
  Files location. Cancelling keeps the original. Temporary export copies are cleaned
  after the picker closes. MusicMute's Documents folder is visible in Files.
- **Preferences:** local UserDefaults persistence with safe defaults for unknown
  stored values. All interface strings are in matching English/Arabic resources.
- **Processing:** import audio or explicitly select Remove music on a saved original.
  The app validates and stages immutable input, uploads directly to signed S3 storage,
  and shows authenticated cloud history, job detail, worker interruption, cancel,
  and failed-job retry. Ready voice-only MP3 files are downloaded only when Play,
  Download, or Save to Files is selected and cached privately per account.

Downloads are asynchronous and receive iOS's finite background-task grace period.
Keep MusicMute open for long downloads. When that time expires, work is cancelled and
shown as interrupted with retry. On process restart, incomplete history entries
become retryable failures. This version does not promise indefinite background
downloads or automatic retry/resume after force-quit. During an active download,
connection loss and request timeouts receive up to three retries with short delays.
URLSession resume data is used when supplied; otherwise the transfer restarts.
Cancellation and permanent errors are not automatically retried.

Direct media requests have a 30-second request timeout and 10-minute resource
timeout. Extraction has a 60-second cancellation deadline. Cancellation stops the
request; late callbacks cannot overwrite terminal history states. The extractor's
own cancellation responsiveness remains an upstream dependency.

## Architecture

- `Auth/`: Firebase email/password and Apple identity adapters, validated backend transport,
  installation identity/revision persistence, and the mandatory session coordinator. Firebase
  owns credentials and tokens; passwords, Apple authorization data, and bearer tokens remain in
  memory. The successful-bootstrap marker and installation report live under Application Support,
  are excluded from backup, and never contain audio ownership.
- `Core/`: Codable records, validated YouTube IDs, original-audio selection, safe
  export names, and error categories.
- `Data/YouTubeAudioService.swift`: `AudioDownloading` replacement boundary,
  local extraction, URLSession progress, and cancellation.
- `Data/HistoryStore.swift`: actor-isolated JSON persistence with atomic writes and
  revision ordering to reject stale snapshots. Corruption is reported, never silently
  replaced by empty history.
- `Data/AudioFiles.swift`: app-private file validation, path confinement, audio
  duration, byte-preserving export, and attempt-owned cleanup.
- `State/`: observable state, lifecycle/cancellation/retry, and preferences.
- `Playback/AudioPlayer.swift`: AVAudioPlayer, AVAudioSession, and MediaPlayer controls.
- `UI/`: SwiftUI screens, reusable cards/waveform, and UIKit's native document picker.

## Authentication configuration

`Vocal/GoogleService-Info.plist` is local-only and ignored. Download it before a
native build using the repository-root Firebase command in
[`../README.md`](../README.md); never force-add it. Its client API key is embedded
in the application at build time, so restrict the key to the registered iOS bundle
ID instead of treating the plist as an Admin SDK secret.

The app requires a backend bootstrap after Firebase sign-in. Supply the public API **origin** as
the `MUSICMUTE_API_BASE_URL` Xcode build setting; the client uses root-mounted resource paths. The value must not
contain a path, query, credentials, or fragment. Release builds accept HTTPS only. Debug builds
default to `http://127.0.0.1:3000` for local development and also accept explicit HTTP loopback
origins for isolated fixtures. The checked-in Release setting is empty because this repository
does not establish an authorized deployed origin; an unconfigured Release build shows a setup
error and does not bypass the auth gate.

`FirebaseAuth` uses the existing exact Firebase SPM pin (`12.18.0`). Sign in with Apple uses the
checked-in entitlement plus `AuthenticationServices` and a fresh SHA-256 nonce for every prompt.
Compilation does not prove that the Apple capability, Firebase provider, distribution profile, or
private email relay is enabled in the external consoles. Password-reset and verification mail are
requested only through the backend so its cooldowns and quotas remain authoritative.

Authentication gates entry to the tabs, but local audio storage is unchanged and is not assigned
to accounts. A matching Firebase user with a previous successful bootstrap may reopen local audio
when validation fails specifically because the device is offline. A new or changed identity must
bootstrap online. Account deletion is available in Account, including when processing is restricted. The coordinator
reauthenticates the current identity; Apple accounts obtain a fresh authorization code and revoke
the Apple token using Firebase before requesting backend deletion. `DELETE /users/me`
uses a fresh bearer token and an empty body. Only a validated HTTP 202 acceptance receipt is
shown as accepted. The receipt and backup-excluded journal preserve the exact backend-provided
15-day recovery deadline; acceptance does not claim cloud cleanup has completed.

A private, backup-excluded journal preserves ambiguous requests and interrupted local cleanup.
Accepted cleanup fences session callbacks, stops private transfers/playback, removes account-owned
processing inputs/results/history/diagnostics/source copies and matching job notifications, then
clears the successful local cleanup marker. Unknown responses retain a minimal recovery marker;
stale authentication preserves the request for reauthentication. Original imported Files and
exported copies are preserved.
Offline devices cannot be remotely wiped; private data clears when an invalid session is validated.

Set `MUSICMUTE_PRIVACY_URL` and `MUSICMUTE_ACCOUNT_DELETION_URL` to verified public HTTPS URLs
when available. Empty, credential-bearing or invalid values do not produce links. Both defaults
remain empty: public support and privacy destinations are release blockers, not invented URLs.
Apple provider setup and real token revocation still require a disposable authorized account.
See [Firebase Apple deletion guidance](https://firebase.google.com/docs/auth/ios/apple).

History lives under Application Support/Vocal/history.json; downloads are under
Application Support/Vocal/Audio/UUID/audio.m4a and excluded from device backups.
No expiring stream URLs are stored. Deleting the app removes its private downloads
and its Documents folder. Copies exported to another Files provider/location follow
that provider's retention rules. Interrupted export/provider failures can leave a
partial external copy; MusicMute never deletes another provider's or user's existing data.

## Build and validation commands

Only the existing **iPhone 17 Pro / iOS 26.0** simulator identified by
`IOS_SIMULATOR_UDID` is authorized for UI and runtime testing. Do not substitute a
device, clone, runtime, or new simulator.
Disable parallel testing to prevent Xcode from creating test-device clones.

```sh
export IOS_SIMULATOR_UDID="<authorized-simulator-udid>"

# Optional: regenerate the checked-in Xcode project after project.yml changes.
xcodegen generate --spec project.yml

# Build, unit tests, and offline UI checks. The live test is skipped by default.
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO

# Opt-in real YouTube download, playback, background, export, and relaunch check.
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  -only-testing:VocalUITests/VocalUITests/testLiveDownloadPlaybackAndExport \
  test CODE_SIGNING_ALLOWED=NO VOCAL_LIVE_TEST=1

xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
```

The opt-in `testRadioLinkDownloadAndPlayback` UI test covers video `EiRpINIoHbU`
with its playlist/radio query parameters. Select it with
`-only-testing:VocalUITests/VocalUITests/testRadioLinkDownloadAndPlayback` and
`VOCAL_LIVE_TEST=1`. It waits for completion or failure and verifies native playback.

For simulator launch after building:

```sh
xcrun simctl install "$IOS_SIMULATOR_UDID" \
  DerivedData/Build/Products/Debug-iphonesimulator/MusicMute.app
xcrun simctl launch "$IOS_SIMULATOR_UDID" com.hatem.musicmute
```

Xcode test result bundles include screenshot attachments. UI tests use app-specific
launch overrides for language, appearance, and input; they do not clear existing
downloads or change another app's settings. The live test creates a small public
YouTube sample and an exported copy. Unit tests use temporary, isolated stores.

## Integration evidence and remaining limits

The complete simulator suite passed: **17 unit tests and 3 UI tests**, with zero
failures or skips when `VOCAL_LIVE_TEST=1`. Coverage includes Arabic dark/large-text
screens, invalid input/settings, a real download, native play/pause/seeking,
background playback, Save to Files, and persistent history after relaunch. The
exported file's SHA-256 exactly matched the original downloaded file. The unsigned
Release build for `generic/platform=iOS` also passed; no physical device was run.
Formatting and `git diff --check` were checked separately.

On 2026-09-08, local extraction and direct downloading of `jNQXAC9IVRw` succeeded
inside the authorized iOS simulator. Independent ffprobe inspection found one AAC
audio stream, 44.1 kHz stereo, approximately 130 kbps, 309,288 bytes, and no video.
The container reports 19.064 seconds including encoder priming; native playable
audio duration is approximately 19.016 seconds. These are source properties,
not a fixed bitrate limit. No server downloaded this file.

This is simulator evidence, not a physical-iPhone or App Store release claim.
The longer radio-link sample `EiRpINIoHbU` exposed a connection reset after
5,603,296 of 6,087,448 bytes (`NSURLError -1005`). After adding bounded resume,
the same reset was reproduced and recovered with HTTP 206; the download and
playback UI test passed. Independent inspection found one AAC audio stream,
44.1 kHz stereo, 6,087,448 bytes, and approximately 6:16 duration. No video or
transcoding was involved. The extractor also logged a recoverable parsing message;
stream extraction continued successfully, so that message alone is not proof of
a failed download.

Other iOS versions, real hardware background restrictions, Bluetooth routes,
very long downloads, low-storage conditions, and restricted/private videos still
need their own runtime coverage. SwiftUI previews include English, Arabic RTL,
dark, progress, cancellation, failure, and narrow enlarged-text layouts; compiling
them does not mean every preview has been visually rendered.

YouTube changes can break extraction. Update the pinned package and rerun the live
test when that happens; do not silently add server fallback. Client-side downloads
change the originating IP and do not guarantee availability.

Processing uses `Processing/`, `State/ProcessingModel.swift`, and the Processing UI
views. Prepared input must be nonempty and stays within the single inclusive
50,000,000-byte and 1,200-second policy; signed admission remains authoritative.
Background URLSession uploads use file-backed signed multipart bodies;
durable intent reconciles uncertain create/upload/cancel/retry responses on recovery.
Result downloads resume through an explicit later action after interruption.
Cancellation remains pending until acknowledged and a stopped worker remains visible.
Retained inputs/results are not automatically swept. Sign-out fences old callbacks,
hides private history, and stops private playback.

Optional FCM/APNs registration waits for permission and an APNs token; taps re-fetch
authenticated job detail. Simulator fixtures disable live push transport. Real
Firebase/APNs provisioning and deployed backend/S3/Z440 behavior require separate
operational validation. See the [processing task record](../docs/tasks/mobile-audio-processing.md).

The Android project, reserved backend directory, and existing tracked deletions are
preserved. No signing credentials, commit, push, publishing, or deployment were used.

## Owned-audio consent and recovery

All new file intake and secondary YouTube download completion pause in a persisted
`awaitingConfirmation` pipeline state. The review shows source attribution, size, duration,
cloud upload disclosure and permission confirmation; Remove music is disabled until confirmed.
Restart and Resume do not create a cloud job for that state. Cancelling removes only the private
review staging copy. A deliberately downloaded source remains available until account deletion.
Existing uploads that had already started before this update retain their recovery behavior.

iOS native validation accepts playable audio-only M4A/MP4, MP3 and AAC. Although declarations
recognize additional containers, native decoding rejects unsupported ones; the UI does not promise
OGG/Opus/WebM support. Prepared audio must be nonempty and no larger than 50,000,000
bytes or 1,200 seconds. These checks run before review and again through the upload contract.
Rights confirmation records user intent; it does not verify copyright ownership.

On 2026-09-10 the account-deletion/owned-audio changes passed **136 unit tests** and
Home validation/settings UI on the designated simulator. Targeted native UI checks
also passed final account-deletion confirmation/cancellation and secondary YouTube
plus actual Files selection through rights confirmation and explicit cloud processing,
using synthetic fixture audio. Scoped Swift lint and both localization resources
passed. These fixture checks do not prove real Firebase/Apple revocation or deployed
backend/S3/worker account erasure. Public privacy/deletion URLs remain unconfigured.


## Versioned media preparation and account allowance (2026-09-13)

Files offers individual audio/video selection; Photos uses PHPicker's one-video grant,
without full-library authorization. Provider materialization has a 60-second cancellation
deadline and a bounded streaming copy. Photos copies are private and discarded after use;
original Files/Photos assets are never deleted. Lost provider access requires reselection.

`ProcessingMediaPolicy` reads `/processing-policy?schema_version=2`. A validated,
accepting response may lower the local ceiling but never raise the single inclusive
1,200-second/50,000,000-byte prepared-audio policy. The same safe ceiling is retained
when policy refresh is unavailable. Policy version, profile ID, and source category
are persisted with the immutable upload operation, including restoration.

`MediaSourceInspector` honors the container's uniquely enabled default soundtrack. It
accepts a single audio track and rejects ambiguous multiple defaults; it never guesses
from track order or language. `AudioPreparationEngine` copies compatible audio, tries
an audio-only passthrough composition for video when the known audio bitrate is
at or below 160 kbps, and otherwise uses AVAssetReader/AVAssetWriter AAC-LC at no
more than 160 kbps, 48 kHz stereo. Unknown bitrate also triggers one encode.
Final audio is re-inspected and hashed;
source size, available space, export time, and output size are bounded. The source's image
track is never decoded for audio extraction. Supported formats depend on AVFoundation;
no blanket support claim is made for every container or codec.

Inspection and preparation have distinct local phases. UIKit background-task grace is
finite and expires by cancelling preparation. URLSession upload recovery remains independent
of transcoding. A completed consent-review input survives relaunch. Uncertain upload completion
retains its immutable input until an authenticated receipt/reconciliation marks it submitted;
only then is temporary prepared input removed. Force-quit cannot guarantee continued preparation.

`ProcessingUsageRepository` fetches owner-only UTC-month used/reserved/refunded/remaining
processing allowance, upload grants/bytes, result grants/estimated bytes, retained
output, effective media limits, active jobs, availability, and reset boundaries.
Reads are advisory; create-job
admission is authoritative. Account changes clear the snapshot, and known allowance/capacity
rejections never become automatic rate-limit retries. English and Arabic messages accompany
media, quota, capacity, and provider failures. Waiting and separator timers remain separate,
and cleaned-audio results are still fetched only for Play/Download/Save. Valid private
caches bypass the grant endpoint. Uncertain result retries reuse their request identity;
a known-expired entitlement rotates to a new identity.

YouTube intake first reads the public watch page locally with a 5-MB response ceiling,
30-second resource deadline, and no cookies/credentials/redirect fallback. A bounded JSON
parser requires an available player response, matching video ID, explicit non-live metadata,
and finite lengthSeconds at or below 1,200. Live/upcoming, consent/login pages, unknown
metadata, and playlist context fail before audio transfer. YouTubeKit 0.4.9 then resolves
audio-only streams locally. Source delegates enforce actual downloaded bytes (50 MB) and
600 seconds independently of response length; background retry preserves the original
persisted deadline. Final native frame duration and prepared policy are revalidated.
Public YouTube response markup can change; deterministic parser tests are not live service proof.

See `../docs/tasks/media-input-and-queue/evidence/ios.md` for current simulator validation and
remaining readiness, provider, device, and network limitations. Earlier evidence in this README
records historical versions and does not establish current production readiness.
