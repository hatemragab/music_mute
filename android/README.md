# MusicMute

Native Kotlin Android app that turns a complete pasted YouTube URL or selected
local audio file into a durable local review before cloud processing. Source audio stays private and
the processed library retrieves voice-only MP3 results only when requested.

Application ID and namespace: `com.hatem.musicmute`. Minimum SDK 26; compile/target
SDK 36. Kotlin, Compose Material 3, Navigation Compose, ViewModels, StateFlow,
DataStore, and constructor injection in one `app` module.

## Build and install

Install JDK 17 and Android SDK platform 36. Configure `JAVA_HOME` and
`ANDROID_HOME`, then open this `android/` folder in Android Studio or run:

```sh
./gradlew :app:assembleDirectDebug :app:assemblePlayDebug \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest
```

The checked-in Gradle 8.13 wrapper verifies its distribution checksum. The APK is
`app/build/outputs/apk/direct/debug/app-direct-debug.apk` for direct distribution
and `app/build/outputs/apk/play/debug/app-play-debug.apk` for Play distribution.
Reports are in `app/build/reports/`.
Machine-specific configuration and build output are ignored.

The production `app/google-services.json` is also local-only and ignored. Download
it before Debug or Release builds using the repository-root Firebase command in
[`../README.md`](../README.md); never force-add it. The checked-in
`app/src/authE2e/google-services.json` is a synthetic `demo-musicmute` fixture and
contains no production Firebase credentials.

## Sign-in and account settings

Sign-in is required before entering the app. Android supports email/password and
Google through Firebase Authentication and Credential Manager. Account settings
support optional email verification, password reset, linked sign-in methods,
registered installations, local sign-out, and sign-out everywhere. Linking keeps
the same Firebase UID; unlinking requires fresh authentication with a retained
method usable on Android. Account deletion requires provider reauthentication and a final destructive confirmation. The backend accepts deletion durably before local sign-out and UID-scoped private cleanup. Acceptance is not a claim that cloud cleanup or backup expiry has finished.

`auth/` owns the Firebase gateway, bounded HTTP client, session coordinator, and
installation metadata. `ui/auth/` owns the sign-in gate and account screens.
Firebase owns tokens; installation metadata and a same-UID bootstrap record live
in no-backup storage. A previously bootstrapped user may enter local features
offline; a new sign-in must complete backend registration. Legacy unowned audio history remains local. Account processing inputs, results, pending reviews, and source downloads are UID scoped.

Debug and Release use `https://api.music-mute.com` by default. Override the public
API **origin** (without `/api/v1`) with `-PauthApiUrl=https://your-api.example`.
For local Debug development, override with `-PauthApiUrl=http://127.0.0.1:3000`
and forward the port from the connected device with
`adb -s <serial> reverse tcp:3000 tcp:3000`. Debug cleartext is limited to loopback
and the Android emulator host. Release rejects an absent or unsafe origin and has
no emulator auth.

The Firebase client configuration includes a web OAuth client ID. The Debug
certificate from this development machine was registered in Firebase on
2026-09-09 for real Google sign-in. This is separate from the upload certificate
registration below; another development machine needs its own Debug certificate
registered before its Debug APK can use Google sign-in.

### Isolated Android account flow checks

`node android/e2e/server.mjs` starts disposable MongoDB, Redis, Firebase Auth
Emulator, and the compiled backend, then prints the owned ports. Build with
`./gradlew :app:assembleDirectAuthE2e`, forward device ports `48080` and `49099` to the
printed API and Auth Emulator ports, and install
`app/build/outputs/apk/direct/authE2e/app-direct-authE2e.apk` on the connected device. The separate
`com.hatem.musicmute.authtest` package preserves the normal app's data.

This variant uses only the `demo-musicmute` project and a picker for two synthetic
Google accounts supplied by its own source set. Every attempt opens the picker;
no previous selection is retained after logout. Cancel returns to sign-in.
Debug and Release source sets have
no provider override. It exercises SDK/backend account behavior but does not
prove the real Google consent screen, production Firebase, or mailbox delivery.
Keep the harness and its two ADB reverse mappings running while reviewing this
test app; its sign-in needs those local services. Stop them only after the review
is finished. Tests use direct ADB interaction on the connected Android device;
Maestro is not used.

## Release signing

Release APKs and app bundles use alias `upload` from `app/upload-keystore.jks`.
The passwords and alias are loaded from `key.properties` in this `android/`
directory. Its `storeFile=upload-keystore.jks` path is resolved relative to the
`app` module. Both files are private local files, excluded from Git, and should
be backed up securely together. Do not regenerate this key for routine builds.

```sh
./gradlew :app:assembleDirectRelease :app:bundlePlayRelease
```

Outputs: `app/build/outputs/apk/direct/release/app-direct-release.apk` and
`app/build/outputs/bundle/playRelease/app-play-release.aab`. Missing signing credentials
cause release signing validation to fail; releases do not use the debug key.
Debug builds continue to use the normal Android debug certificate.

The upload certificate fingerprints are registered on Firebase's MusicMute Android
app (`com.hatem.musicmute`) in project `music-mute`:

```text
SHA-1:   19:5B:EA:A5:A1:C0:1F:80:BF:92:01:58:38:FE:D7:A3:80:72:3C:05
SHA-256: 41:7E:E3:74:56:23:72:1D:D4:20:D8:05:6B:0C:C0:A9:7D:0C:A5:C5:71:FA:8D:A7:71:F1:EE:ED:00:9F:4B:6D
```

These identify this upload certificate, not the debug certificate. If Google Play
App Signing uses a separate app-signing key, also register the SHA fingerprints
shown for that app-signing certificate in Play Console before testing services
that require certificate matching in Play-distributed builds.

Android runtime and UI execution is currently outside the authorized device
scope. Local JVM tests, lint, and APK assembly may run; do not substitute another
simulator or device for runtime proof.

## App updates

Android has separate `direct` and `play` distribution variants with the same
production application ID and signing configuration. Version `0.1.3` is build 4.
The direct variant uses the FileProvider and installer-intent integration from
[azhon/AppUpdate 4.3.6](https://github.com/azhon/AppUpdate) (Apache-2.0). Its APK
stream uses the platform HTTPS connection with the default certificate and host
verification; the dependency's download manager is intentionally not used.
Before Android's installer is opened, MusicMute obtains a fresh public download
grant and independently verifies the complete APK size and SHA-256, package ID,
higher build number, and signing-certificate SHA-256. The
`REQUEST_INSTALL_PACKAGES` permission and narrowly scoped azhon provider exist
only in the direct variant; its unused service and dialog activity are removed
from the merged manifest. The Play variant has no self-install permission or
direct APK dependency; its current safe fallback opens the verified MusicMute
Play listing.

The app checks policy at launch, after reconnect, when a foreground check is due,
and every 15 minutes while foregrounded. Optional updates can be deferred for 24
hours. A mandatory policy is stored independently of login and gates the whole
UI, back navigation, playback, imports, local downloads/uploads, and notification
actions. Local inputs and cloud job IDs are retained; activating the gate never
cancels or deletes an existing cloud job.

The public backend policy and download-grant routes require the production
runtime flag `APP_UPDATES_ENABLED=true`; changing the example file alone does not
change a running deployment. Build 2 predates this in-app updater, so it cannot be
retrofitted with the dialog. Build 4 is the reviewed bootstrap distributed
through the existing update page; subsequent higher builds can then use the
in-app prompt and verified download flow.

## Download quality

The app uses [youtubedl-android 0.18.1](https://github.com/yausername/youtubedl-android)
to execute yt-dlp **on Android**. The supplied Fiftee branch URL returned 404
publicly; it is not a downloader dependency. This implementation follows the
previously agreed youtubedl-android integration.

The selection is `bestaudio[protocol=https]`: the best available audio-only stream
delivered directly over HTTPS. There is no combined video fallback and no HLS
conversion path. `--no-playlist` limits each request to one video, and
`--fixup never` disables automatic repairs. No `-x`, audio-format, audio-quality,
recode, or remux operation is requested. FFmpeg is not included.

The original container and codec are retained, commonly WebM/Opus or M4A/AAC.
YouTube already compresses its audio; this app adds **no further compression**.
It does not invent a higher bitrate or convert to MP3. See the upstream
[yt-dlp format selection documentation](https://github.com/yt-dlp/yt-dlp#format-selection).
If a direct audio-only format is unavailable, the app reports a retryable failure.

## App behavior

- **Home:** Import audio is primary. Selecting a supported file creates a local,
  validated review showing filename, size and duration. A rights checkbox and
  explicit Remove music action are required before cloud processing. Cancelling
  the review deletes its staged private copy without creating a cloud job.
- **YouTube:** A visible secondary option requires explicit download confirmation
  with rights guidance. Pasting, keyboard Done and focus changes never start a
  download. Finished downloads enter a separate cloud-processing review.
- **Processed audio:** one persistent list merges local transfer state and backend
  jobs. Cards show the preserved name, actual stage, elapsed time, and measured
  byte progress. Ready voice output supports Play, Download, Save, Share, Rename,
  and explicit Delete.
- **Save to device:** opens Android's document picker to choose a filename and
  location. It copies the original bytes to that destination. Cancelling the
  picker leaves the history file unchanged. Save failures are shown explicitly;
  an interrupted provider write may leave an incomplete destination copy.
- **Cancellation/retry:** cancellation stops the native process and removes only
  that attempt's partial files. Retry creates a fresh work ID and directory, so
  a stopping attempt cannot erase a retry. Exact repeated URLs reuse active jobs
  or existing complete files. Different URL spellings can produce separate entries.
- **Settings:** persistent system/light/dark theme and system/English/Arabic
  language. Arabic layouts use RTL; URL fields stay LTR.
- **Multiple tasks:** up to two local pipelines may run concurrently; additional
  accepted tasks wait durably and remain independently cancellable.

WorkManager queues source and upload transfers when offline and runs real local
transfers with silent foreground progress notifications when allowed. Notification
permission is optional on Android 13+. Android may reschedule work after constraints
change or the process stops; retryable interrupted state is reconciled with history.
System scheduling, foreground-service time limits, battery restrictions, and
force-stop behavior still apply; uninterrupted completion is not guaranteed.

## Storage and integration boundaries

- `download/AudioDownloader` isolates the native download engine.
  `AudioDownloadPolicy` owns the original-audio selection.
- `DownloadRepository`, `AudioDownloadWorker`, and `HistoryStore` own scheduling,
  cancellation, durable metadata, and app-private audio files under
  `files/audio_downloads/<work-id>/`. No broad storage permission is requested.
- Metadata retains only needed fields; yt-dlp's temporary info JSON is removed
  after completion because it can contain expiring stream URLs.
- `AudioExport` and the document picker copy completed files to user-selected
  storage. App-private files are removed by Android on uninstall/clear-data;
  independently saved copies remain at their chosen destination.
- `playback/` uses Media3 ExoPlayer and a private MediaSessionService.
- `processing/` owns typed job contracts, immutable input validation, durable
  WorkManager uploads, UID-scoped metadata/results, cancel/retry reconciliation,
  and optional notification registration. `ProcessingViewModel` connects these
  components to the Processing history and detail screens.

The native package includes Python and QuickJS for extraction and YouTube JavaScript
handling. Legacy JNI packaging enables extraction of executables. All four upstream
ABIs are packaged; the universal debug APK is about 85 MB. ARM64 executable ELF
segments were inspected for 16 KB alignment; this is packaging evidence, not a run
on every Android version or page-size configuration.

The stable yt-dlp updater is attempted before the first download, at most once per
24 hours in a process. If updating fails, the installed extractor is still tried.
Review upstream native packaging, extractor changes, and GPL-3.0 obligations
before distributing the app. No release/publication has been performed.

Processing flow:

1. Import an owned/licensed local audio file, or explicitly confirm a secondary YouTube download.
2. Prepare and validate local immutable bytes; retain the review across process recreation.
3. Confirm rights and select Remove music to upload to private signed S3 storage and track the backend job.
4. Explicitly Play, Download, Save, or Share the ready voice-only MP3. Output is cached privately per account.

Input must be nonempty, smaller than 30,000,000 bytes and shorter than 600 seconds.
Cancellation waits for backend acknowledgement; worker interruption remains visible
until recovery. Failed-job retry creates a new queue entry. Signing out stops private
playback and fences stale work; ordinary sign-out retains input/output files. Accepted account deletion purges UID-scoped private data and cancels work. Original provider files and user-exported copies are preserved.
Push permission is optional and notification taps re-fetch authenticated job detail.
See the [processing task record](../docs/tasks/mobile-audio-processing.md) for validation
and the separate live backend/S3/Z440/push proof requirements.

No YouTube URL is sent to a backend for server-side downloading. Client-side
downloading changes the originating IP; it cannot guarantee YouTube availability,
account eligibility, or bypass unavailable/private videos.

## Validation

The Gradle validation command above covers JVM tests, lint, and APK assembly.
The 2026-09-09 auth run passed Debug/Release/AuthE2e assembly, lint (no errors,
24 warnings), and all 43 JVM tests, including 11 focused auth cases. See the
[mobile auth validation report](../docs/validation/mobile-auth-2026-09-09.md) for
connected-device results, emulator limits, and outstanding live OAuth checks.
`git diff --check` passed.
Tests include URL validation, demo progression/cancel/retry, preference persistence,
audio-only request options, output validation, path confinement, persistent history,
work-state reconciliation, playback time labels, and byte-preserving export.

Physical-device checks on 2026-09-08 downloaded the public 19-second video
`jNQXAC9IVRw` through the app. The resulting file was 252,182 bytes. Independent
`ffprobe` inspection found exactly one Opus audio stream, 48 kHz stereo, WebM,
19.021 seconds, approximately 106 kbps, and no video stream. These are the properties
of this source, not a fixed quality cap. Play/pause, seeking, background playback,
history after process restart, cancellation cleanup, and retry completion passed.
The Save to device action opened the Android document picker with the correct
original filename and Downloads destination. The user interrupted before the final
save, so actual provider-write verification remains pending; byte preservation is
covered by a JVM test. The latest APK was subsequently installed on the newly
connected `CPH2573` phone at the user's request.

English/Arabic, dark/light, narrow and enlarged-text Compose previews are supplied
in `ui/Previews.kt` and `ui/DownloadPreviews.kt`. Compilation is not proof that all
preview combinations were visually rendered. The physical test covered the
connected Android 14 tablet; other devices, Android versions, long downloads,
provider failures, and restricted videos remain outside this runtime evidence.

The existing 60 tracked-file deletions from the former project are preserved.
No commit, push, publishing, deployment, or restoration was performed.

## Account deletion and release configuration

`DELETE /api/v1/users/me` uses a freshly reauthenticated bearer and no body.
Only HTTP 202 with a nonempty request ID and `status: accepted` is treated as
acceptance. `REAUTHENTICATION_REQUIRED` remains recoverable without automatic
sign-out. A minimal no-backup journal records a requested or accepted deletion;
an uncertain response is never treated as completed deletion. Accepted local
cleanup retries after restart if filesystem cleanup fails.

Set public HTTPS page URLs using `-PprivacyUrl=https://...` and
`-PdeletionUrl=https://...` after real pages are available. These optional values
are validated during configuration (no credentials, query or fragment); configured
links appear both in Account and on the signed-out screen. Empty values omit
links. A verified public deletion route, developer identity, monitored contact,
retention commitments and deployed backend are release blockers until supplied
and independently verified. No URLs or deletion deadlines are invented.

Android device/UI testing remains outside the authorized device scope. JVM tests,
lint and APK assembly do not prove provider reauthentication, document pickers,
background cancellation, playback cleanup, or real-account deletion on a device.

The 2026-09-10 account-deletion/owned-audio implementation passed
`:app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease`: 153
JVM tests in 28 suites, no failures; lint reported no errors and 38 warnings.
Release manifest inspection retained `dataSync` for transfers and `mediaPlayback`
for audio, with no broad storage permission. This is local build/source evidence,
not Android runtime proof, production deletion proof, or Play approval.

Review follow-up also passed `:app:lintRelease :app:testReleaseUnitTest :app:bundleRelease`.
The deletion request bounds token acquisition plus HTTP to 20 seconds; accepted
receipts persist outside that deadline even after an account switch or UI cancellation.
An earlier ambiguous request stays recorded if a later retry is rate limited.
Invalidated/disabled sessions trigger durable private cleanup for that UID, while
ordinary sign-out and transient network failures retain private data.
