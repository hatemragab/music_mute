# Android Audio Experience Implementation Plan

Execution update (2026-09-10): A01–A07 implementation is complete locally.
The historical planning-only notices below are superseded for implementation;
commit, push, and deployment remain unauthorized. The user's later explicit
request authorized installing/running the app on the connected Android phone;
that smoke check passed on Xiaomi 23043RP34G, Android 14/API 34 (`$ANDROID_DEVICE_SERIAL`).
See the [execution record](../../tasks/automatic-audio-experience-execution.md).

> **For agentic workers:** Use superpowers:executing-plans when implementation is authorized. Steps use checkbox syntax for tracking. No implementation or commits in this planning task.

**Goal:** Turn one URL paste or local-file selection into a durable automatic processing task, with clear audio-focused UI and user-controlled results.

**Architecture:** Extend the existing Kotlin/Compose state, UID-scoped processing repository, WorkManager download/upload workers, and Media3 playback. A persistent pipeline coordinator joins existing download and processing operations; UI observation must never own the automatic handoff.

**Tech Stack:** Kotlin, Compose, StateFlow, WorkManager, existing downloader, DataStore/local storage, Media3, current HTTP/S3 clients.

**Spec:** [Agreed automatic audio experience](../specs/2026-09-10-automatic-audio-experience.md). Current backend behavior is documented in `backend/docs/api/audio-processing.md`.

## Global constraints

- Planning only; no application code, commit, push, deployment, live deletion, or infrastructure changes.
- Begin immediately on a complete pasted URL or file selection; no additional Start/Download/Submit button. Manually typed URLs commit on keyboard Done/focus exit.
- Individual submissions; multiple independent tasks; any available network; processed output only; result fetching only on Play/Download/Share.
- Preserve names; support rename, explicit deletion, acknowledged cancellation, bounded retry, copyable IDs, and separate total/processing timing.
- Existing input limits remain: nonempty, smaller than 30,000,000 bytes, shorter than 600 seconds.
- Reuse current architecture/dependencies; preserve English/Arabic, RTL, light/dark, reduced motion, and account fencing.
- Device/UI tests only on iPhone 17 Pro, iOS 26.0, UDID $IOS_SIMULATOR_UDID. Android runtime/UI execution is blocked until the user explicitly authorizes an Android target. Unit tests/lint/build can run.
- No existing original files are silently deleted during migration. Never delete imported source files or another app's copies.

## File roots and execution pattern

Production paths below are relative to android/app/src/main/java/com/hatem/musicmute/ unless an android/ prefix is shown. Unit test paths are relative to android/app/src/test/java/com/hatem/musicmute/. New files are explicitly marked Create. Recheck current source before execution; the parent checkout already contains unrelated changes.

For each task, first add its named failure cases, run the focused test to observe the missing behavior, implement the smallest complete change, and rerun the test. Example command from android: ./gradlew :app:testDebugUnitTest --tests 'com.hatem.musicmute.processing.AudioPipelineCoordinatorTest'. Replace the class with the test named in that task. Do not run any device/emulator command under the current authorization.

## A01 — Shared job metadata and operation persistence

**Dependencies:** B01 contract fixtures; B02–B04 fixture shapes before final integration. **Produces:** typed metadata/timing, stable local operation identity, and backward-compatible store migration for A02–A07.

**Files:** modify processing/{JobModels.kt,JobsApiClient.kt,ProcessingStore.kt,ProcessingRepository.kt}; extend processing/{JobsApiClientTest.kt,ProcessingStoreTest.kt,UploadRecoveryTest.kt}.

- [ ] Add tests decoding new and legacy job fixtures, unknown status, null timing, missing names, rename response, deleted detail, and returned requestId. Confirm old records migrate without being resubmitted or deleted.
- [ ] Extend typed contracts using the exact backend names. Keep API routes centralized. Add rename/delete/report calls only where specified by backend fixtures; preserve existing auth and error envelopes.
- [ ] Persist operation UUID before any extraction/copying, source kind, source title, user override name, pipeline stage, job ID, timestamps, retry intent, cancellation intent, and owner/session fence. Persist only necessary source information privately; never include signed URLs in diagnostics.
- [ ] Make writes atomic and versioned. Recover interrupted mutations through existing requestId/retry receipts. UI list merges local and remote identity without duplicate rows.
- [ ] Run focused contract/store/recovery tests. Document required backend version and test against fixtures; do not assume B01 endpoints are deployed.

**Acceptance:** app restarts neither lose a pending task nor create a second job; old history renders; names and timers survive model refreshes.

## A02 — Immediate URL/import pipeline with multiple submissions

**Dependencies:** A01. **Produces:** durable intake-to-queue flow and local phase stream consumed by A03/A04/A05.

**Files:** modify state/{DownloadsViewModel.kt,ProcessingViewModel.kt}, download/{DownloadRepository.kt,AudioDownloadWorker.kt,DownloadHistory.kt}, processing/{AudioInputPreparer.kt,ProcessingRepository.kt,AudioUploadWorker.kt}, ui/VocalApp.kt. Create processing/AudioPipelineCoordinator.kt and processing/AudioPipelineWorker.kt only for the bridging/resumption responsibilities, reusing existing extraction and upload implementations. Create processing/AudioPipelineCoordinatorTest.kt; extend processing/UploadRecoveryTest.kt.

- [ ] Add tests: one valid paste → one operation; duplicate Compose callback → no extra job; explicit second paste → new operation; invalid/incomplete URL → no network work; file selection → immediate preparation; empty/cancelled picker → no job.
- [ ] Add independent two-job tests with overlapping download/upload and cancellation. Cap simultaneous local pipelines at two, persist further accepted submissions, and distinguish local waiting from the server processing queue.
- [ ] Persist accepted intent synchronously before enqueueing uniquely named work per owner/operation. Copy selected URI bytes into private staging while the grant is valid; persist read permission only if supported and needed. Validate limits/checksum with existing preparer.
- [ ] On URL download completion, persist the original title and automatically invoke preparation/reservation/upload/confirmation from durable work. Do not rely on a visible screen or a Flow collector to submit. Keep the existing source downloader and supported URL scope.
- [ ] Carry user name overrides through metadata extraction. Clear the accepted input without re-triggering submission, and immediately display the task card. Use task-local failures so one bad URL does not block another job.
- [ ] Test process death after source download, ambiguous create response, after S3 success, and before upload-complete acknowledgement. Reconcile and continue the same requestId. Test account change at every handoff.

**Acceptance:** no second user action is needed to queue valid input; multiple submissions remain independent; background handoff produces at most one backend job per intent.

## A03 — Foreground transfers and silent progress notifications

**Dependencies:** A02. **Produces:** OS-managed transfer lifecycle, notification actions, and recovery signals.

**Files:** modify download/AudioDownloadWorker.kt, processing/{AudioUploadWorker.kt,ProcessingMessagingService.kt}, android/app/src/main/AndroidManifest.xml, existing notification/resource definitions. Create processing/AudioTaskNotifications.kt and processing/AudioTaskNotificationActions.kt; create processing/AudioTaskNotificationsTest.kt. Inspect existing WorkManager foreground-service manifest merge before adding a service.

- [ ] Add unit tests for title/stage/percentage projection, stable notification IDs, two-job grouping, deep-link owner checks, silent progress channel, cancellation actions, and ready/error transitions.
- [ ] Reuse WorkManager foreground execution for actual extraction/download/upload where supported, with the correct dataSync declaration and permission. Avoid introducing an independent service that repeats the same transfer work.
- [ ] Show per-job ongoing progress with display name and measured bytes; group multiple jobs. Throttle updates and suppress sound/vibration on progress. Stop the transfer foreground service after upload handoff; do not keep it running throughout remote queue/processing time.
- [ ] Route notification taps to authenticated job detail or local-operation detail; cancellation targets that operation only. Reconcile remote state on push/tap/resume using existing push and refresh infrastructure. Display stale/offline state honestly when background status cannot refresh.
- [ ] Handle denied notification permission, service timeout, network loss/switching, OS stop, process death, and relaunch with persistent recovery. Use connected-network constraints, never unmetered-only constraints. Notification dismissal does not cancel a task.
- [ ] Document Android 14 ongoing-notification dismissal and foreground-service timeout limits from the spec. Never fake playback/call styles or recreate dismissed notifications in a loop. Add runtime cases to the future validation checklist without running an unauthorized device.

**Acceptance:** real local transfers have visible silent progress when notifications are allowed; one job's notification cannot cancel another; work recovers without unlimited background execution claims.

## A04 — Unified cards, detail timeline, timers, and music visual style

**Dependencies:** A01/A02 and B02 timing fixtures. **Produces:** the agreed shared UX in Compose.

**Files:** modify ui/{VocalApp.kt,ProcessingHistoryScreen.kt,ProcessingDetailScreen.kt,ProcessingLabels.kt,Theme.kt,Previews.kt}, state/ProcessingViewModel.kt, processing/JobHistoryController.kt, existing android/app/src/main/res/values*/strings.xml. Create ui/AudioTaskCard.kt, ui/AudioStepTimeline.kt, and processing/AudioTaskPresentation.kt; create processing/AudioTaskPresentationTest.kt and extend processing/JobHistoryControllerTest.kt.

- [ ] Add pure presentation tests for every state in the spec, active versus output-fetch phases, null/approximate timings, processing unavailable, missing names, and local/cloud row merging.
- [ ] Replace the separate manual download-then-remove-music journey with URL/import intake, active tasks, and a processed-only library. Preserve legacy originals privately; do not expose original playback through the new result flow.
- [ ] Build compact cards with preserved name, actual stage, elapsed time, and measured transfer progress. Tap opens timeline, separate total/processing duration, full copyable Job ID (or pre-job Reference), and safe error/retry details.
- [ ] Anchor running timers to persisted local/server clocks, stop at Ready, label approximations, and never infer timing from audio duration. A failed Play download leaves the job Ready with a separate artifact error.
- [ ] Evolve existing color/type tokens; add decorative waveform motion and 150–250 ms status crossfades. Stop offscreen/terminal motion; support reduced-motion/system animator settings, TalkBack, large text, RTL, and matching Arabic/English text.
- [ ] Ensure second-by-second timers do not rebuild the entire list or repeatedly announce through accessibility. Use stable item keys and scoped state observation.
- [ ] Run presentation/history tests; add previews for empty, multi-job, offline, failed, renamed, ready, narrow/large-text, light/dark and RTL states. Preview compilation is not Android visual/runtime proof.

**Acceptance:** every step is understandable without opening logs; no fake processing percent/ETA; only processed media is playable in the redesigned library.

## A05 — Cancellation, bounded retry, and diagnostic outbox

**Dependencies:** A02, B03 contract. **Produces:** robust recovery and safe failure reporting.

**Files:** modify processing/{ProcessingRepository.kt,AudioUploadWorker.kt,ProcessingStore.kt,JobsApiClient.kt}, download/AudioDownloadWorker.kt, state/ProcessingViewModel.kt. Create processing/{ClientErrorOutbox.kt,ClientErrorReportWorker.kt}; create processing/ClientErrorOutboxTest.kt; extend processing/UploadRecoveryTest.kt and AudioPipelineCoordinatorTest.kt.

- [ ] Test cancellation before extraction, during import/download/upload, with uncertain job reservation, while queued/processing, and racing Ready. Block all late callbacks from submitting or resurrecting a cancelled intent.
- [ ] Persist Cancelling until local work stops and the backend reaches terminal acknowledgement where applicable. Preserve the actual terminal outcome when completion wins the race.
- [ ] Implement three persisted transient retries after initial failure with backoff/jitter and Retry-After handling. Network unavailability waits without consuming retries. Refresh expired signed grants; never automatically retry invalid media indefinitely.
- [ ] Provide stage-specific safe messages and Retry actions. Retry result retrieval only for artifact errors; explicit terminal processing retry uses the existing new-job API and preserves display name/lineage.
- [ ] Enqueue allowlisted diagnostic events in a UID-scoped bounded outbox. Reuse eventId on report retry and link operationId/jobId. Redact before persistence. Do not report normal user cancellation, share dismissal, or notification denial as failures.
- [ ] Test offline reporting, app restart, rate limiting, maximum queue bound, account switch, and reporting-service outage. Reports must never block job progress or expose another account's data.

**Acceptance:** transient errors recover predictably, failures remain actionable, and support can find early failures using the displayed Reference.

## A06 — Rename, delete, on-demand playback/download/share

**Dependencies:** A01, B01/B04. **Produces:** complete processed-media lifecycle.

**Files:** modify state/ProcessingViewModel.kt, processing/{JobArtifactRepository.kt,ProcessingRepository.kt,ProcessingStore.kt}, download/AudioExport.kt, ui/ProcessingDetailScreen.kt and existing playback wiring; inspect existing FileProvider paths/manifest. Create processing/ProcessedAudioShare.kt; extend processing/JobArtifactRepositoryTest.kt and create processing/AudioLibraryActionsTest.kt.

- [ ] Test Ready/history/push causes zero artifact fetches; Play, Download, or Share starts one; simultaneous actions share one verified cache download. Cover expired URL, corrupt/partial audio, no space, logout, and retry.
- [ ] Rename locally before reservation and through PATCH after reservation. Preserve names in player and notification and use a safe displayName.mp3 on export/share; duplicate titles must not overwrite unrelated files.
- [ ] Share actual processed audio through ACTION_SEND with an app-scoped content URI, audio/mpeg MIME type, temporary read permission, and chooser. Never share private paths or signed URLs. Handle a dismissed chooser as a normal outcome, not a failed job.
- [ ] Add terminal-item Delete confirmation with clear scope. Active cards retain Cancel until acknowledged. Send DELETE, keep a recoverable pending state on network failure, then remove only this job's private files and stop its playback.
- [ ] Reconcile cloud deletion after refresh, including cached jobs not in the currently loaded first page; do not treat pagination absence alone as deletion. Fence concurrent result-download callbacks so they cannot repopulate deleted cache entries. Do not remove source URI bytes or exported copies.
- [ ] Test wrong-account callbacks, delete/rename races, offline delete retry, download finishing after delete, and missing local caches. Run focused artifact/actions tests.

**Acceptance:** processed audio can be played, downloaded, renamed, deleted, and shared under its name; no automatic result download occurs; deletion never touches unrelated/source media.

## A07 — Integrated verification and handoff

**Dependencies:** A01–A06 plus B05 for real contract integration. **Files:** extend existing unit tests; create docs/validation/android-audio-experience.md at the repository root during implementation; update the shared task tracker.

- [ ] Add deterministic end-to-end orchestration tests with fake downloader/API/storage for one URL, one import, two concurrent submissions, interruption/restart, cancellation, rename, deletion, share, and diagnostics. Keep fixture proof separate from live backend/S3 proof.
- [ ] From android, run ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug. Fix change-induced failures; review strings, merged foreground-service manifest, and cache/file-provider scope.
- [ ] Run git diff --check and review only the intended implementation diff. Record formatter availability rather than inventing a Gradle formatter task or introducing a dependency solely for this plan.
- [ ] Document unrun Android UI/device scenarios: locked/background downloads and handoff, notification permission/dismissal/timeout, force-stop/relaunch, real picker/share sheet, Arabic large text, and process-death recovery. No Android device is authorized currently.
- [ ] Record backend deployment status and actual validation evidence. User-reported success of the older flow does not validate new automatic behavior.

**Completion evidence:** passing local tests/lint/build and contract integration; Android runtime/device proof remains separately gated. No validation commands were run for these unimplemented tasks during planning.
