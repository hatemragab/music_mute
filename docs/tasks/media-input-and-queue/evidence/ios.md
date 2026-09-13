# iOS media input and queue evidence — 2026-09-13

Local source implementation on `codex/media-input-fair-queue`. No commits, pushes, releases, production writes, or physical-device execution by this owner.

## Implemented behavior

- Versioned policy parser and inclusive v2 prepared limits (1,800 seconds, 100,000,000 bytes), retaining exclusive v1 limits when v2 readiness is absent. Null local source/preparation evidence never expands intake. Policy version/profile/source metadata survives upload persistence and replay; multipart construction applies the accepted version.
- AVFoundation source inspection and deterministic default soundtrack selection from container enabled flags, rejecting ambiguous multi-track media. Compatible audio is copied; selected video audio is passed through into audio-only M4A where possible. Fallback uses AVAssetReader/AVAssetWriter AAC-LC, 256 kbps, 48 kHz stereo. Final audio is measured, size checked, and SHA-256 hashed before immutable upload.
- Source/prepared byte ceilings, available-space checks, preparation timeout/cancellation, separate inspection/preparation presentation, and finite UIKit background grace. Lost source access requires reselection. Prepared consent review survives relaunch; confirmed-upload cleanup retains uncertain inputs and never deletes original source assets.
- Individual Files audio/video selection and least-privilege PHPicker video selection. Photos provider materialization has a 60-second cancellation deadline, bounded copying, preserved source filename, private temporary storage, cleanup and account-fence handling.
- Bounded local YouTube public watch-page metadata adapter (5 MB, 30-second resource deadline, no credentials/cookies/redirect fallback). Typed validation requires an available matching video, explicit non-live metadata, and finite duration; playlist/live/upcoming/unknown/consent/login responses fail before audio transfer. Pinned YouTubeKit still extracts audio-only streams locally. Source delegates independently enforce actual bytes and a 600-second deadline; background retry retains its persisted start time. Native measured audio is checked again.
- Owner-scoped allowance/availability reads, used/reserved/remaining minutes and replenishment timestamps, safe admission error mapping without automatic quota/capacity retry loops, and English/Arabic UX. Existing rights/cloud consent, waiting versus processing timers, and on-demand cleaned-audio results remain.

## Observed native verification

Only existing **iPhone 17 Pro, iOS 26.0**, UDID **3CC14436-EC3C-4419-A079-C84951E5FA07** was used. Parallel testing was disabled; no simulator was created or substituted.

- Tests were introduced before the policy/selection and YouTube parser implementations; both initial targeted test builds failed on the missing implementation as expected.
- Native synthetic default-second MP4 test passed: first track 440 Hz, default second track 880 Hz; the prepared audio measured approximately 880 Hz and contained no video. Missing-audio rejection and WAV-to-M4A/source preservation passed.
- Real generated 30-minute AAC fixture `artifacts/media-input/long/audio-1800s.m4a` passed native v2 preparation: 1,800.0 seconds and more than 30 MB. This validates local audio preparation, not AI throughput or worker readiness.
- 153 unit tests passed, covering inclusive/legacy boundaries, accepted upload version, source preparation, rolling allowance parsing, account isolation, consent/restoration, safe errors and confirmed-input cleanup, plus deterministic YouTube metadata cases.
- Full platform suite executed: 150 then-current unit tests passed; seven of eight offline UI tests passed, and two opt-in live YouTube tests were skipped. The Files test failed because its caption tap did not activate the native file icon. The native picker screenshot/hierarchy confirmed it was still in Files; the helper was changed to target the labelled cell's icon.
- Focused rerun then passed all 151 then-current unit tests plus `ProcessingUITests/testExplicitDownloadAndNativeFileRequireRightsAndCloudConfirmation`, proving actual Files selection, rights/cloud review and submission. Other offline UI checks include Arabic RTL/dark/large text, offline cache, cancellation/retry, playback, export and deletion.
- `xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts`: passed with no output. Both English/Arabic localization files passed `plutil -lint`. `git diff --check -- ios`: passed.

Commands ran from `ios/` with `-project MusicMute.xcodeproj -scheme MusicMute -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' -derivedDataPath DerivedData -parallel-testing-enabled NO test CODE_SIGNING_ALLOWED=NO`. Focused runs used actual XCTest class/method selectors above. Project registration was regenerated with `xcodegen generate --spec project.yml`.

Local result bundles/logs:

- `ios/DerivedData/Logs/Test/Test-MusicMute-2026.09.13_16-04-51-+0300.xcresult`: full suite, including the diagnosed picker-helper failure.
- `ios/DerivedData/Logs/Test/Test-MusicMute-2026.09.13_16-11-09-+0300.xcresult`: passing unit/Files rerun, including real 30-minute preparation.
- `/tmp/musicmute-ios-youtube-green.log`: 153 passing unit tests after the local metadata adapter.
- Final post-review unit/build result is recorded below once complete.

## Evidence boundaries

No physical iPhone, real iCloud/provider transfer, Photos-picker runtime scenario, actual OS background-expiration event, live YouTube extraction/download, Firebase/backend/S3 production session, or AI processing benchmark was exercised. Photos/provider cancellation is implementation evidence; it is not a physical-device promise. The public YouTube page can change and must fail safely when its verified metadata is unavailable. No audio is transferred before the metadata check in new live service calls.

No unsupported codec/container matrix or all-device compatibility is claimed. Source/default-track fixtures are small and synthetic; the generated 30-minute fixture remains outside tracked iOS resources. Native evidence does not authorize backend expansion or worker slots; server readiness remains authoritative. Force-quit does not guarantee continuation.

## Final post-review validation

`/tmp/musicmute-ios-validated.log`: **153 tests passed, zero failures/skips** after the final source-deadline and metadata changes. `/tmp/musicmute-ios-build.log`: explicit designated-simulator `xcodebuild ... build CODE_SIGNING_ALLOWED=NO` **BUILD SUCCEEDED**. Final recursive swift-format lint passed again. The full UI suite was not rerun wholesale after the targeted native-picker repair; its failed scenario was rerun successfully, as documented above.

Parent integration review added strict mono/stereo source validation before downmix, exact preparation-profile validation, long-job pause enforcement before preparation, and persisted server source-download byte/time bounds for background processing. A real six-channel WAV reproduced the unsupported downmix before the fix; the corrected test rejects it. A policy test reproduced acceptance of an unknown profile and an ignored long-job pause before correction. Source-transfer restoration now checks its accepted byte ceiling.

`/tmp/musicmute-ios-review-green.log`: **156 unit tests passed, zero failures/skips**, including the new review regressions and the real 30-minute fixture. Full UI rerun is recorded separately after completion.

`/tmp/musicmute-ios-final-ui.log`: final full UI rerun **TEST SUCCEEDED**, all eight offline UI scenarios passed, with only the two explicitly opt-in live-media tests skipped. This supersedes the earlier full-suite picker failure. Recursive Swift formatting/lint passed after the parent changes.
