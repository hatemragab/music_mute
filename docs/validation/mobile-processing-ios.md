# iOS audio processing validation

Date: 2026-09-10. Local implementation and simulator validation complete.

## Implemented flow

Processing supports a Files import followed by explicit submission, or Remove music
on a saved original. Codable jobs, immutable validated inputs, file-backed signed
S3 multipart upload tasks, durable operation/retry records, cloud history/detail,
worker interruption, cancel/retry, private MP3 caching, playback/export, and optional
FCM/APNs registration are integrated. Originals never automatically submit.

Account changes cancel/fence old work, clear visible private metadata and stop private
playback. Restored uploads reconcile durable intent before retrying. Outputs download
only after an explicit action and require a new explicit action after interruption
or process loss. Retained files are not automatically swept. Native validation checks
the actual MP3 container and decodes audio frames before cache promotion.

## Authorized target and commands

Only the existing iPhone 17 Pro, iOS 26.0 simulator is used:
`$IOS_SIMULATOR_UDID`.

```sh
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData-auth -parallel-testing-enabled NO \
  -only-testing:VocalUITests -only-testing:VocalTests \
  test CODE_SIGNING_ALLOWED=NO
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath DerivedData-processing-release \
  build CODE_SIGNING_ALLOWED=NO
```

The unsigned generic iOS Release build passed with bundle ID `com.hatem.musicmute`.
The final rebuild includes both last race fixes (`/tmp/vocal-processing-release-final.log`).
Recursive strict Swift lint passed with zero findings; `git diff --check` passed.
Warnings were limited to Firebase's deprecated FCM-token method and absent AppIntents
metadata. The token method remains necessary for the backend's FCM registration-token
contract; an installation identifier is not a substitute. The final combined run
passed 100 unit tests and 7 UI tests; 2 explicitly opt-in live-network tests were
skipped. The unit suite includes the cache-load/manual-refresh polling race, output
storage error messages and stale-session cleanup targeting only its exact transfer.
English playback/seek, Arabic dark accessibility-XL detail, and the native Save
picker screenshots were visually inspected: text remains readable and actions fit
the scrollable layout without clipping. The dedicated
DEBUG-only `--processing-ui-fixture` entry uses isolated storage and typed fixture
services; it bypasses Firebase startup and creates no real accounts.

The five processing UI checks cover cancellation acknowledgement, retry to a new
job, Arabic dark accessibility-XL detail, cached history after offline relaunch,
validated synthetic MP3 playback/seeking, native Save picker opening/dismissal,
and explicit Remove music on a seeded original. The original-file action exercises
real preparation/checksum/staging/multipart creation with injected upload completion
and API confirmation to a queued job. Two existing Home/History/settings UI checks
also pass. Native Files import selection and a completed provider export were not
automated; preparation/export boundaries have unit coverage.

Final combined log: `/tmp/ios-i08-verified.log`.
Result: `ios/DerivedData-auth/Logs/Test/Test-MusicMute-2026.09.10_01-11-21-+0300.xcresult`.
Passing screenshots: `/tmp/ios-i08-verified-attachments/arabic-ready-large.png`,
`english-playback-seek.png`, `native-save-picker.png`, `original-queued.png`.

## Proof boundaries

Simulator/unit fixtures verify client behavior, not acoustic separation or real
S3/Z440 results. Live APNs/FCM delivery, provisioning and production credentials,
device background-transfer survival, real Files-provider export, and deployed API
integration remain separate operational checks. Simulator push transport is disabled;
sanitized local hints still exercise authenticated routing logic. No alternate device,
commit, push, publication or deployment is part of this validation.

## Main implementation files

- `ios/Vocal/VocalApp.swift`: retained production graph, explicit source routes,
  account/foreground binding and authenticated notification navigation.
- `ios/Vocal/Processing/JobsAPIClient.swift`, `ProcessingRepository.swift`,
  `ProcessingStore.swift`, `BackgroundTransferCoordinator.swift`: contracts,
  durable operations, exact-transfer cleanup and recovery.
- `ios/Vocal/Processing/AudioInputPreparer.swift`, `JobArtifactRepository.swift`,
  `ArtifactDownloadTransport.swift`: immutable inputs and validated private output.
- `ios/Vocal/Processing/PushRegistrationCoordinator.swift`, `NotificationDelegate.swift`:
  optional push lifecycle and safe hints.
- `ios/Vocal/State/ProcessingModel.swift`, `ProcessingHistoryModel.swift`,
  `ios/Vocal/UI/Processing*View.swift`: localized history, detail and actions.
- `ios/Vocal/UI/ProcessingUITestHarness.swift`, `ios/VocalTests/`,
  `ios/VocalUITests/ProcessingUITests.swift`: isolated regression and UI proof.
