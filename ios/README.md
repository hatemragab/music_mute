# MusicMute for iOS

Native Swift/SwiftUI app with bundle identifier `com.hatem.musicmute`, targeting iOS 17
and newer. Select one owned or permitted audio/video file, review its prepared audio size and duration,
confirm permission, and explicitly start cloud processing for vocals-only MP3 output.
Local Files/Photos preparation, cloud upload, job history and result playback remain.
Home supports server-side link imports with a bundled site list,
local URL checks, rights confirmation, durable retry identities and independent
WebSocket progress for multiple imports. The form accepts another link after
persisting its intent, while earlier imports continue. Existing single-import
recovery records are preserved when upgrading.
See [the shared site policy](../docs/url-imports/supported-sites.md).
Source metadata on existing server jobs remains readable.

The dashboard's link-import visibility policy controls only the new link form.
File and Photos imports, existing link progress/retries, downloads, and queued or
running work remain available. Missing `link_import_visible` defaults to hidden.
Every open/foreground checks `/processing-policy?schema_version=2`, using the
account token while signed in and a public guest read before sign-in. Global,
country and selected-user hiding resolve through the same visible boolean;
the shared owner WebSocket applies later `policy` snapshots without a refresh control.
Guest and per-owner payloads are stored separately under
Application Support/Vocal/ProcessingPolicy, excluded from backups, and used
only for the matching identity during offline reopen. A fresh offline installation
or uncached owner has file controls only. Session, request, and revision fences
prevent stale checkout responses from replacing a newer snapshot.

URL audio is acquired by a private SaaS adapter, returned to NestJS for validation
and R2 upload, then processed by the existing worker. iOS never receives SaaS
credentials or provider delivery URLs. The shared catalog enables multiple sites;
an eligible separate audio stream must be available on each link. Existing native
installations require a rebuild to receive new catalog entries. See
[provider architecture](../video_providers/README.md).

Open `MusicMute.xcodeproj` in Xcode 26.0.1 or newer. Regenerate with XcodeGen after
changing `project.yml`. Only Firebase and Sentry remain as Swift package roots.

The current R2 release candidate is **0.1.3 (4)**. Local simulator tests and an
unsigned Release archive are separate from distribution. A MusicMute Apple team,
matching provisioning profile with the app's capabilities, and an explicit
distribution channel are required before exporting or publishing an IPA. See
the [native R2 rollout evidence](../android/tasks/r2-rollout/VALIDATION.md).

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
origins for isolated fixtures. Release defaults to `https://api.music-mute.com`, with
privacy and deletion links on the same production host. An invalid or empty override
still shows a setup error and never bypasses the auth gate. Validate the final archive
and provider configuration before distributing it.

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
Firebase/APNs provisioning and deployed backend/R2/Z440 behavior require separate
operational validation. See the [current client contract](../docs/api/client-contract.md).

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

## Realtime processing

Processing updates use authenticated raw WebSocket snapshots with automatic
reconnection. See the [protocol and rollout notes](../docs/realtime-processing-queue/PROTOCOL.md)
and [local validation ledger](../docs/realtime-processing-queue/IMPLEMENTATION.md).
HTTP remains responsible for authentication, commands and file transfers.

### Home job history storage

Home job history is held in memory and loaded from WebSocket snapshots; it is
not restored from disk. Existing persisted history is reduced to completed
library tracks when the account store opens. Library media/metadata, preferences,
and pending import/upload recovery records remain on device. Switching tabs
continues using the shared live session rather than restarting the connection.

## Current jobs and Library (2026-09-28)

Failed link imports offer **Delete** on the import card. Removal clears the
account-scoped local recovery record and survives restart without submitting
another acquisition. Failed imports without a job expire locally after seven
days when the account opens. Older records start that window on their first open
after upgrading. Active imports and submitted jobs are preserved. Server import
records already have a seven-day TTL; administrator job history remains.

Home and the processing list hide terminal cloud jobs (`ready`, `failed`,
`cancelled`); unfinished local reviews and recoverable local imports stay
accessible. Creation date and time are shown on Home job cards. Filtering is
presentation only: no deletion request, database mutation or media cleanup is
performed, and the administrator dashboard retains job history.

Library has explicit cursor-based Load more with loading/error feedback. Native
Library storage preserves previously discovered completed audio; browser Library
requests `status=ready`, retains loaded pages, and bounds live subscriptions to
the newest page plus nine tail pages. See
[release evidence](../docs/client-current-jobs-release-2026-09-28.md) for validation
and distribution status.

Library uses the job's nullable `thumbnail_url` when it contains an original public
YouTube HTTPS thumbnail. The same optional field survives HTTP, realtime snapshots
and saved Library history. Older jobs, local files, missing or rejected URLs and
image download failures keep the existing waveform placeholder. The client never
constructs a thumbnail URL or requests additional video metadata.

Library's **Show starred** checkbox combines with search and every Library tab.
The **Most played** tab shows played tracks ranked by local play count; the sort
menu also offers Most played for the other tabs. Stars, removed-track preferences,
and play counts stay in account-scoped device preferences and never reach the API
or database. A successful playback start counts once, and each actual repeat counts
again. Pause/resume, seeking, source comparison and failed starts do not add plays.
Playback queues use the displayed track order when a track is selected. Historical
plays before this update are unknown and start at zero.

## Private local diagnostics

The shared API transport, raw WebSocket, file transfers, installation/processing
stores and app lifecycle emit structured diagnostics to the repository's
[Vector/Logdy collector](../tools/local-logging/README.md). They require a Debug
build plus explicit opt-in. Release builds compile out the collector, its key
loading, payload snapshots and exception observer.

Build a simulator Debug app using the existing exact simulator target, start the
root collector, then from the repository root run:

```sh
xcodebuild -quiet -project ios/MusicMute.xcodeproj -scheme MusicMute -configuration Debug \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath .runtime/local-logging/ios-build build CODE_SIGNING_ALLOWED=NO
python3 ios/scripts/run-local-logging.py \
  --app .runtime/local-logging/ios-build/Build/Products/Debug-iphonesimulator/MusicMute.app \
  --fixture
```

The helper reads the private `keys.ios` value from
`.runtime/local-logging/keys.json` without printing it, boots/installs/launches only
`3CC14436-EC3C-4419-A079-C84951E5FA07` (iPhone 17 Pro, iOS 26.0), and never closes
an existing process. Close an already running app manually before relaunch so it
inherits settings. `--fixture` uses the isolated processing UI and a safe
credential-redaction canary, success/error/abort requests through a dedicated in-memory URLProtocol session (no external API), and a fresh event after three seconds of native inactivity; omit it for ordinary local development.

For Xcode launches configure `MUSICMUTE_LOG_ENABLED=1`,
`MUSICMUTE_LOG_KEY=<private keys.ios>`, and optionally
`MUSICMUTE_LOG_PAYLOADS=1`, `MUSICMUTE_LOG_CONSOLE=1`. The only accepted destination
is `http://127.0.0.1:19740/ingest/ios` (optional
`MUSICMUTE_LOG_ENDPOINT`). Disable collection by removing `MUSICMUTE_LOG_ENABLED`;
payload and console controls are independent opt-ins. Helper launches default to
payloads on, console off and respect explicit payload/console environment values.

One random process identity scopes local task/subscription identifiers. HTTP
requests carry debug-only UUID request IDs; returned valid server IDs are retained.
UIDs are captured before awaits and job retries retain their operation trace ID.
Realtime records distinguish client reception, application processing and client
transport send completion; these are separate observations, never delivery claims.
Binary transfers record metadata without reading/buffering their contents or signed
URLs. Storage events report existing accesses only; no diagnostic reads are added.

The bounded sender keeps at most 128 pending events plus one active request,
limits records to 32 KiB and JSON snapshots to 16 KiB, and prefers warnings/errors
under pressure. Failed sends are counted and discarded; there is no unbounded
retry/offline spool. `LocalDiagnostics.status()` and each event's `collector`
field expose pending/sent/failed/dropped counters. Redaction precedes network,
queue and console output. Unsupported data, non-JSON/binary snapshots, large
strings/arrays/depth, arbitrary error messages and stacks have explicit omissions.
Objective-C exceptions are observed best-effort and forwarded to the prior handler;
Swift fatal errors/OS termination cannot guarantee collector delivery. Use native
crash diagnostics for those cases. Root Logdy/MCP retention and privacy apply;
MCP responses are supplied to the selected AI host/model.
