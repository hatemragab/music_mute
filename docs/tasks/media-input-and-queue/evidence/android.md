# Android A01–A04 implementation evidence

Date: 2026-09-13. Branch: `codex/media-input-fair-queue`. Scope owned: `android/`
and this report. No commit, push, release, deployment, or Android device/emulator
operation performed. Other agents' edits were preserved.

## Implemented

- Typed v1/v2 policy and exact shared preparation profile
  `preserve-or-aac-lc-256-v1`; schema-2 inclusive 1800s/100000000 bytes. Missing
  measurement-dependent fields never mean unlimited. Current disabled/unavailable
  expanded policy falls back to safe legacy local audio bounds. Native expansion
  remains behind actual server readiness; quota/active-account limits still apply.
- Platform MediaExtractor inspection selects default-not-first or sole audio track;
  absent/ambiguous/unusable tracks reject. Direct provider descriptor inspection and
  export avoid full original-video copies. Compatible audio remains unchanged;
  AAC soundtrack remux and native 256kbps AAC-LC/M4A conversion are implemented.
  Unsupported multichannel conversion and known spatial conversion reject. Expanded
  prepared audio receives bounded full PCM decode validation before immutable hash
  publication. Prepared video is never uploaded.
- Scoped Files audio/video plus Photos video picker; saved URI grant where offered.
  Unique owner/operation WorkManager preparation, single local slot, bounded
  restart attempts, owner/session/cancellation checks, isolated export attempt
  files, checksum-backed completed-input recovery before reopening a provider.
  Lost provider grants request reselection. Inspecting and preparing are separate
  local stages. Existing rights confirmation remains required.
- Source size and space gates, streaming prepared-byte cap/deadline, native export
  deadline. Unknown original video length rejects. Space margin is a conservative
  guard, not benchmark evidence. Temporary prepared bytes are removed only after
  an authenticated post-upload state/receipt; uncertainty retains retry bytes.
  Original selected media and saved library files are preserved.
- Early single-video YouTube URL/metadata rejection for playlists, live/upcoming,
  missing/nonfinite duration, and excessive duration. Audio-only HTTPS selection
  retained. Actual bytes and process deadline independently bounded by native
  max-filesize/fixed buffers, progress/disk guard, and watchdog. Partial attempt
  files are cleaned. Bundled extractor used without an unbounded update step.
  Finished audio passes the same immutable preparer before reservation.
- Owner-fenced usage read, preflight active/allowance checks, full-queue and media
  safe-code mapping without repeated admission retry. Home shows remaining/used/
  reserved minutes and rolling replenishment time, refreshed periodically.
  English/Arabic messages cover supported C6 codes; no guessed queue position or
  timing estimate is rendered. Legacy unavailable-v2 capability does not itself
  blank the old flow; definitive backend admission remains authoritative.

## Main paths

New processing units: `ProcessingMediaPolicy.kt`, `MediaSourceInspector.kt`,
`AudioPreparationEngine.kt`, `DecodedAudioValidator.kt`, `MediaPreparationWorker.kt`,
`PreparedMediaCleanup.kt`, `ProcessingUsageRepository.kt`. Integration changed the
existing preparer/coordinator/store/repository/API, application wiring, import view
model, home/pickers/presentation/timeline/detail, source downloader, localized
resources, and Android README. `download/YouTubePreflight.kt` owns metadata guards.

New JVM suites: ProcessingMediaPolicyTest, MediaSourceInspectorTest,
AudioPreparationEngineTest, MediaPreparationWorkerTest, PreparedMediaCleanupTest,
ProcessingUsageRepositoryTest, YouTubePreflightTest. Existing preparer/API tests
cover schema-2 recovery, metadata, safe errors, and authenticated usage.

## Actual validation

Tests-first RED: new policy/track/route suites failed compilation because production
symbols were not yet implemented. First invocation exposed missing ANDROID_HOME;
existing SDK `/Users/hatemragap/Library/Android/sdk` was selected explicitly for
subsequent commands without changing local configuration/secrets.

Final full command, from `android/`, passed:

```sh
ANDROID_HOME=/Users/hatemragap/Library/Android/sdk ./gradlew \
  :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:assembleDirectDebug :app:assemblePlayDebug
```

Final log: `/tmp/musicmute-android-validation.log`. Gradle reports and APKs remain
under ignored `android/app/build/`. `git diff --check -- android` passed. No Kotlin
formatter was configured/discovered; no new formatter or dependency was added.
XML read-back: Direct has 253 passing tests in 52 suites; Play has 233 passing
tests in 48 suites, with zero failures/errors/skips. Lint has zero errors,
135 Direct warnings and 117 Play warnings; these include existing project
warnings plus conservative space-check advice. No warning-free claim is made.

## Material validation limits

Android decoder support, exact media priming/padding behavior at the 1800-second
boundary, provider/Photos access, background restrictions, notifications,
force-stop/relaunch, and cancellation on hardware remain **device-unverified**.
No Android simulator/device was substituted for the authorized iPhone simulator.
JVM adapter/selection tests are not native decoding proof. Expanded flow must not
be activated merely because assembly or these tests pass. The profile currently
has unavailable evidence and remains disabled.

The source watchdog kills a native process promptly after observed byte/deadline
excess; its disk observation is periodic, so transient disk overshoot can include
in-flight native buffers. yt-dlp has an independent max-filesize guard and fixed
64 KiB HTTP buffers. Live YouTube availability was not tested. Legacy 120-second
source/preparation watchdogs are conservative safety ceilings, not measured native
throughput. No original-source size, thermal, or benchmark claim was invented.

No Android UI, physical-device, production processing, or release proof is claimed.
