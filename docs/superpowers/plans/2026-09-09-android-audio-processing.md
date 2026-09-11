# Android Audio Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Android demo separation with authenticated, recoverable voice-only jobs and on-demand MP3 results.

**Architecture:** Retain the existing single app module, constructor injection and StateFlow. Add a processing package for API, immutable staging, durable UID-scoped operations and WorkManager transfers; reuse auth, original downloading, Media3 and export.

**Tech Stack:** Kotlin, Compose Material 3, DataStore, WorkManager, HttpURLConnection, Firebase Auth/Messaging, Media3.

**Spec:** [Approved mobile design](../specs/2026-09-09-mobile-audio-processing.md)

## Global constraints
- Explicit Remove music; local imports and completed YouTube files; voice-only MP3 fetched on demand.
- Input bytes 1..29,999,999; duration finite, >0 and <600 seconds; padded base64 SHA-256.
- Preserve exact signed form fields, immutable input and UUIDv4 idempotency across retries.
- Owner-isolated cloud storage; retain existing local original history; no automatic retained-file deletion.
- Backend owns FIFO, state, cancellation acknowledgement and retry eligibility; no invented percentages/ETA.
- Never expose tokens, grants, keys or worker credentials; no user bearer on storage transfers.
- English/Arabic, RTL, accessibility and existing auth/processing-policy rules apply throughout.
- No commit, push, deploy, release or real-account creation without explicit authorization.
- Only authorized UI/device target: iPhone 17 Pro iOS 26.0, $IOS_SIMULATOR_UDID.
- Tests listed below are future execution instructions, not claims of completed validation.

## Execution method
For each task, add the named focused regression tests first, run the focused suite and observe the new behavior failing, implement the listed contract, then rerun until green and review the diff. Use injected network/token/file/clock boundaries; never point fixtures at production. Test snippets below anchor the proposed interfaces; fill out each named scenario with deterministic fixtures within that task. Leave unrelated existing edits intact. Do not commit automatically.


## File roots and test commands
Production paths below are relative to android/app/src/main/java/com/hatem/musicmute unless explicitly prefixed. Test paths are relative to android/app/src/test/java/com/hatem/musicmute. Manifest/resources/build files use their existing android/app locations.

From android, run a focused test with:
```sh
./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.processing.JobsApiClientTest'
```
Replace the class with the named test for that task. Use the same command before and after implementation.

## A01: Job contract and authenticated API

**Files:** Create processing/JobModels.kt, processing/JobsApiClient.kt. Modify auth/AuthApiClient.kt only to extract/reuse its bounded authenticated request mechanics without changing auth semantics. Test processing/JobsApiClientTest.kt.

**Interfaces:** Produces JobsApiClient and serializable Job, JobPage, InputDeclaration, UploadGrant, DownloadGrant, JobMutation, CreateReservation. Job IDs/cursors are strings; dates parsed consistently; unknown states stay read-only.

- [ ] Add focused tests: Add fixture tests for every user route/method/body, installation header on create/renew/confirm/retry, strict DTO decoding, absent optional dates, opaque cursor encoding, all ten states, unknown state, token refresh once, 403/404/409/429/503 and redirect rejection. Reuse current Firebase identity and installation ID rather than introducing another session.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Map the eight methods to the API document. Keep storage transport separate. Build exact empty JSON objects for action endpoints. Expose safe typed failure codes and Retry-After; never retry non-idempotent intent with a fresh ID automatically.

Contract/test anchor:
```kotlin
interface JobsApi {
    suspend fun create(requestId: String, input: InputDeclaration): CreateReservation
    suspend fun renewUpload(id: String): UploadGrant
    suspend fun confirmUpload(id: String): JobMutation
    suspend fun list(cursor: String? = null, status: String? = null): JobPage
    suspend fun detail(id: String): Job
    suspend fun cancel(id: String): JobMutation
    suspend fun retry(id: String, requestId: String): JobMutation
    suspend fun download(id: String, artifact: String): DownloadGrant
}
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## A02: Immutable audio preparation and imports

**Files:** Create processing/AudioInputPreparer.kt, processing/PreparedInput.kt. Modify ui/VocalApp.kt and ui/DownloadHistoryScreen.kt for picker/source handoff. Test processing/AudioInputPreparerTest.kt.

**Interfaces:** Consumes a ContentResolver URI or existing completed download file. Produces PreparedInput(operationId, ownerUid, file, declaration) with immutable owner-private bytes.

- [ ] Add focused tests: Assert 29,999,999 accepted/30,000,000 rejected; 599.999 accepted/600, NaN and zero rejected. Test unreadable URI, cancelled picker, no audio/video tracks, unknown duration, unsupported MIME/container, provider size lies, digest base64 and file mutation prevention.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Use ActivityResultContracts.OpenDocument with supported audio MIME types; bounded stream copy to no-backup UID staging. Inspect actual tracks/duration with platform media APIs and normalize the documented format pairs. Stop at size limit while copying; hash the final staged file off the main thread. Avoid FFmpeg/new codecs. Preserve original downloader bytes and validate WebM/Opus support explicitly.

Contract/test anchor:
```kotlin
fun validateInput(bytes: Long, durationSeconds: Double): Boolean =
    bytes in 1..29_999_999 &&
        durationSeconds.isFinite() && durationSeconds > 0 && durationSeconds < 600
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## A03: Durable reservation and upload recovery

**Files:** Create processing/ProcessingStore.kt, processing/ProcessingRepository.kt, processing/AudioUploadWorker.kt, processing/S3FormUploader.kt. Wire VocalApplication.kt. Test processing/UploadRecoveryTest.kt and processing/ProcessingStoreTest.kt.

**Interfaces:** Consumes PreparedInput and JobsApi. Produces ProcessingRepository.submit(prepared), resume(operationId), stopLocalTransfer(operationId) and an observable UID-scoped operation store. Unique WorkManager name includes UID and operationId.

- [ ] Add focused tests: Exercise lost create response, duplicate tap, corrupted persisted state, restart during POST, successful S3 upload with lost response, confirmation conflict, expired grant, low disk, offline retry exhaustion and account switch during every await. Assert one logical reservation and no old-owner callback mutation.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Persist intent/declaration/path before networking in DataStore-backed UID storage. Stream signed multipart fields/file with progress and fixed immutable bytes. Confirm before queue UI. On uncertain transfer call confirm before renewal/reupload; refresh on state conflict. WorkManager uses network constraints, bounded retries and cancellation fencing. Foreground notification/service configuration must follow the current target SDK's requirements checked during implementation; never promise completion after force-stop.

Contract/test anchor:
```kotlin
data class UploadIntent(
    val operationId: String,
    val ownerUid: String,
    val requestId: String,
    val input: InputDeclaration,
    val stagedRelativePath: String,
    val jobId: String? = null,
)
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## A04: Cloud history, detail and worker offline UX

**Files:** Create state/ProcessingViewModel.kt, ui/ProcessingHistoryScreen.kt, ui/ProcessingDetailScreen.kt. Modify ui/VocalApp.kt and processing/ProcessingRepository.kt. Test processing/JobRefreshTest.kt.

**Interfaces:** Consumes JobsApi.list/detail and ProcessingStore; produces one owner-scoped StateFlow of paginated jobs and selected detail.

- [ ] Add focused tests: Test cursor pagination/dedup, refresh invalidating older pages, stale detail callback, offline cached state, every status label, unknown state, hidden-screen loop cancellation and workerAvailable=false without failed conversion.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Keep original History accessible and add a distinct Processing destination. Poll active visible work at 10-second intervals with backoff to 60 seconds; refresh on resume/manual action. Label queued/waiting worker and interrupted recovery accurately. Use determinate bars only for byte transfers; do not invent FIFO position or separation percentage.

Contract/test anchor:
```kotlin
fun shouldPoll(status: String): Boolean = status in setOf(
    "awaiting_upload", "queued", "validating", "processing",
    "uploading_result", "interrupted", "cancel_requested"
)
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## A05: Cancellation, retry and account fencing

**Files:** Modify processing/ProcessingRepository.kt, state/ProcessingViewModel.kt, auth/AuthSessionCoordinator.kt and ui/ProcessingDetailScreen.kt. Test processing/JobActionsTest.kt and processing/AccountIsolationTest.kt.

**Interfaces:** Consumes persisted operation/request IDs and server JobMutation; produces cancel(jobId) and retry(jobId), with retry UUID persisted before network transmission.

- [ ] Add focused tests: Test cancellation during creation/upload/confirmation, lost cancel response, completion race, cancellation pending while Z440 offline, retry response loss, NEW_INPUT_REQUIRED, duplicate retry taps, logout during completion and switching back to the original UID.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Fence/stop local upload before resolving/cancelling its server reservation. Refetch uncertain state; keep cancel_requested until acknowledged. Failed retry creates a new server job; interrupted waits for recovery. On UID/session change stop old client work, clear visible cloud state, hide cached output and ignore late responses. Keep server jobs and retained files. Wire policy denial/reauth UX through existing auth state.

Contract/test anchor:
```kotlin
fun mayOfferRetry(status: String): Boolean = status == "failed"
fun cancellationPending(status: String): Boolean = status == "cancel_requested"
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## A06: On-demand MP3 playback and export

**Files:** Create processing/JobArtifactRepository.kt, processing/ArtifactDownloadWorker.kt. Modify playback/AudioPlaybackController.kt, ui/ProcessingDetailScreen.kt and reuse download/AudioExport.kt. Test processing/JobArtifactRepositoryTest.kt.

**Interfaces:** Consumes JobsApi.download(id, output). Produces ensureOutput(jobId): File with coalesced owner/job download and validated atomic cache promotion.

- [ ] Add focused tests: Test no auto-download at ready, repeated Play coalescing, interrupted partial, expired grant, HTML/empty/non-MP3 body, corrupt cache, account switch, export picker cancellation and byte-preserving export.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Download to owned partial file with byte progress and no API bearer. Validate playable MP3 before rename; use Media3 for playback and the system document picker for export. Preserve original files and output caches. Stream renew/retry with a bounded budget and never overwrite a valid cache with late partial callbacks.

Contract/test anchor:
```kotlin
fun outputCacheKey(uid: String, jobId: String): String =
    java.security.MessageDigest.getInstance("SHA-256")
        .digest("$uid:$jobId".toByteArray()).joinToString("") { "%02x".format(it) }
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## A07: Push registration and safe notification routing

**Files:** Create processing/PushRegistrationCoordinator.kt, processing/ProcessingMessagingService.kt. Modify VocalApplication.kt, auth/AuthSessionCoordinator.kt, AndroidManifest.xml and app/build.gradle.kts. Test processing/PushRegistrationTest.kt.

**Interfaces:** Consumes Firebase Messaging token, current UID/installation after device sync, and type/jobId/eventId/outcome payload. Produces registration/deactivation retries and authenticated navigation hints.

- [ ] Add focused tests: Test token refresh before/after bootstrap, rotation, denied permission, offline sign-out, account switch, old-event replay, invalid job ID, 404 owner check, duplicate event and push arriving during login.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Add only Firebase Messaging from the existing Firebase dependency alignment. Register after device sync, deactivate best-effort while old credentials exist, and never block logout. Fetch authoritative job before in-app routing; dedup hints. Implement notification channel/permission and explicit immutable PendingIntent. Coordinate visible/system notification behavior with MOB-B01 to avoid double alerts. Notifications remain optional.

Contract/test anchor:
```kotlin
fun isJobHint(data: Map<String, String>): Boolean =
    data["type"] == "audio_job_outcome" &&
        data["jobId"]?.matches(Regex("[0-9a-fA-F]{24}")) == true &&
        !data["eventId"].isNullOrBlank()
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## A08: Localized integration and validation

**Files:** Modify ui/VocalApp.kt, ui/DownloadHistoryScreen.kt, ui/Previews.kt, ui/DownloadPreviews.kt, res/values/strings.xml, res/values-ar/strings.xml and android/README.md. Create processing/ProcessingFlowTest.kt and docs/validation/mobile-processing-android.md at repository root.

**Interfaces:** Consumes A01–A07; produces full explicit source → prepare → upload → cloud job → on-demand result flow and a validation record with separate proof levels.

- [ ] Add focused tests: Implement the integration test with fake storage/job state transitions for both source types; test every error branch, RTL, large text semantics, accessibility labels, unavailable backend and optional notifications. Replace demo production entry points only once the actual flow is wired.
- [ ] Run the named focused test classes and record the expected new failure.
- [ ] Implement: Run ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug from android with configured JDK/SDK; run git diff --check. Record actual outcomes. Do not run adb or an Android emulator under the current target restriction. Android runtime UI/real notification proof remains explicitly unverified pending user authorization of an Android target.

Contract/test anchor:
```kotlin
@Test fun inputLimitsMatchBackend() {
    assertTrue(validateInput(29_999_999, 599.999))
    assertFalse(validateInput(30_000_000, 599.999))
    assertFalse(validateInput(1, 600.0))
}
```

- [ ] Run the focused suite, fix regressions and review only this task's changes.

## Dependencies and exit gate
A01 → A03; A02 → A03; A03 → A04 → A05 → A06. A07 requires A01/A04/A05 plus MOB-B01 for visible alert parity. A08 closes the whole flow. Review all spec sections, source privacy and auth regressions before marking a task complete. No real Z440/S3/FCM claim follows from mocks or APK assembly.
