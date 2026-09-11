# Android audio processing validation

Date: 2026-09-10. Local source/build evidence; no release or deployment.

## Implemented flow

The production Processing tab accepts an explicitly submitted local import or a
saved original selected with Remove music. Typed authenticated jobs, immutable
input validation, signed S3 multipart uploads, durable WorkManager recovery,
cloud pagination/detail, worker availability, cancel/retry, per-account result
caching, native playback/export, and optional push registration are integrated.
Original YouTube downloads never automatically create a processing job.

Input limits are strictly `0 < bytes < 30_000_000` and finite
`0 < durationSeconds < 600`. Staged bytes use the backend's padded base64 SHA-256.
Storage requests use signed fields and no Firebase bearer. Create/retry intents
retain their idempotency keys across uncertain responses. Retained files are not
automatically swept; private work and playback are fenced on account changes.

## Commands and results

From `android`:

```sh
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The final reviewed run passed 105 JVM tests and assembled the debug APK. Lint
reported zero errors and 27 warnings. Review regressions cover delayed account
binding/polling, the backend's notification event ID format, and output-storage
error feedback. Private playback uses localized track text.

Both language resources contain 256 keys, with no missing statically referenced
processing keys. Tests cover API/auth envelopes, input preparation, durable upload
and cancellation/retry races, history/account isolation, output downloads and
notification lifecycle. Push tests use the backend's actual colon-delimited event
identifier format.

## Proof boundaries

No Android device or emulator was used: the user's authorized device/UI target is
the existing iPhone 17 Pro iOS 26.0 simulator only. Android layout, system picker,
background execution, real media output and notification delivery remain runtime
validation gates. JVM fixtures and APK assembly are not live S3/Z440/FCM evidence.
No live account was created, no retained user data was removed, and no commit,
push, publication or deployment was performed.

## Main implementation files

- `android/app/src/main/java/com/hatem/musicmute/processing/`: typed jobs,
  immutable inputs, durable uploads/recovery, history and artifact caching.
- `android/app/src/main/java/com/hatem/musicmute/state/ProcessingViewModel.kt`:
  explicit source/actions, session fencing and localized playback.
- `android/app/src/main/java/com/hatem/musicmute/ui/VocalApp.kt` and
  `ProcessingHistoryScreen.kt` / `ProcessingDetailScreen.kt`: production navigation and localized processing screens.
- `android/app/src/main/java/com/hatem/musicmute/processing/PushRegistrationCoordinator.kt`: optional push
  binding, outcome hints and authenticated navigation.
- `android/app/src/test/`: contracts, persistence/recovery, isolation,
  polling, output error messages and notification regression tests.
