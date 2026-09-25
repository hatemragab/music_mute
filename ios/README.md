# MusicMute for iOS

Native Swift/SwiftUI app with bundle identifier `com.hatem.musicmute`, targeting iOS 17
and newer. Select one owned or permitted audio/video file, review its prepared audio size and duration,
confirm permission, and explicitly start cloud processing for vocals-only MP3 output.
Local Files/Photos preparation, cloud upload, job history and result playback remain.
Device-side URL downloading, YouTubeKit, its background source transfer session,
and the legacy download-history UI have been removed. The existing server import
API remains available; this cleanup does not introduce a new iOS link-import UI.
Source metadata on existing server jobs remains readable.

Open `MusicMute.xcodeproj` in Xcode 26.0.1 or newer. Regenerate with XcodeGen after
changing `project.yml`. Only Firebase and Sentry remain as Swift package roots.

## Architecture

- `Auth/`: Firebase identity and authenticated transport.
- `Processing/`: local file preparation, signed uploads, durable jobs and results.
- `State/`: account-scoped state, history, preferences and recovery.
- `Playback/`: AVAudioPlayer, audio session and system playback controls.
- `UI/`: local file import, cloud history, playback and sharing.

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

The app uses root-mounted routes such as `POST /auth/sessions` and `GET /jobs`.
The Swift transport converts between idiomatic model names and snake_case API
JSON/query names. See the [API client contract](../docs/api/client-contract.md)
for authentication, pagination, errors, and the breaking deployment cutover.

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

xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
```

For simulator launch after building:

```sh
xcrun simctl install "$IOS_SIMULATOR_UDID" \
  DerivedData/Build/Products/Debug-iphonesimulator/MusicMute.app
xcrun simctl launch "$IOS_SIMULATOR_UDID" com.hatem.musicmute
```

UI fixtures use isolated synthetic audio and account stores. Real backend, upload and worker validation is separate from simulator checks.

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

All new file intake pause in a persisted
`awaitingConfirmation` pipeline state. The review shows source attribution, size, duration,
cloud upload disclosure and permission confirmation; Remove music is disabled until confirmed.
Restart and Resume do not create a cloud job for that state. Cancelling removes only the private
review staging copy.
Existing uploads that had already started before this update retain their recovery behavior.

iOS native validation accepts playable audio-only M4A/MP4, MP3 and AAC. Although declarations
recognize additional containers, native decoding rejects unsupported ones; the UI does not promise
OGG/Opus/WebM support. Prepared audio must be nonempty and no larger than 50,000,000
bytes or 1,200 seconds. These checks run before review and again through the upload contract.
Rights confirmation records user intent; it does not verify copyright ownership.

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

See `../docs/tasks/media-input-and-queue/evidence/ios.md` for current simulator validation and
remaining readiness, provider, device, and network limitations. Earlier evidence in this README
records historical versions and does not establish current production readiness.
