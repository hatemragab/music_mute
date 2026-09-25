# Mobile URL acquisition removal — 2026-09-26

## Supported flow

- Local audio/video: native preparation, review/consent, signed S3 upload, processing.
- Public URL: Android submits `/media-imports`; the server acquires an audio-only
  stream, validates it, uploads to S3, preserves its original title, and creates
  the normal processing job. No source audio passes through the phone.
- iOS retains Files/Photos intake, job history, result playback and export. Its old
  URL form is removed; a new iOS server-import form is not implemented in this change.

## Removed

Android: bundled yt-dlp/Python runtime, extractor maintenance, source-download
workers, URL preflight/selection/pacing, download history, duplicate URL controls,
demo workflow, and downloader-only tests/resources. Release R8 optimization and
resource shrinking are enabled; all four existing ABIs remain supported.

iOS: YouTubeKit package/pin, source downloader and background transfer coordinator,
DownloadModel, download-history persistence/UI/models, original-source export path,
and downloader-only tests/resources. Result playback now accepts a job playback ID
and title directly, without constructing an old download record.

Backend: `/jobs` rejects `source: youtube`, `source_kind: url`, and `source_url`
from mobile submissions. Public policy no longer includes device download limits.
The internal URL metadata used by server imports remains necessary and supported.
No database migration or deletion of stored media was performed.

There is no device-download compatibility path. Unknown persisted phase values
stop local recovery rather than launching work or making other jobs unreadable.
Older clients using the removed contract need an update.

## Validation

Backend `pnpm run verify`: 864 unit tests and 147 HTTP tests passed, including
retired request rejection. `pnpm run test:imports:integration`: 6 passed, including
compiled startup, admission/concurrency/recovery and trim
choice. A second `pnpm run build` passed. `pnpm audit --prod` reported no known
vulnerabilities.

Android validation command (JDK 17, configured Android SDK):

```sh
./gradlew :app:testDirectDebugUnitTest :app:lintDirectDebug \
  :app:assembleDirectRelease :app:assemblePlayRelease
```

Swift changed files were formatted and checked with `xcrun swift-format`.
iOS runs use only the existing iPhone 17 Pro iOS 26.0 simulator, with parallel
cloning disabled:

```sh
xcodebuild -project ios/MusicMute.xcodeproj -scheme MusicMute \
  -destination 'id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO \
  -only-testing:VocalTests test
```

Android: **265 JVM tests passed**, lint passed, and Direct/Play release builds passed.
The direct APK signature verified with `apksigner verify`. Its archive contains no
Python, yt-dlp, youtubedl or QuickJS runtime entries.

| Direct release APK | Bytes | Decimal MB |
| --- | ---: | ---: |
| Before removal | 82,201,837 | 82.20 |
| After removal | 6,698,288 | 6.70 |

Reduction: **91.85%**, with all existing ABIs retained.
The saved baseline and new APK were measured directly, rather than estimating
savings from dependency sizes.

iOS: **138 unit tests passed**. Home/settings and result rename, playback, seek,
share, Save to Files and deletion fixture UI checks passed on the authorized
simulator. The native Files selection test initially did not activate the selected
file in the system picker; selecting its visible caption fixed the test. The
rerun passed through native file selection, review/rights confirmation and job
creation. All **3 targeted UI tests passed** across their final runs. These are
synthetic fixtures, not live backend/S3 proof.

Targeted UI selectors:

- `VocalUITests/VocalUITests/testHomeValidationAndSettings`
- `VocalUITests/ProcessingUITests/testNativeFileRequiresRightsAndCloudConfirmation`
- `VocalUITests/ProcessingUITests/testReadyRenameOnDemandSharePlaybackSaveAndConfirmedDelete`

## Delivery boundary

Changes are in the current repository; the Android release build was produced in
the existing Android worktree with its local signing configuration. No credentials
or generated configuration were copied into source. Source publication uses `hatem/cobalt-url-import`. This cleanup has not been
deployed to production, released to a store, or installed on Android.
Native release runtime and full live S3/worker processing after this cleanup remain
separate from the local build, fixture UI and isolated integration evidence.
