# Owned-Audio Release Implementation Plan

> **Execution status:** Local implementation was authorized and completed on 2026-09-10, keeping YouTube secondary on both apps. See the [implementation and validation record](../../validation/2026-09-10-store-readiness.md) for actual files, tests and outstanding release requirements. The original checklist below is retained as design history; proposed filenames and test commands may differ from the final implementation.

**Goal:** Make user-imported, owned or permitted audio the primary MusicMute flow while keeping YouTube accessible as a secondary feature on both apps.

**Architecture:** Reuse native document pickers, input preparation, account-scoped processing repositories and private S3 transfers. Separate selecting/reviewing an input from the explicit upload-and-process action. Keep the existing vocals-only output and playback lifecycle.

**Tech Stack:** Kotlin/Compose, Swift/SwiftUI, existing native media inspection, NestJS processing contracts, Gradle and Xcode.

**Spec:** [Store readiness design](../specs/2026-09-10-store-readiness-design.md).

## Global constraints

All Global constraints in the linked spec apply. Do not add format support, recording, sharing, billing or offline processing. Preserve existing duration limits and exclusive 30,000,000-byte limit; verify exact supported containers from both native validators and the server before writing format copy. No publishing or commits are authorized.

## Task 1: Android select, review, confirm, process

**Modify:** `android/app/src/main/java/com/hatem/musicmute/ui/VocalApp.kt`, `state/ProcessingViewModel.kt`, `processing/AudioInputPreparer.kt`, `processing/ProcessingRepository.kt`, and existing localized strings.

**Create:** `android/app/src/main/java/com/hatem/musicmute/ui/AudioImportReview.kt`; `android/app/src/test/java/com/hatem/musicmute/processing/OwnedAudioImportTest.kt`.

**Interfaces:** model exposes immutable import review state (selection ID, display filename, validated bytes/duration, validation error, rights confirmation, submitting flag). Proposed actions: `selectAudio(uri: Uri)`, `setImportRightsConfirmed(confirmed: Boolean)`, `confirmImport()`, `cancelImport()`. Existing import/processing entry points must route through this state; no alternate path silently bypasses confirmation.

- [ ] Write failing model tests asserting zero job/create/upload calls after selecting a file, until valid input plus rights confirmation plus an explicit process action.
- [ ] Promote “Import audio” as Home's primary action. Show supported formats/limits from the actual contract and explain remote processing before upload.
- [ ] Prepare and validate a private copy using existing account-scoped input preparation, without starting upload. Bound storage use; clean cancelled/replaced staged selections. Check account generation again before confirmation.
- [ ] Render filename, size, duration, vocals-only output and “I own this audio or have permission to process it.” Require an explicit “Remove music” tap. Do not imply the application verifies ownership.
- [ ] Reuse the existing pipeline for confirmed input. Prevent duplicate submissions, stale selected URIs and resumed callbacks from another account. Show preparation/upload/queue/processing/failure states accurately.
- [ ] Extend tests for unsupported/empty/corrupt/oversized media, missing provider access, low disk, cancelled picker, repeated taps, offline queueing and logout while reviewing. Confirm imported originals are never modified/deleted.
- [ ] Run `cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`.

## Task 2: iOS matching import flow

**Modify:** `ios/Vocal/UI/HomeView.swift`, `UI/ProcessingRootView.swift`, `State/ProcessingModel.swift`, `Processing/AudioInputPreparer.swift`, `VocalApp.swift`, and existing localized resources.

**Create:** `ios/Vocal/UI/AudioImportReview.swift`; `ios/VocalTests/OwnedAudioImportTests.swift`. Extend `ios/VocalUITests/ProcessingUITests.swift` using a bundled owned/licensed fixture.

**Interfaces:** mirror Android review-state fields and the selection/rights/confirm/cancel actions in Swift naming. Reuse existing security-scoped URL and coordinated-copy implementation; a selected external URL must not become an unbounded persistent permission assumption.

- [ ] Write failing tests showing Home and Processing-tab pickers both require review and explicit confirmation before a cloud request.
- [ ] Implement review/confirmation with account/session tickets, bounded private staging and predictable cancellation cleanup. Stop accessing security-scoped resources after the safe copy.
- [ ] Test revoked Files access, provider download errors, corrupted media, background/foreground changes, account switch, duplicate taps and a cancelled review. Preserve explicit-tap playback and user exports.
- [ ] Run `cd ios && xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" test`.

## Task 3: Secondary YouTube flow with explicit consent

**Modify:** Android `ui/VocalApp.kt`, `state/ProcessingViewModel.kt`, download callers and `download/AudioDownloadWorker.kt` where it hands off to processing; iOS `ios/Vocal/UI/HomeView.swift`, `State/ProcessingModel.swift`, `VocalApp.swift` and existing download-completion handoff. Verify full paths at execution because this checkout is actively changing.

**Preserve:** YouTube extraction and its dependencies, playback, source and processed downloads, history, user files and needed foreground-service declarations. Do not introduce flavors or remove downloader functionality.

- [ ] Write failing navigation/model tests: Import audio is primary; a labelled YouTube secondary action remains reachable on both apps; opening it does not start network work.
- [ ] Move URL entry into that secondary flow, retaining URL validation and cancellation. Include permission guidance and an explicit download action. Do not add copyrighted sample links or claim this guidance proves rights.
- [ ] Add a review/confirm boundary before cloud processing a downloaded source. Reuse Tasks 1–2 review fields with truthful source attribution. Remove automatic upload from download-completion handoff unless the user has already explicitly consented to that exact source and cloud action; the default proposed UX is a separate confirmation after download.
- [ ] Persist a distinct local awaiting-confirmation state so restart, WorkManager retries, notifications and account restoration cannot silently upload the file. This state must not reserve a cloud FIFO job or occupy the worker slot. Cancelling review preserves an intentionally saved source and clears only review-specific staging.
- [ ] Test completed-download restoration, failed downloads, malformed URLs, repeated actions, account switch, cancel/retry and opening saved originals. Confirm there is no route that bypasses cloud consent or mislabels a YouTube file as user-imported.
- [ ] Review merged manifest and retained dependency behavior, including extractor updates, against current store requirements. Record unresolved review risks honestly; do not hide functionality from reviewers.
- [ ] Run `cd android && ./gradlew :app:lintRelease :app:testReleaseUnitTest :app:bundleRelease` using existing signing configuration without printing secrets, and the iOS tests from Task 2. Report signing/configuration blockers.

## Task 4: Product copy, privacy and store evidence

**Modify:** `README.md`, `android/README.md`, `ios/README.md`, localized Home/onboarding/help resources. **Create:** `docs/store/owned-audio-listing.md`, `docs/store/release-evidence.md`.

- [ ] Use plain copy: “Create vocals-only audio from files you own or have permission to use.” Describe actual cloud upload/processing and supported formats; do not claim automatic copyright verification, entirely offline processing, or instrumental output.
- [ ] Lead listing copy/screenshots with owned-audio import and accurately mention the secondary YouTube flow. Remove unauthorized-song examples and unsupported promises. Use owned or documented licensed fixtures; retain their license/source evidence in the release record.
- [ ] Link the verified privacy and account-deletion resources from the deletion plan. Record actual collected/shared categories, retention and processing destinations before completing Data Safety.
- [ ] Demonstrate real upload/download `dataSync` and audio `mediaPlayback` use for the foreground-service declaration. Check the resulting manifest and code; do not strip permissions required by the retained WorkManager or Media3 behavior.
- [ ] Describe the full flow in release review notes: import → validate/review/rights confirmation → explicit processing → status → vocals-only playback/export → account deletion.
- [ ] Mark Android device/UI evidence outstanding under the current simulator-only instruction. Do not substitute another simulator or fabricate demonstration videos. Store submission needs a later explicit device-testing decision and actual recordings.

## Task 5: Regression and release acceptance

- [ ] Run Android/iOS checks above. If shared processing contracts change, run `cd backend && npm run verify && npm run test:processing:integration`; otherwise avoid unrelated backend changes.
- [ ] Verify import restrictions match both clients and backend; no empty/oversized file bypasses client or server validation. Confirm offline/cancel/retry, account isolation, library migration, output download and export behavior.
- [ ] Review the exact Play bundle and listing together. Confirm both the primary import and retained secondary YouTube features match the description. Record that downloader-related policy risk remains and that rights confirmation does not itself establish compliance.
- [ ] Verify the account-deletion plan's public and backend release gates before submission. Publish neither pages nor the app under this planning request.

No tests in this document have been executed as part of drafting it. Policy basis and unresolved questions are in the linked spec; neither this plan nor its eventual implementation guarantees Google Play acceptance.
