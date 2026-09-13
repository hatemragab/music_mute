# iOS implementation tasks

**Status: not started; plan approval required.** Read [scope](../scope.md) and [contracts](../contracts.md). Own iOS source/tests/docs. Use native Swift/SwiftUI and AVFoundation within the existing iOS 17 floor. Device/UI testing is restricted to existing iPhone 17 Pro / iOS 26.0 simulator `3CC14436-EC3C-4419-A079-C84951E5FA07`; no substitutes.

## I01 — Native source inspection and local audio preparation

**Depends on:** B01, R01. **Consumes/produces:** C1 policy, C5 source/preparation contract, existing `PreparedInput`/job declaration.

**Modify:** `ios/Vocal/Processing/{AudioInputPreparer.swift,PreparedInput.swift,JobModels.swift,JobsAPIClient.swift}`, relevant `ios/Vocal/Core/AudioModels.swift` policies, `ios/VocalTests/AudioInputPreparerTests.swift`, and `ios/README.md`.

**Create:** `ios/Vocal/Processing/{ProcessingMediaPolicy.swift,MediaSourceInspector.swift,AudioPreparationEngine.swift}` and matching test files under `ios/VocalTests/`. Add files through current XcodeGen/source conventions; do not hand-edit generated project content unnecessarily.

- [ ] Add parser/boundary/selection tests for legacy/v2 policy, exact 1800 seconds, excess, exact 100 MB, corrupt media, missing audio, default-not-first, unusable default plus alternate, and unsupported image codec with readable audio.
- [ ] Inspect default audible media selection using AVFoundation; when there is no selection group and exactly one audible track use that track. Do not use the first track index as a language-selection shortcut or try a different usable track after the default fails.
- [ ] Copy already compatible audio or passthrough/remux the selected audio when supported. Otherwise use an audio-only AVFoundation conversion path with R01 profile and tested channel/sample-rate behavior. Evaluate actual `supportedFileTypes`/export compatibility instead of guessing from the extension.
- [ ] Enforce original-size/space/time bounds and inspect measured presentation duration before processing. Read/export only audio; do not decode/render video or silently truncate to 30 minutes.
- [ ] Produce a final audio-only file atomically, validate decoding/duration/bytes, compute checksum, and return existing prepared-input identity. Handle AAC priming/padding without broad duration tolerance or duplicated samples. Never upload a partially cancelled export.

**Test seed:** define `ProcessingMediaPolicy.acceptsPrepared(bytes:durationSeconds:)` and test:

```swift
XCTAssertTrue(policy.acceptsPrepared(bytes: 100_000_000, durationSeconds: 1800))
XCTAssertFalse(policy.acceptsPrepared(bytes: 100_000_001, durationSeconds: 1800))
XCTAssertFalse(policy.acceptsPrepared(bytes: 1000, durationSeconds: 1800.001))
```

Use a complete C1 fixture; also exercise real R01 media in simulator integration tests. Pure fakes are not decoder proof.

**Validation:** run focused `VocalTests/AudioInputPreparerTests`, `VocalTests/ProcessingMediaPolicyTests`, and new inspector/export tests using the explicit simulator command in I04.

**Acceptance:** measured extraction/conversion and correct default-track behavior on authorized simulator fixtures; physical-device/per-OS rows retain their actual evidence status.

## I02 — Pickers, background recovery, and temporary storage

**Depends on:** I01. **Consumes/produces:** C5 local phases and persisted input; existing background transfer and operation identity.

**Modify:** `ios/Vocal/UI/{HomeView.swift,ProcessingRootView.swift,AudioImportReview.swift}`, `ios/Vocal/Processing/{AudioPipelineCoordinator.swift,AudioPipelineRestoration.swift,BackgroundTransferCoordinator.swift,ProcessingStore.swift,ProcessingAppDelegate.swift}`, relevant app scene lifecycle, and `ios/VocalTests/{AudioPipelineCoordinatorTests.swift,AudioPipelineRestorationTests.swift}`.

**Create:** `ios/Vocal/Processing/{MediaPreparationCoordinator.swift,PreparedMediaCleanup.swift}` and matching tests. Change `ios/Vocal/Info.plist` or `ios/project.yml` only for capabilities actually required by the chosen native background/picker path; do not add unsupported background promises.

- [ ] Test individual file/photo picks, provider download, security-scoped access, bookmark/grant loss, duplicate picker callback, cancellation, account change, and restoration after app termination.
- [ ] Extend Files selection to supported audio/video and add video selection through the system Photos picker with least-privilege access. Preserve original source and display name; do not request full photo-library permission when the system picker suffices.
- [ ] Stage only when the provider requires it and available space meets R01 bounds. Keep security-scoped access balanced and files owner-scoped. Reselection is required if recovery cannot reacquire source permission; do not hide that failure behind retries.
- [ ] Continue exports during OS-granted execution time; use only supported background scheduling APIs/capabilities. Persist restartable state when suspended/expired and restart or resume safely when execution returns. Do not claim URLSession background transfer also guarantees background transcoding.
- [ ] Keep existing background URLSession upload restoration. On uncertain upload completion reconcile backend receipt before temporary-file deletion; retain prepared file for retry. Cleanup affects temporary preparation only, not original video or saved source audio.
- [ ] Present inspecting/preparing/uploading distinctly with cancellation and truthful progress. Force-quit cannot guarantee continued execution; relaunch recovers without duplicate reservations/exports.

**Required scenario:** export completes, app is interrupted before upload reservation, restore reuses the verified prepared file. Another scenario interrupts after PUT before upload-complete receipt; cleanup waits for reconciliation. Changing accounts cannot reuse another owner's prepared input.

**Validation:** focused coordinator/restoration/cleanup XCTest suites and synthetic picker UI flows on the designated simulator. Report actual OS background behavior separately from mocked restoration tests.

**Acceptance:** source permissions/storage/recovery logic and simulator proof; no assertion of guaranteed background completion on a physical iPhone or after force-quit.

## I03 — YouTube preflight and hard transfer limits

**Depends on:** I01, I02. **Consumes/produces:** C1/C5 policy and common prepared-input path.

**Modify:** `ios/Vocal/Data/{YouTubeAudioService.swift,AudioFiles.swift}`, `ios/Vocal/Processing/BackgroundTransferCoordinator.swift`, source-transfer delegates actually used by `YouTubeAudioService`, and URL/consent presentation. Inspect the pinned YouTubeKit 0.4.9 metadata API before changing adapters; no speculative dependency upgrade.

**Create:** `ios/Vocal/Data/YouTubePreflight.swift` and `ios/VocalTests/YouTubePreflightTests.swift`; extend existing download/transfer/coordinator tests.

- [ ] Test individual-video URL, playlist context, live/upcoming, unavailable/unknown duration, exact 30 minutes, longer media, metadata timeout, and missing/incorrect response length.
- [ ] Obtain trustworthy bounded metadata before transferring audio. If the existing library cannot safely determine live status/duration, mark that input unsupported with a clear reason; never download an unbounded stream as fallback.
- [ ] Select audio only, retain native compatibility and consent disclosures, and enforce actual streamed bytes/deadline in foreground and background transfer delegates. A known `Content-Length` is an early check, not the only limit.
- [ ] Revalidate downloaded audio through I01 before backend admission; reconcile duration discrepancies and reject excess. Guard progress callbacks, redirects, cancellations, resume data, and retry counters so a resumed download cannot reset the total byte/time budget.
- [ ] Keep URL resolution and preparation in the same owner/operation identity; clean partial provider downloads safely and preserve signed-URL privacy.

**Required assertions:** rejected preflight never invokes transfer; a declared 10-minute download measured over 30 minutes never invokes job creation; a response with unknown length is cancelled when actual bytes exceed the download ceiling.

**Validation:** focused preflight/download/transfer XCTest suites on the designated simulator using synthetic responses. A real YouTube smoke check, if later authorized, is separate evidence and cannot replace deterministic over-limit/live/playlist fixtures.

**Acceptance:** bounded source acquisition and measured validation; no video fallback, playlist item selection, or quota bypass.

## I04 — Allowance, queue, localized messages, and platform validation

**Depends on:** I02, I03, B02, B03, B06. **Consumes/produces:** C2 usage and C6 outcomes via current observable/state/presentation architecture.

**Modify:** `ios/Vocal/Processing/{JobsAPIClient.swift,JobModels.swift,AudioTaskPresentation.swift}`, `ios/Vocal/State/ProcessingModel.swift`, relevant `ios/Vocal/UI/{AudioTaskCard.swift,ProcessingDetailView.swift,HomeView.swift}`, and `ios/Vocal/Resources/{en.lproj/Localizable.strings,ar.lproj/Localizable.strings}`.

**Create:** `ios/Vocal/Processing/ProcessingUsageRepository.swift` and matching tests; extend existing API/presentation/UITest fixtures.

- [ ] Add usage contract tests for rolling replenishments, reserved/used separation, full queue, policy mismatch, partial/unknown estimates, active jobs across devices, and pending cancellation settlement.
- [ ] Fetch a nonbinding availability snapshot before expensive preparation when possible, then handle authoritative admission rejection without a retry loop. Refresh usage after state changes and clear owner data on account switch.
- [ ] Show remaining allowance and next replenishment using server time; give a range only for trustworthy queue estimates. Waiting and processing timers remain distinct. Preserve automatic individual submissions and on-demand result fetch.
- [ ] Add clear English/Arabic error text for duration, bytes, default soundtrack, missing audio, unsupported codec, YouTube restrictions, allowance, capacity, lost provider access, and interruption. Check accessibility and right-to-left layout with the existing task card design.
- [ ] Run formatter, tests, and build, then record simulator versus physical/network evidence accurately.

**Validation (ios cwd; first check the exact simulator exists):**

```sh
xcrun simctl list devices available
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedData build CODE_SIGNING_ALLOWED=NO
```

For focused tasks add `-only-testing:VocalTests/<actual-test-class>` using the class names above; the full command is the final platform gate. If project source configuration changes, use the documented `xcodegen generate --spec project.yml` workflow and inspect generated-file policy before deciding what belongs in the diff. Do not change generated files casually.

**Acceptance:** simulator-backed UI/media evidence and successful static/build/test commands, or explicit blockers. Absence of the designated simulator is a blocker, not permission to substitute another device.
