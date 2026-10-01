# MusicMute

Native Kotlin Android app with local audio/video uploads and server-side URL imports.
Local files enter a durable review before cloud processing. Source audio stays private and
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

Realtime is owned by the authenticated Activity session, not a navigation tab.
Home, Library, Player and Settings share the same foreground connection; history
subscriptions survive tab switches. Reselecting the active tab does not navigate
or refresh. Backgrounding the Activity or signing out closes the connection.
Rejected sessions stay stopped until a new session is bound.

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
method usable on Android. Account deletion requires provider reauthentication and a final destructive confirmation. The backend returns and the no-backup journal preserves the exact 15-day recovery deadline before local sign-out and UID-scoped private cleanup. Acceptance is not a claim that cloud cleanup or backup expiry has finished.

`auth/` owns the Firebase gateway, bounded HTTP client, session coordinator, and
installation metadata. `ui/auth/` owns the sign-in gate and account screens.
Firebase owns tokens; installation metadata and a same-UID bootstrap record live
in no-backup storage. A previously bootstrapped user may enter local features
offline; a new sign-in must complete backend registration. Account processing inputs, results, pending reviews, and source downloads are UID scoped.

Debug and Release use `https://api.music-mute.com` by default. Override the public
API **origin** with `-PauthApiUrl=https://your-api.example`.
For local Debug development, override with `-PauthApiUrl=http://127.0.0.1:3000`
and forward the port from the connected device with
`adb -s <serial> reverse tcp:3000 tcp:3000`. Debug cleartext is limited to loopback
and the Android emulator host. Release rejects an absent or unsafe origin and has
no emulator auth.

The app uses root-mounted API routes such as `POST /auth/sessions` and
`GET /jobs`, without a version prefix. Request and response JSON and query
names are snake_case on the wire; the Kotlin models remain idiomatic through
the HTTP adapter. See the [API client contract](../docs/api/client-contract.md)
for authentication, pagination, errors, and the breaking deployment cutover.

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
production application ID and signing configuration. Version `0.1.13` is build 14.
The direct variant uses the built-in version dialog, download service, progress
callbacks, FileProvider and installer-intent helper from
[azhon/AppUpdate 4.3.6](https://github.com/azhon/AppUpdate) (Apache-2.0).
`AppUpdateDownloadClient` supplies the backend version/changelog and required
update decision. Its `AppUpdateHttpManager` adapter retains the bounded platform
HTTPS stream with default certificate/host verification and rejects redirects;
the library's default HTTP implementation is never selected. Verification runs
off the main thread and must succeed before the library receives `Done`, because
the library can expose a completed APK in a notification even when progress
notifications are disabled. Automatic library installation is disabled.
Before Android's installer is opened, MusicMute obtains a fresh public download
grant and independently verifies the complete APK size and SHA-256, package ID,
higher build number, and signing-certificate SHA-256. The
`REQUEST_INSTALL_PACKAGES` permission and narrowly scoped azhon provider exist
only in the direct variant; the service and dialog activity are non-exported.
The Activity-bound adapter releases the library singleton/listeners when an
attempt ends, and retries obtain a new grant. The Compose gate still blocks
required updates and handles localized errors, permission recovery, and optional
download progress after the library dismisses its dialog. The Play variant has no self-install permission or
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

## Link acquisition

URL imports use `POST /media-imports`. A private SaaS adapter returns audio to
NestJS for validation, temporary-file cleanup and private R2 upload. Android
receives neither vendor credentials nor delivery URLs. See
[provider architecture](../video_providers/README.md).

## App behavior

- **Server URL imports:** Home accepts public media links using its bundled site catalog,
  including a pasted or Android-shared text link. After rights confirmation the app
  sends only the canonical URL and a durable request ID to `POST /media-imports`.
  It never downloads or reuploads that source. Per-account import state survives
  process recreation; uncertain submissions reuse their request ID. The app follows
  authenticated import snapshots, then opens the existing job and result experience after
  `submitted`. Failed imports and account/provider limits are shown separately.
  Failed service-availability imports offer **Try again** beside Delete. The explicit
  action keeps the original rights-confirmed URL and trim choice. A known
  failed execution receives one new request ID; uncertain admission resumes the saved
  identity. Duplicate taps cannot create additional attempts. A fresh admission uses
  the server's current recipe and access checks. Invalid inputs and policy failures
  remain removable without a retry action; the app adds no automatic paid retry.
  A bundled verified-site catalog rejects unsupported sites and link shapes locally,
  including restored submissions, before any import request. The backend still
  verifies audio-only availability, private/live media and playlists. See the
  [shared site policy](../docs/url-imports/supported-sites.md).
- **Home:** Import audio is primary. Selecting a supported file creates a local,
  validated review showing filename, size and duration. A rights checkbox and
  explicit Remove music action are required before cloud processing. Cancelling
  the review deletes its staged private copy without creating a cloud job.
- **Processed audio:** one persistent list merges local transfer state and backend
  jobs. Cards show the preserved name, actual stage, elapsed time, and measured
  byte progress. Ready voice output supports Play, Download, Save, Share, Rename,
  and explicit Delete.
- **Save to device:** opens Android's document picker to choose a filename and
  location. It copies the original bytes to that destination. Cancelling the
  picker leaves the history file unchanged. Save failures are shown explicitly;
  an interrupted provider write may leave an incomplete destination copy.
- **Cancellation/retry:** local preparation/upload and cloud jobs retain their existing
  cancellation and retry behavior. Server imports expose bounded retryable failures.
- **Settings:** persistent system/light/dark theme and system/English/Arabic
  language. Arabic layouts use RTL; URL fields stay LTR.
- **Multiple tasks:** one local pipeline runs at a time; additional
  accepted tasks wait durably and remain independently cancellable.

WorkManager queues local preparation and upload transfers when offline and runs them as
ordinary scheduled background work without a data-sync foreground service. Android may
reschedule work after constraints change or the process stops; retryable interrupted
state is reconciled with history. System scheduling, battery restrictions, and force-stop
behavior still apply; uninterrupted background completion is not guaranteed.

## Storage and integration boundaries

`processing/` owns local preparation, signed R2 uploads, durable account-scoped
jobs, server import polling, and result caches. `playback/` uses Media3 and a
private MediaSessionService. Local source files and user-exported copies remain
under user control. Playback/export downloads only completed server results.

Release builds enable R8 code optimization and resource shrinking. All existing
ABIs remain supported. Device URL acquisition and its bundled runtime are removed.
Use the server import form for URLs. User audio files are not deleted.

Sentry uses the Android core SDK for Java/Kotlin crash and ANR reporting. The
Sentry NDK integration and session replay modules are not packaged.

## Validation

The Gradle validation command above covers JVM tests, lint, and APK assembly.
The 2026-09-09 auth run passed Debug/Release/AuthE2e assembly, lint (no errors,
24 warnings), and all 43 JVM tests, including 11 focused auth cases.
That dated local result does not establish current device or live OAuth behavior.
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

`DELETE /users/me` uses a freshly reauthenticated bearer and no body.
Only HTTP 202 with a nonempty request ID and `status: accepted` is treated as
acceptance. `REAUTHENTICATION_REQUIRED` remains recoverable without automatic
sign-out. A minimal no-backup journal records a requested or accepted deletion;
an uncertain response is never treated as completed deletion. Accepted local
cleanup retries after restart if filesystem cleanup fails.

The checked-in release defaults use `https://api.music-mute.com/privacy`,
`https://api.music-mute.com/delete-account`, and
`https://api.music-mute.com/support`. Override them only with
`-PprivacyUrl=https://...`, `-PdeletionUrl=https://...`, and
`-PsupportUrl=https://...` for another verified deployment. Values are mandatory
and validated during configuration (HTTPS, no credentials, query, or fragment);
links appear in Account and on the signed-out screen. A built-in URL does not
prove the backend is deployed or the support mailbox is monitored, so verify all
public pages before uploading the bundle.

Android device/UI testing remains outside the authorized device scope. JVM tests,
lint and APK assembly do not prove provider reauthentication, document pickers,
background cancellation, playback cleanup, or real-account deletion on a device.

The 2026-09-10 account-deletion/owned-audio implementation passed
`:app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease`: 153
JVM tests in 28 suites, no failures; lint reported no errors and 38 warnings.
That 2026-09-10 validation covered the manifest at that checkpoint. The current
merged Play manifest declares `mediaPlayback` for audio, explicitly removes
WorkManager's foreground service, and does not request
`FOREGROUND_SERVICE_DATA_SYNC` or broad storage permission. Reinspect the merged
manifest for every release; local source/build evidence is not Android runtime
proof, production deletion proof, or Play approval.

Review follow-up also passed `:app:lintRelease :app:testReleaseUnitTest :app:bundleRelease`.
The deletion request bounds token acquisition plus HTTP to 20 seconds; accepted
receipts persist outside that deadline even after an account switch or UI cancellation.
An earlier ambiguous request stays recorded if a later retry is rate limited.
Invalidated/disabled sessions trigger durable private cleanup for that UID, while
ordinary sign-out and transient network failures retain private data.

## Versioned media preparation (2026-09-13)

Files accepts individual audio/video documents; Photos uses the scoped Android video
picker. No broad photo/storage permission is requested. Documents are persisted as
owner-scoped URI references and prepared by unique WorkManager work; a lost provider
grant requests reselection. Existing rights confirmation remains required. Local
work is serialized, cancellable, and distinguished as inspecting, preparing, source
download, and upload; waiting for a remote worker does not keep local WorkManager work
alive. Android force-stop/background restrictions still apply.

`ProcessingMediaPolicy` reads schema 2 and the `audio-cap-aac-lc-160-v1` profile.
The single active media policy is inclusive 1,200 seconds and 50,000,000 prepared
bytes, bounded by any lower server value. Unknown profiles fail safely. Backend
admission remains authoritative after local preparation and can reject a race with
another installation or a full queue.

The platform engine uses MediaExtractor directly on the provider descriptor without
copying the original video. It honors the default or sole soundtrack and rejects
ambiguous/unusable defaults. Compatible audio at or below 160 kbps is copied
unchanged. Selected AAC video tracks at or below 160 kbps are remuxed to audio-only
M4A; higher or unknown rates use MediaCodec AAC-LC at no more than 160 kbps.
Multichannel conversion and known spatial codecs are rejected rather than downmixed.
The first AAC packet may have a negative presentation time for encoder priming;
only MediaExtractor's `-1` sentinel means no selected sample is available. Directly
copied local audio and locally generated M4A are inspected and checksummed without
an additional complete decode on the phone. The worker decodes the uploaded audio
during processing. Final prepared output must pass the same inclusive
duration/size policy; codec padding handling is not a license for truncation. A
Xiaomi 23043RP34G hardware probe passed MP3 copy, 192 kbps M4A conversion, and
128/192 kbps MP4 soundtrack preparation on 2026-09-23. Other devices and media
formats still need validation.

When policy refresh is unavailable, local preparation keeps the same 1,200-second
and 50,000,000-byte safe ceiling; it never raises the backend limit. Local extraction
accepts known-size sources up to 200,000,000 bytes with a 120-second preparation
deadline. Server maintenance, allowance, and admission checks still apply when
submitting the audio.

Video imports use the system document picker so the provider supplies the original
filename instead of the photo picker's numeric alias. Only the final extension is
removed from the title. Native AAC conversion uses the decoder's actual PCM sample
rate (including Opus sources that declare 24 kHz but decode at 48 kHz).

An opt-in device regression runner is available in `src/androidTest`. Build with
`:app:assembleDirectDebugAndroidTest` and pass `-e sourceUri <granted-uri>` to
`com.hatem.musicmute.test/com.hatem.musicmute.processing.MediaPreparationTestRunner`.
It checks audio-only output, standard limits, and preserved duration, then removes
its own temporary output. It does not submit a processing job or run a benchmark.

Original source size must be known and within the selected preparation bound for
native video export. Unknown-size audio streams stay bounded by the prepared cap. Space
checks reserve room for the bounded prepared copies plus a 16 MiB margin. This is a
conservative storage guard, not a device benchmark. Prepared audio survives retries
and completion markers recover after process death; only confirmed post-upload
states delete that temporary input. Original media and independently saved library
files remain intact. No video is uploaded or reconstructed; output remains cleaned
audio retrieved on demand.

Owner-only usage is refreshed before intake and periodically on the home screen.
It separates used, reserved, refunded, and remaining audio minutes for the current
UTC calendar month and validates upload grants/bytes, result grants/estimated bytes,
retained output, effective media limits, and reset boundaries from the same response.
Valid private-cache playback does not request another result grant. A stable request
ID is reused after an uncertain result-transfer failure and rotated only for a known
expired entitlement. Capacity/allowance errors are localized in English and Arabic
without raw diagnostics or automatic queue-full retries. No
queue-position or completion-time promise is shown when estimates are unavailable.
See `../docs/tasks/media-input-and-queue/evidence/android.md` for current validation.

### Fast bounded processing uploads

Picked audio that is already compressed at or below 160 kbps is staged without
transcoding. When bitrate metadata is absent, a known complete file size and
valid duration may prove its average container bitrate is at most 160 kbps;
this avoids re-encoding compact MP3/M4A/Opus files unnecessarily. Video and
multiple audio tracks still require selected-track extraction. WAV/lossless,
oversized, high-rate or unbounded inputs use the existing bounded native AAC/M4A
preparation path, subject to decoder support. No raw WAV is uploaded. Prepared
uploads retain the policy size cap (at most 50 MB), duration checks and checksum.

## Server link import (2026-09-25)

The Import link/share flow accepts public YouTube, Facebook and other provider
URLs. Site support and audio-only availability are determined by the backend;
Android sends only the URL and polls the durable import before opening its job.
Device-side URL acquisition has been removed. Build
with `-PauthApiUrl=https://api.music-mute.com` for production backend testing.

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

## System playback cards and island-style surfaces

Failed link imports, including rejected admissions, offer **Delete** on Home.
Removal clears the account-scoped local recovery record and survives restart.
It does not retry acquisition or delete an associated cloud job. Failed imports
without a job expire locally after seven days; cleanup runs when the account opens
or another link is submitted. Older records start that retention window on their
first open after upgrading. Active imports and submitted-job recovery are preserved.
Server import records already have a seven-day TTL; administrator job history remains.

Playback uses Media3's media session and standard media notification. The card
supplies the track title, localized Original audio / Voice only label, MusicMute
artwork and the existing transport controls. Tapping it opens Player (after the
normal authentication/update gates), where speed, queue and other player options
remain available. No overlay or accessibility permission is needed.

The operating system/manufacturer chooses whether to display a media island,
lock-screen card or notification, and which controls fit. This is media-session
integration, not a guarantee of a custom island on every Android phone. Android's
[Live Updates](https://developer.android.com/develop/ui/views/notifications/live-update)
do not accept MediaStyle or custom RemoteViews, so playback does not request
promoted Live Updates. Processing notifications remain separate.

Playback and direct-update notifications use separate channels with launcher
badges disabled. Their new channel IDs avoid library defaults already saved with
badges enabled, while carrying forward legacy importance, sound, vibration, light,
lock-screen and group preferences. The direct updater also clears its library's
completion notification before the app's verified installer handoff. Actual
processing outcomes retain their existing alert channel and badge preferences.
The opt-in instrumentation runner accepts `-e check notificationBadges` to check
the saved channel policy; OEM launcher behavior still needs an explicitly
authorized Android device.

Local checks: `:app:testDirectDebugUnitTest`, `:app:lintDirectDebug`,
`:app:assembleDirectDebug` and `:app:compileDirectDebugAndroidTestKotlin`.
The existing opt-in instrumentation runner also accepts `-e check playbackCard`
to verify metadata, bitmap decoding and distinct tap PendingIntents. That check
requires an explicitly authorized Android device; compiling it does not execute
it. OEM island appearance and cold/warm tap navigation need device validation.

## Playback queue editing

The Up next screen supports long-press drag handles with edge scrolling and
per-track Play next, Move up, Move down and Remove actions. Move actions also
appear in accessibility controls. Reordering uses track identities and the real
playback traversal order, including shuffle and repeat-all wrapping; it turns
shuffle off so playback follows the chosen order. The current audio is not
restarted by queue edits. The existing account-scoped checkpoint saves the order.

Play next moves an existing queued track after the current audio, enables
auto-next and exits repeat one. It keeps playback paused if already paused.
Clear asks for confirmation and removes every queued track except the current
one. Queue removal keeps Library entries and downloaded files. English and
Arabic labels explain why repeat one or disabled auto-next leaves Up next empty.

Local queue regressions are in `QueueEditingTest`, `QueueDisplayTest` and
`PlaybackQueueTest`. Android gesture, accessibility and uninterrupted playback
runtime checks still require an explicitly authorized Android device.

## Listening features

The [plan](tasks/listening-features/PLAN.md),
[task checklist](tasks/listening-features/TASKS.md) and
[validation record](tasks/listening-features/VALIDATION.md) track this feature branch.

- Add MusicMute from the launcher widget picker. Resize the playback widget to
  reveal Import audio. Tap the title/artwork to open Player. Play/pause and Next
  use the existing media service; widget updates are event-driven, with no polling.
- Long-press the app icon for Import audio, Import link and Library. Shared single
  `audio/*` content URIs are copied into bounded owner-private storage and enter
  the existing review/rights-confirmation flow. They never auto-submit to cloud.
- MediaLibraryService exposes completed, visible, current-account tracks for
  Android Auto browsing/search and Android system resumption. External media IDs
  are resolved against the account library; external URIs are never played.
  Authentication/update restoration is awaited before returning resume media.
  Initial restoration alone does not prepare, download or autoplay the queue.
- Player displays cached real waveform peaks for the selected original/voice
  source, with the normal accessible seek slider and retry fallback. Decoding
  runs off the UI thread, streams PCM and stops on cancellation or a 120-second
  watchdog. Waveforms are limited to sources of at most three hours.
- Listening tools offers optional Skip silence, 15/30/60-minute sleep timers,
  end-of-track stopping, and an optional final five-second fade for timed stops.
  Skip silence preserves short pauses (at least one second for mono/stereo audio)
  and quiet speech. Longer near-silent gaps retain half their middle section,
  with natural padding and up to two seconds kept per gap. Retained audio keeps
  its volume. This only changes playback; saved/exported files are unaffected.
  Timers and loops live in the playback service and continue while backgrounded.
  They reset with the playback service/account; they are not reboot alarms.
- Bookmarks persist per account, job and original/voice timeline (100 per source,
  80-character notes). The A–B range loops until cleared or the source changes.
  Choosing end-of-track sleep clears a passage loop so the track can finish.
- Share a selected Voice only passage as PCM WAV: 0.5 seconds to five minutes,
  at most 64 MB. This is a local export, not an extra server job. Only temporary
  read grants are shared. Cancel closes/deletes an incomplete export. Old clips
  are pruned on subsequent exports; all listening cache files clear on sign-out.
  Unsupported PCM encodings or decoder failures show retryable UI feedback.

No overlays, accessibility-service permission, new runtime permissions or new
package dependencies were added. Widgets/Auto/system resumption are controlled by
Android and its host; device/host testing remains required before release.
