# iOS Audio Experience Implementation Plan

Execution update (2026-09-10): I01–I07 are complete locally. Focused unit tests,
five distinct exact-simulator UI scenarios, formatter and unsigned Release build
passed. See the validation report for live-service and background proof boundaries.
The historical planning-only notices below are superseded for implementation;
commit, push, deployment, and execution on other devices remain unauthorized.
See the [execution record](../../tasks/automatic-audio-experience-execution.md).

> **For agentic workers:** Use superpowers:executing-plans when implementation is authorized. Steps use checkbox syntax for tracking. No implementation or commits in this planning task.

**Goal:** Make a URL paste or local audio selection automatically progress to a named processed result, with clear SwiftUI status and user-controlled playback/download/sharing.

**Architecture:** Extend the current SwiftUI observable models, actor-backed processing store, background URLSession transfers, and native audio player. Introduce a durable operation coordinator joining source download and existing processing submission outside view lifecycle tasks.

**Tech Stack:** Swift, SwiftUI, structured concurrency/actors, URLSession background transfer, existing extractor, AVAudioPlayer, native file importer and share sheet.

**Spec:** [Agreed automatic audio experience](../specs/2026-09-10-automatic-audio-experience.md). Current backend behavior is documented in `backend/docs/api/audio-processing.md`.

## Global constraints

- Planning only; no application code, commit, push, deployment, live deletion, or infrastructure changes.
- Begin immediately on complete pasted URL or selected audio; no second Start/Submit step. Individually added submissions can overlap. Transfers may use any available network.
- Preserve names; support rename, deletion, cancellation acknowledgement, bounded retry, timing, IDs, and processed-output-only media presentation.
- Fetch output only on Play/Download/Share. Keep existing input limits: nonempty, smaller than 30,000,000 bytes, shorter than 600 seconds.
- Keep iOS 17.0 minimum and current project/dependencies. Preserve UID/session fencing, English/Arabic, RTL, Dynamic Type, VoiceOver, light/dark and reduced motion.
- Device/UI tests only on iPhone 17 Pro, iOS 26.0, UDID $IOS_SIMULATOR_UDID. If unavailable, report a blocker; do not create/download/use another simulator or phone.
- Do not promise continuous execution after suspension or explicit force-quit. Restore permitted work without duplicate server jobs.
- No migration deletes old originals, imported source files, or external exports.

## File roots and execution pattern

Production paths below are relative to ios/Vocal/; test paths are relative to ios/VocalTests/ unless explicitly marked. New files are labeled Create. Check current source/project wiring before implementation and preserve unrelated modifications.

For each task, add its named failing tests, run the focused suite on the exact authorized simulator, implement the smallest complete change, and rerun the suite. From ios, use xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" -derivedDataPath DerivedData-audio-experience -parallel-testing-enabled NO -only-testing:VocalTests/AudioPipelineCoordinatorTests test CODE_SIGNING_ALLOWED=NO after that proposed test exists. Replace the test selector for each task; confirm existing test target names in the project.

## I01 — Codable contract and durable operation metadata

**Dependencies:** B01 fixtures, with B02–B04 shape updates before final integration. **Produces:** shared typed contract/store state for I02–I07.

**Files:** modify Processing/{JobModels.swift,JobsAPIClient.swift,UnavailableJobsAPI.swift,ProcessingStore.swift,ProcessingRepository.swift}; extend JobsAPIClientTests.swift, ProcessingStoreTests.swift, and UploadRecoveryTests.swift.

- [ ] Add decode/encode cases for legacy jobs, new title/sourceKind/requestId, null/approximate timings, rename/delete/report payloads, unknown server status, and stale deleted detail.
- [ ] Extend Codable types and API abstraction/mock implementations with the exact backend fields. Keep existing route prefixes/envelopes/auth-refresh behavior.
- [ ] Persist operation UUID before preparation, source metadata and user override, current phase, job identity, clocks, retry intent, and cancellation intent in UID-scoped actor storage. Version the schema and migrate old operations without automatically submitting legacy original history.
- [ ] Make state changes atomic across app restarts. Reuse operation UUID as initial requestId; restore old logical mutations rather than generating fresh IDs after an uncertain response.
- [ ] Run contract, persistence, and recovery tests; align the same fixtures with Android. Mark new endpoints unavailable until backend deployment is actually verified.

**Acceptance:** legacy files and history remain readable; replay produces one job; operations cannot leak between signed-in accounts.

## I02 — Immediate URL/file intake and automatic submission

**Dependencies:** I01. **Produces:** independent durable pipelines and phase updates for I03/I04/I05.

**Files:** modify State/{DownloadModel.swift,ProcessingModel.swift}, Processing/{AudioInputPreparer.swift,ProcessingRepository.swift}, UI/{HomeView.swift,ProcessingRootView.swift}; inspect and reuse the current URL extractor/download transport behind DownloadModel. Create Processing/AudioPipelineCoordinator.swift and AudioPipelineCoordinatorTests.swift; extend DownloadModelTests.swift and AudioInputPreparerTests.swift.

- [ ] Add cases for a complete pasted URL starting once, duplicate view callback, explicit second submission, invalid/incomplete URL, source-picker cancellation, local file selection, and account change while preparing.
- [ ] Handle paste/file-selection as explicit intake events. Manually typed URLs commit on keyboard Done or focus exit. No .onAppear or repeated task modifier should submit input. Clear accepted URL text and show the task immediately.
- [ ] Persist the operation before asynchronous work. For imports, acquire security-scoped access, make an immutable private copy while access is available, then release access. Validate existing byte/duration constraints and checksum before upload.
- [ ] Join local URL download completion to preparation, backend reservation, signed S3 upload, and confirmation automatically. Persist each handoff before starting the next operation. Carry the source title and respect any earlier user rename.
- [ ] Support two simultaneous local pipelines with queued additional submissions, each independently cancellable. Keep URL/source staging separate from processed-only library presentation; no original-media autoplay.
- [ ] Test interruptions after copy/download, after create, after S3 transfer, and before upload confirmation. Recover from existing requestId and file identity; never create duplicate jobs because a view was recreated.

**Acceptance:** valid URLs/imports reach processing without another user tap; one failed source does not interrupt other submissions.

## I03 — Background URLSession chaining and restoration

**Dependencies:** I02. **Produces:** supported download/upload restoration, phase notifications, and interruption recovery.

**Files:** modify Processing/{BackgroundTransferCoordinator.swift,ProcessingAppDelegate.swift,S3MultipartFile.swift,NotificationDelegate.swift,PushRegistrationCoordinator.swift}, State/DownloadModel.swift and existing source-download transport. Create Processing/AudioPipelineRestoration.swift and AudioPipelineRestorationTests.swift; extend UploadRecoveryTests.swift. Update ios/project.yml only if actual capability/source wiring requires it.

- [ ] Add restoration tests mapping stable background session/task identifiers to owner/operation, duplicate delegate delivery, missing staged files, account changes, and delayed callbacks after cancellation.
- [ ] Reuse background URLSession for supported file downloads and existing file-backed S3 uploads. Persist completed temporary downloads into private storage before returning from the delegate. Permit cellular/expensive/constrained networks without adding a Wi-Fi-only switch.
- [ ] Start the next eligible operation when the OS grants execution, persisting pending continuation first. If URL extraction/transcoding/local preparation cannot finish within allowed execution, save Awaiting app resume and resume on the next opportunity; do not fabricate background work with silent audio.
- [ ] Reconnect background sessions on app-delegate launch, finish restoration callbacks correctly, and prevent two coordinators from completing the same upload/reservation. Handle expired grants by acquiring new ones through the existing authenticated API.
- [ ] Keep progress updates silent. Use existing push support for completion/failure and safe detail navigation; app resume always refetches authenticated status. Notifications or a Ready event must not download output. Do not add Live Activities as an unrequested prerequisite.
- [ ] Test relaunch reconciliation with cancelled URLSession transfers after explicit force-quit. Document that the server job continues once queued, while unfinished local transfers may require reopening the app. Keep network/system deferrals distinct from processing failure.

**Acceptance:** OS-permitted background transfers resume coherently; job creation is idempotent; documentation makes no uninterrupted force-quit guarantee.

## I04 — SwiftUI task cards, timeline, timers, and visual design

**Dependencies:** I01/I02 and B02 fixtures. **Produces:** agreed native iOS UX.

**Files:** modify UI/{HomeView.swift,ProcessingRootView.swift,ProcessingHistoryView.swift,ProcessingDetailView.swift}, State/{ProcessingModel.swift,ProcessingHistoryModel.swift}, existing theme and English/Arabic localization resources. Create UI/AudioTaskCard.swift, UI/AudioStepTimeline.swift, and Processing/AudioTaskPresentation.swift; create AudioTaskPresentationTests.swift; extend ProcessingHistoryTests.swift and ios/VocalUITests/ProcessingUITests.swift.

- [ ] Add presentation tests covering all specified phases, pre-job Reference, full Job ID, legacy missing title/timing, interrupted processing, output-download failure while Ready, and merged local/cloud identity.
- [ ] Build intake, active cards, and processed-only library around current navigation. Keep existing originals stored without presenting them as processed results. Keep cancelled/failed work understandable and deletable as specified.
- [ ] Add detail timeline, copy actions, safe error guidance, separate total and actual processing time. Stop processing clocks at Ready and show artifact-fetch progress independently. Handle client/server clock skew and inaccessible legacy timing gracefully.
- [ ] Preserve display name across views/player/notifications. Use existing design tokens, rounded audio-oriented typography, decorative waveform motion and 150–250 ms text crossfades. Avoid animated text that obscures the actual current step.
- [ ] Honor accessibilityReduceMotion, Dynamic Type, VoiceOver, RTL and light/dark. Stop offscreen animations, announce only phase changes, and isolate timer updates so the entire list does not refresh each second.
- [ ] Add deterministic preview/UI fixtures for empty, multiple active jobs, every error state, renamed/ready items, large Arabic text and narrow layouts; visually inspect only on the authorized simulator during implementation.

**Acceptance:** current work is clear at a glance; no fabricated progress percentages; the library and player expose named processed media only.

## I05 — Cancel/retry correctness and diagnostic outbox

**Dependencies:** I02 and B03 contract. **Produces:** resilient operations with owner-scoped support reports.

**Files:** modify Processing/{ProcessingRepository.swift,ProcessingStore.swift,JobsAPIClient.swift}, State/ProcessingModel.swift and source-download cancellation code. Create Processing/ClientErrorOutbox.swift and ClientErrorOutboxTests.swift; extend JobActionsTests.swift, UploadRecoveryTests.swift, and AudioPipelineCoordinatorTests.swift.

- [ ] Add cancellation cases before copying/extraction, during transfer, uncertain reservation, queued/processing, and Ready race. Assert no late callback submits cancelled work or clears a newer operation's state.
- [ ] Persist cancel intent; keep Cancelling until local work and server acknowledgement settle. Reconcile unknown create state before considering a pre-job operation cancelled.
- [ ] Implement three persisted transient retries with exponential backoff/jitter and Retry-After support. Connectivity absence does not consume retries. Refresh expired grants; keep explicit failed-processing retries separate from resuming result retrieval.
- [ ] Present actionable safe errors without dumping platform exception strings. Keep completed processing Ready when local playback/download/share retrieval fails.
- [ ] Persist a bounded, sanitized, UID-scoped outbox using the B03 schema. Reuse eventId on report retries and include operationId/jobId when available. Flush only under the matching authenticated session.
- [ ] Test reporting while offline, restart, queue bound, API throttling/outage, account sign-out, and duplicate callbacks. Treat user cancellation/share-sheet dismissal/notification denial as normal outcomes.

**Acceptance:** errors reach backend when possible without blocking the media flow; retries cannot duplicate jobs; one operation's cancellation does not affect another.

## I06 — Rename, deletion, on-demand results, and native sharing

**Dependencies:** I01, B01/B04. **Produces:** complete processed audio library actions.

**Files:** modify State/ProcessingModel.swift, Processing/{JobArtifactRepository.swift,ArtifactDownloadTransport.swift,ProcessingStore.swift,ProcessingRepository.swift}, Playback/AudioPlayer.swift, UI/ProcessingDetailView.swift. Create UI/ProcessedAudioShareSheet.swift; extend JobArtifactTests.swift and create AudioLibraryActionsTests.swift.

- [ ] Test that Ready/history/push triggers no output transfer; Play/Download/Share each can start retrieval and share one in-flight verified cache result. Cover corrupt/partial bytes, storage exhaustion, expired URLs, cancellation, and account changes.
- [ ] Add native rename sheet with current title, shared validation, pre-job local override, and backend update after reservation. Use display name throughout player and export/share filename; preserve sourceTitle and actual .mp3 extension.
- [ ] Present UIActivityViewController or an equivalent existing native share bridge with a local processed audio URL. If absent, show download progress first and retain the pending user Share action; recheck session before presentation. Do not share a signed URL or original input.
- [ ] Use native Save to Files for explicit export, preserving existing behavior. Keep activity-sheet popover presentation valid on supported size classes and treat dismissal as a successful exit without a diagnostic error.
- [ ] Add terminal Delete confirmation, perform owner-scoped DELETE, then stop this item's playback and remove its private staged/result/share-copy files. Keep pending deletion recoverable when offline; cancel remains the action for active tasks.
- [ ] Reconcile deleted server jobs across refresh and protect against late artifact completion or share callbacks resurrecting a deleted item. Never infer deletion merely from a paginated-list omission; never remove imported source files or another app's copies.
- [ ] Run action/artifact tests and add exact-simulator picker/share/delete UI checks for implementation validation.

**Acceptance:** user can play/download/share/rename/delete processed media under its title, without automatic result fetching or cross-account/file deletion.

## I07 — Integration, simulator validation, and handoff

**Dependencies:** I01–I06 plus B05 contract integration. **Files:** extend ios/VocalUITests/ProcessingUITests.swift and existing fixtures; create docs/validation/ios-audio-experience.md at repository root during implementation; update shared tracker.

- [ ] Add fixture UI flows: paste and automatic start, imported file start, two submissions, full stage timeline, cancellation/retry, rename, Ready without downloading, tap-to-fetch/share, deletion, and offline error reporting recovery.
- [ ] Run xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts from ios. Format only intended source changes using the existing formatter; do not regenerate unrelated assets.
- [ ] Run xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" -derivedDataPath DerivedData-audio-experience -parallel-testing-enabled NO test CODE_SIGNING_ALLOWED=NO from ios. If the exact simulator is unavailable, record the blocker and run only checks not requiring another runtime.
- [ ] Build unsigned Release with xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Release -destination 'generic/platform=iOS' -derivedDataPath DerivedData-audio-experience-release build CODE_SIGNING_ALLOWED=NO. Use existing valid nonsecret configuration; do not publish or install on another device.
- [ ] Review English/Arabic large-text, light/dark, reduced-motion and VoiceOver behavior on the authorized simulator. Record native importer/share proof separately from fake API fixture proof.
- [ ] Run git diff --check and review intended changes. Document live S3/APNs and physical-device background behavior as unverified unless separately exercised with appropriate authorization. No simulator test proves force-quit execution that iOS does not allow.

**Completion evidence:** focused tests plus exact-simulator UI proof, formatter and unsigned build results, honest live-service/background limitations. None of these implementation validations were run during planning.
