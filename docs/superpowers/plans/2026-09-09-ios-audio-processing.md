# iOS Audio Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace iOS demo separation with recoverable cloud voice-only jobs and user-triggered MP3 playback/export.

**Architecture:** Retain SwiftUI and existing auth/download/player ownership. Add actor-backed UID-scoped processing storage, an authenticated JobsAPI, observable UI state and a file-backed background URLSession transfer coordinator.

**Tech Stack:** Swift, SwiftUI, Foundation/URLSession, AVFoundation, CryptoKit, Firebase Auth/Messaging, XCTest.

**Spec:** [Approved mobile design](../specs/2026-09-09-mobile-audio-processing.md)

## Global constraints

- Explicit Remove music; local imports and completed YouTube files; voice-only MP3 fetched on demand.
- Input bytes 1..29,999,999; duration finite, >0 and <600 seconds; padded base64 SHA-256.
- Preserve exact signed form fields, immutable input and UUIDv4 idempotency across retries.
- Owner-isolated cloud storage; retain existing local original history; no automatic retained-file deletion.
- Backend owns FIFO, state, cancellation acknowledgement and retry eligibility; no invented percentages/ETA.
- Never expose tokens, grants, or keys; no user bearer on storage transfers.
- English/Arabic, RTL, accessibility and existing auth/processing-policy rules apply throughout.
- No commit, push, deploy, release or real-account creation without explicit authorization.
- Only authorized UI/device target: iPhone 17 Pro iOS 26.0, $IOS_SIMULATOR_UDID.
- Tests listed below are future execution instructions, not claims of completed validation.

## Execution method

For each task, add the named focused regression tests first, run the focused suite and observe the new behavior failing, implement the listed contract, then rerun until green and review the diff. Use injected network/token/file/clock boundaries; never point fixtures at production. Test snippets below anchor the proposed interfaces; fill out each named scenario with deterministic fixtures within that task. Leave unrelated existing edits intact. Do not commit automatically.

## File roots and focused validation

Production paths below are relative to ios/Vocal. VocalTests, VocalUITests and project.yml are relative to ios. No new minimum OS version is proposed; preserve iOS 17.

From ios, run each new test class before and after implementing its task:

```sh
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData-processing -parallel-testing-enabled NO \
  -only-testing:VocalTests/JobsAPIClientTests test CODE_SIGNING_ALLOWED=NO
```

Substitute the named test class. If the exact simulator is absent, record the blocker; do not substitute or create a simulator.

## I01: Codable job contract and authenticated API

**Files:** Create Processing/JobModels.swift, Processing/JobsAPIClient.swift and VocalTests/JobsAPIClientTests.swift. Reuse/extract Auth/AuthAPIClient.swift request mechanics without changing existing account endpoints.

**Interfaces:** Produces Codable Job, JobPage, InputDeclaration, UploadGrant, DownloadGrant, CreateReservation and JobMutation; raw statuses preserve unknown values.

- [ ] Add focused tests: Use URLProtocol fixtures to assert all route methods/body shapes, UUID lowercase encoding, required installation headers, pagination escaping, optional date decoding, all ten/unknown states, refresh-once 401, safe 403/404/409/429/503 and redirect rejection.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Reuse IDTokenSource/current installation and validated origin. Keep JSON API session separate from file transfer sessions. Follow exact safe API projection; no output checksum, queue position or separation progress fields may be fabricated.

Contract/test anchor:

```swift
@MainActor protocol JobsAPI {
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation
  func renewUpload(id: String) async throws -> UploadGrant
  func confirmUpload(id: String) async throws -> JobMutation
  func list(cursor: String?, status: String?) async throws -> JobPage
  func detail(id: String) async throws -> Job
  func cancel(id: String) async throws -> JobMutation
  func retry(id: String, requestId: UUID) async throws -> JobMutation
  func download(id: String, artifact: String) async throws -> DownloadGrant
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## I02: File import and immutable preparation

**Files:** Create Processing/AudioInputPreparer.swift, Processing/PreparedInput.swift and VocalTests/AudioInputPreparerTests.swift. Modify UI/HomeView.swift and UI/HistoryView.swift for source handoff; reuse Data/AudioFiles.swift.

**Interfaces:** Produces PreparedInput with operationId/ownerUid/fileURL/declaration from an imported security-scoped URL or a completed original download.

- [ ] Add focused tests: Test exact byte/duration boundaries, unknown duration, security-scoped access failure, cancelled picker, unreadable cloud file, low storage, nonaudio/video tracks, misleading extension, base64 digest and immutable copy. Include fragmented M4A duration regression.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Use SwiftUI fileImporter/system document picker with audio UTTypes, security-scoped access and coordinated bounded file copy into no-backup UID staging. Inspect actual media using existing AVFoundation conventions; stream CryptoKit SHA256 over final bytes and base64-encode the digest. Accept only supported, inspectable audio pairs; show a clear unsupported-format error instead of transcoding.

Contract/test anchor:

```swift
func validProcessingInput(bytes: Int64, duration: Double) -> Bool {
  (1...29_999_999).contains(bytes) && duration.isFinite && duration > 0 && duration < 600
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## I03: Persistent upload operation and background transport

**Files:** Create Processing/ProcessingStore.swift, Processing/ProcessingRepository.swift, Processing/BackgroundTransferCoordinator.swift and Processing/S3MultipartFile.swift. Modify VocalApp.swift. Create VocalTests/UploadRecoveryTests.swift and VocalTests/ProcessingStoreTests.swift.

**Interfaces:** ProcessingStore actor persists versioned owner-specific operations atomically. ProcessingRepository exposes submit(prepared:), resume(operationId:) and stopLocalTransfer(operationId:). Coordinator maps OS task identifiers to durable owner/operation records.

- [ ] Add focused tests: Test lost create/S3/confirm response, restart at each persistence boundary, expiry, duplicate tap, same requestId/body after recovery, truncated multipart spool, no bearer/cookies on S3, account switch and background callback for an old operation.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Persist UploadIntent before POST. Build a file-backed multipart body with every grant field verbatim and file part last; guard available disk because the spool duplicates input bytes. Use URLSession background uploadTask(fromFile:) for S3 bytes with a stable session ID and restored delegates. Keep short authenticated API calls on foreground/available background execution; if confirm cannot run, persist needs-confirmation for next foreground. On uncertainty attempt confirmation/refetch before whole-file retry. There is no signed POST range resume. Implement bounded renew/retry and atomic state transitions; user force-quit can defer recovery until reopen. Wire UIApplicationDelegateAdaptor background-session completion handling and drain each completion handler once.

Contract/test anchor:

```swift
struct UploadIntent: Codable {
  let operationId: UUID
  let ownerUid: String
  let requestId: UUID
  let input: InputDeclaration
  let stagedRelativePath: String
  var jobId: String?
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## I04: Cloud history and live detail state

**Files:** Create State/ProcessingModel.swift, UI/ProcessingHistoryView.swift, UI/ProcessingDetailView.swift and VocalTests/ProcessingRefreshTests.swift. Modify VocalApp.swift navigation/lifecycle.

**Interfaces:** Consumes JobsAPI and ProcessingStore; produces @MainActor observable owner-scoped jobs/detail plus local transfer progress. One refresh task per visible screen.

- [ ] Add focused tests: Test opaque paging, duplicate IDs, refresh discarding stale page responses, all state labels, out-of-order detail requests, retained offline list, workerUnavailable without failure, background task cancellation and unknown-status read-only rendering.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Add Processing alongside original download History. Refresh every 10 seconds while active work is visible, back off transient failures to 60 seconds and refresh on scene activation/manual action. Do not run indefinite background polling. Display accurate indeterminate stages and processing availability only from detail. Persist safe metadata, never temporary signed grants.

Contract/test anchor:

```swift
func shouldPollJob(_ status: String) -> Bool {
  ["awaiting_upload", "queued", "validating", "processing",
   "uploading_result", "interrupted", "cancel_requested"].contains(status)
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## I05: Cancellation, retry and session isolation

**Files:** Modify Processing/ProcessingRepository.swift, State/ProcessingModel.swift, Auth/AuthSessionModel.swift and UI/ProcessingDetailView.swift. Create VocalTests/JobActionsTests.swift and VocalTests/ProcessingIsolationTests.swift.

**Interfaces:** Consumes stable upload/retry intents and API mutations. Produces cancel(jobId:), retry(jobId:) and session-epoch fencing for model, file transfer and player callbacks.

- [ ] Add focused tests: Test cancellation during create/upload/confirm, failed network cancel, ready race, processing-unavailable cancellation, retry response loss, invalid-input retry, double tap and late upload/result completion after UID change.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Stop/fence local work and resolve an uncertain reservation before server cancel. Render cancel_requested until the API changes it. Persist a fresh retry requestId before sending; keep the old failed job and link the new job. Handle NEW_INPUT_REQUIRED through picker flow and keep interrupted state server-authoritative. Session switch clears visible cloud state and stops old playback/transfers without cancelling server jobs or deleting retained files.

Contract/test anchor:

```swift
struct SessionFence: Equatable {
  let uid: String
  let epoch: UInt64
}
func acceptsCallback(captured: SessionFence, current: SessionFence?) -> Bool {
  current == captured
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## I06: On-demand result cache, native player and export

**Files:** Create Processing/JobArtifactRepository.swift and VocalTests/JobArtifactTests.swift. Modify UI/ProcessingDetailView.swift; reuse Playback/AudioPlayer.swift and Data/AudioFiles.swift export helpers.

**Interfaces:** Consumes output download grant for ready jobs; produces ensureOutput(jobId:) async throws -> URL, coalesced per UID/job and atomically cached.

- [ ] Add focused tests: Test ready does not fetch bytes, each explicit action fetches once, concurrent taps coalesce, expired grant renews within budget, invalid/empty/non-MP3 content, disk failure, interrupted partial, wrong-owner completion and export cancellation preserving cache.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Use file-based download through the transfer coordinator, verify playable MP3 before atomic promotion, and expose real byte progress. Reuse AVAudioPlayer/Now Playing for ready output, with original and voice labels. Save to Files exports unchanged MP3 bytes. Do not persist grants, auto-download completed jobs, auto-delete cache or treat missing HTTP Content-Length as corruption.

Contract/test anchor:

```swift
enum ArtifactIntent {
  case play
  case download
  case export
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## I07: FCM/APNs token lifecycle and notification navigation

**Files:** Create Processing/PushRegistrationCoordinator.swift, Processing/NotificationDelegate.swift and VocalTests/PushRegistrationTests.swift. Modify VocalApp.swift, Auth/AuthSessionModel.swift, project.yml, Vocal.entitlements and Info.plist only for required messaging setup.

**Interfaces:** Consumes current token, APNs registration callback, authenticated synced installation and existing data keys type/jobId/eventId/outcome. Produces authorized push binding and deferred job-detail navigation.

- [ ] Add focused tests: Test denied permission, APNs/FCM token order, pre-bootstrap token, rotation, logout offline, rapid account switching, malformed and duplicate hints, cold navigation before login and owner 404. Inject hints locally without claiming APNs transport proof.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Add FirebaseMessaging from the pinned Firebase package; integrate delegates through the app's single UIApplicationDelegateAdaptor. Explicitly define APNs token forwarding/delegate behavior and avoid duplicate swizzling/manual delivery. Ask notification permission contextually; application remains usable if denied. Device sync precedes backend token binding. Deactivate best-effort before sign-out; preserve privacy/session fencing. Visible background alerts require MOB-B01 and valid APNs provisioning; do not claim the current data-only backend is sufficient.

Contract/test anchor:

```swift
func isJobHint(_ data: [AnyHashable: Any]) -> Bool {
  guard data["type"] as? String == "audio_job_outcome",
    let job = data["jobId"] as? String,
    let event = data["eventId"] as? String, !event.isEmpty
  else { return false }
  return job.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## I08: Localized flow, simulator tests and validation

**Files:** Modify UI/HomeView.swift, UI/HistoryView.swift, UI/Previews.swift, Resources/en.lproj/Localizable.strings, Resources/ar.lproj/Localizable.strings, project.yml and ios/README.md. Create VocalUITests/ProcessingUITests.swift and repository docs/validation/mobile-processing-ios.md.

**Interfaces:** Consumes I01–I07. Produces both real source entry points with explicit Remove music, fully localized processing/result screens and an evidence report.

- [ ] Add focused tests: Build isolated injected job/storage fixtures for source → upload → queued/offline → processing → ready → Play/Save, cancellation, retry and relaunch recovery. Verify English/Arabic RTL, Dynamic Type, VoiceOver identifiers, denied notifications, account switch and original-download regression.
- [ ] Run named test classes and observe the expected new failure.
- [ ] Implement: Remove production demo navigation after real flow integration. Regenerate MusicMute.xcodeproj from project.yml if source/target wiring requires it; inspect only intended changes and do not edit unrelated generated assets. Run swift-format lint and the commands below. Record simulator injection separately from real Firebase/APNs/S3 proof.

Contract/test anchor:

```swift
func testInputLimits() {
  XCTAssertTrue(validProcessingInput(bytes: 29_999_999, duration: 599.999))
  XCTAssertFalse(validProcessingInput(bytes: 30_000_000, duration: 599.999))
  XCTAssertFalse(validProcessingInput(bytes: 1, duration: 600))
}
```

- [ ] Run focused tests, fix regressions and review this task's diff.

## Dependencies and final checks

I01/I02 → I03 → I04 → I05 → I06. I07 requires I01/I04/I05; visible alerts also require MOB-B01. I08 closes the flow.

Run from ios:

```sh
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData-processing -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath DerivedData-processing-release \
  build CODE_SIGNING_ALLOWED=NO
git diff --check
```

Supply existing validated API-origin build configuration for Release; do not write credentials/config secrets into the plan. Explicitly report skips/opt-in live tests. A generic unsigned build does not run another device. Do not claim real APNs reception, uninterrupted background execution or acoustic separation from fixture/simulator results.
