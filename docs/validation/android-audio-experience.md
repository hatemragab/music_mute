# Android automatic audio experience validation

Date: 2026-09-10

## Implemented scope

- A complete pasted supported URL is accepted immediately. A manually typed URL
  commits on keyboard Done or focus exit. Selecting a local audio file also
  persists an operation before copying.
- A durable coordinator connects source download/import, preparation,
  idempotent reservation, S3 upload, confirmation, and recovery.
- Local pipeline concurrency is capped at two. Each operation has independent
  cancellation, retry, identity, progress, and account/session fencing.
- WorkManager source and upload work uses immutable owner, operation, epoch, and
  request identities. Late work cannot update or clean up a replacement attempt.
- The processed-audio list merges local operations and backend jobs. Detail
  includes the real stage timeline, full reference/job ID, total and processing
  timing, Rename, Delete, Play, Download, Save, and Share.
- Result MP3 bytes are fetched only for Play, Download, Save, or Share. Sharing
  uses an app FileProvider URI with temporary read access.
- Safe client failures are stored in a bounded UID-scoped outbox and uploaded
  best effort without blocking the audio task.

Main implementation files:

- `processing/AudioPipelineCoordinator.kt`,
  `processing/ProcessingRepository.kt`, and `processing/ProcessingStore.kt`
  own intake, durable handoff, retries, cancellation, and account fencing.
- `download/DownloadRepository.kt`, `download/AudioDownloadWorker.kt`, and
  `processing/AudioUploadWorker.kt` own source/upload scheduling and foreground
  transfer progress.
- `processing/JobModels.kt`, `processing/JobsApiClient.kt`,
  `processing/ClientErrorOutbox.kt`, and
  `processing/JobArtifactRepository.kt` own contracts, diagnostics, and
  on-demand output.
- `state/ProcessingViewModel.kt`, `ui/ProcessingHistoryScreen.kt`,
  `ui/ProcessingDetailScreen.kt`, `ui/AudioTaskCard.kt`, and
  `ui/AudioStepTimeline.kt` own the unified processed-audio experience.

## Local evidence

Run from `android/` with
`ANDROID_HOME="$HOME/Library/Android/sdk"`:

```sh
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Result: `BUILD SUCCESSFUL`; 132 unit tests passed with zero failures, errors, or
skips, and both lint and debug APK assembly completed. The notification/source
policy suite contributed 8 passing tests and input preparation contributed 10.
Coverage includes API metadata/rename/delete
contracts, durable intake and recovery, source/worker identity fences,
notification projection and action ownership, presentation mapping, artifact
cache deletion races, sharing intent shape, and the diagnostic outbox.

Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`
(88,583,799 bytes).

English and Arabic resources each contain 280 unique keys. Their
`audio_*`/`processing_*` key sets match. This is source parity evidence;
Arabic, light-theme, and accessibility rendering were not exercised on a
device.

## Physical Android launch evidence

The debug APK was installed with data-preserving replacement semantics on the
connected physical Xiaomi 23043RP34G (`$ANDROID_DEVICE_SERIAL`), running Android 14 (API 34):

```sh
adb -s "$ANDROID_DEVICE_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_DEVICE_SERIAL" shell am start -W \
  -n com.hatem.musicmute/.MainActivity
```

Installation returned `Success`. The launcher resolved to
`com.hatem.musicmute.MainActivity` and the first launch returned `Status: ok`,
`LaunchState: COLD`, and `TotalTime: 1788`. The app process was running as PID
26742, and Android reported the MusicMute activity as visible and top-resumed
after it was brought back to the foreground.

The first visible screen rendered the dark-theme `Finishing sign-in` state with
connection and installation-registration progress. The foreground app then
rendered the new audio detail experience, including the complete stage timeline,
reference ID and Copy action, approximate total time, Rename, and Refresh. This
proves installation, launch, process survival, foreground activity, and visible
rendering of the new timeline on physical Android hardware. No account action,
external submission, cancellation, deletion, or full processing workflow was
performed.

## Contract and deployment boundary

The Android contract is checked against the repository backend API document and
fixtures. This is local source/fixture evidence. It does not prove that the
matching backend version, S3 integration, or Z440 worker is deployed and
reachable in production.

## Runtime scenarios still required

The authorized physical-device smoke launch is complete. These broader runtime
cases remain unrun:

- locked-screen and background URL download through automatic upload handoff;
- notification permission denied, progress dismissal, Android 14 dismissal,
  foreground-service timeout, and battery restriction behavior;
- network loss/switching, force-stop, relaunch, and process death at each stage;
- real system file picker, document save picker, and share chooser;
- two simultaneous long tasks and cancellation of only one;
- real production API, S3, push notification, and Z440 worker completion;
- Arabic RTL, large text, TalkBack, dark/light themes, and reduced motion;
- output playback through Media3 and cache cleanup after remote deletion.

Do not run these scenarios on another Android device or emulator without
explicit authorization.
