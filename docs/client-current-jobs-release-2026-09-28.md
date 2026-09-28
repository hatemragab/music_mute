# Current jobs and Library release — 2026-09-28

Home and processing lists on Android, iOS and web now show ongoing jobs.
Completed, failed and cancelled cloud jobs are hidden from those lists, including
on relaunch. Pending local consent/recovery remains accessible. Completed audio
stays in Library, and all database records and administrator history are retained.
No server delete endpoint or storage cleanup is called by this visibility change.

Android Home shows the localized creation date/time instead of only relative age;
iOS cards now show the server creation date/time, with local creation time used
before a server job exists. Web already displayed localized date/time.

Android Library now exposes Load more using the existing shared history cursor,
with disabled/loading and retry states. iOS Library adds pagination progress and
history errors. Web Library uses the existing `status=ready` filter and retains
loaded tracks beyond ten pages while bounding live subscriptions. All transfers,
owner boundaries, realtime snapshots and durable native Library data are preserved.

## Validation

- Web: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`
  (122 tests), `npm run build`, `npm run test:server` (9 tests),
  `npm run test:e2e` (6 installed-Chrome tests). Four focused new tests were also
  rerun after the live-page retention adjustment.
- Android: JDK 17 / SDK 36, `./gradlew --max-workers=2
  :app:testDirectReleaseUnitTest :app:lintDirectRelease
  :app:assembleDirectRelease :app:bundlePlayRelease` passed. 289 unit tests,
  no failures; lint has 0 errors and 190 warnings. `apksigner verify --verbose
  --print-certs` and `aapt dump badging` confirmed signing, package and version.
  No Android device/UI run was performed.
- iOS: `xcrun swift-format lint` on changed Swift files; `xcodebuild test`
  with `-parallel-testing-enabled NO`, `CODE_SIGNING_ALLOWED=NO`, and only the
  existing iPhone 17 Pro / iOS 26.0 simulator
  `3CC14436-EC3C-4419-A079-C84951E5FA07`. 30 focused presentation/history/store
  tests passed. Two new UI tests passed, covering paginated Library retention
  and finished-job hiding across offline relaunch. Three additional UI tests
  passed (Arabic large text, cancellation, original/voice comparison). The
  share/rename/play/save/delete regression test failed waiting for the Play
  button to become Pause after sharing. A diagnostic rerun with longer synthetic
  audio also failed; that speculative fixture change was removed. This
  additional playback failure remains unresolved; do not describe the full
  iOS UI suite as passing.
- `git diff --check` passed. Existing unrelated edits are preserved.

## Distribution

- Web CapRover app `app`: deployed version 12, image `img-captain-app:12`.
  Deployment connection reset after upload, so success was established separately
  by reading the active CapRover version, public `/healthz` (`ok`), and the live
  application bundle `App-CBJeoicu.js` containing the updated Current jobs copy
  and Library pagination behavior. This does not establish real-account processing.
- Android: signed version **0.1.10 (11)**. APK:
  `artifacts/MusicMute-0.1.10-build-11-release.apk`.
  APK SHA-256: `f9d1d356a593623b0c1031f098db72197027a9a58205a2e83288e677f2334804`.
  Play bundle: `artifacts/MusicMute-0.1.10-build-11-play.aab`.
  Signing certificate SHA-256:
  `417ee3745623721dd420d8056b0cc0a97d0ca5c571fa8da771f1eeed009f4b6d`.
  Published through the Chrome administrator dashboard on 2026-09-28 at 17:55 UTC.
  Release ID: `6abaa9a6a3f12dc9ed43c10a`. The uploaded APK was verified, and policy
  revision **1** selects build **11** with minimum supported Android build **11**.
  The dashboard preview classified builds 1 and 10 as Required, and build 11 as
  None. Independent public `/app-updates/policy?platform=android&distribution=direct`
  read-back confirmed the version, minimum, release ID, artifact hash and signer.
  Publication proof: `artifacts/android-0.1.10-mandatory-published.png`.
  This is direct Android publication; no Google Play publication occurred.
- iOS: source version **0.1.1 (2)**, simulator build/test passed. Distribution
  archive was attempted and failed because MusicMute has no development team
  configured. No IPA, TestFlight upload or App Store publication occurred.

No backend or administrator-dashboard source change/deployment is required for
these client presentation changes. No commit or push was performed. Packages
include the current checkout's pre-existing client edits; Git HEAD alone does
not identify their source tree.

## Main source files

- Android: `processing/AudioTaskPresentation.kt`, `ui/home/HomeScreen.kt`,
  `ui/home/JobCard.kt`, `ui/library/LibraryScreen.kt`, `ui/VocalApp.kt`.
- iOS: `Processing/AudioTaskPresentation.swift`, `UI/HomeView.swift`,
  `UI/AudioTaskCard.swift`, `UI/ProcessingHistoryView.swift`, `UI/LibraryView.swift`.
- Web: `src/home/HomePage.tsx`, `src/jobs/JobsUI.tsx`,
  `src/library/LibraryPage.tsx`, `src/realtime/RealtimeProvider.tsx`.
- Localized copy, native version manifests and behavior tests accompany the changes.
