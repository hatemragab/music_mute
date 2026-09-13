# Android implementation tasks

**Status: not started; plan approval required.** Read [scope](../scope.md) and [contracts](../contracts.md). Android is native Kotlin/Compose, not Flutter. Own Android source/tests/docs. No Android device/emulator run is authorized; JVM tests, lint, and builds must be labeled separately from decoder/picker/background proof.

## A01 — Policy-aware audio extraction and conversion

**Depends on:** B01, R01. **Consumes/produces:** C1 policy, C5 local preparation, existing `PreparedInput` and `InputDeclaration` plus profile/source metadata.

**Modify:** `android/app/src/main/java/com/hatem/musicmute/processing/{AudioInputPreparer.kt,AndroidAudioInspector.kt,JobsApiClient.kt}`, corresponding tests, and `android/README.md`.

**Create:** in that processing package, `ProcessingMediaPolicy.kt`, `MediaSourceInspector.kt`, `AudioPreparationEngine.kt`; under the matching test package, `ProcessingMediaPolicyTest.kt`, `MediaSourceInspectorTest.kt`, `AudioPreparationEngineTest.kt`.

**Dependency scope:** inspect Android platform extractor/muxer/codec support first. Reuse Media3 already present; if its Transformer module is necessary, add only the module matching the existing Media3 version in `android/gradle/libs.versions.toml` and `android/app/build.gradle.kts`, with compatibility/build evidence. Do not add a broad FFmpeg distribution or silently upgrade the whole dependency set.

- [ ] Write tests for v1/v2 policy parsing and hard boundaries, rejected unknown policy/profile, track selection default-not-first, unusable default plus usable alternate, copy-versus-convert decision, and incompatible/missing audio.
- [ ] Implement typed `ProcessingMediaPolicy` and injected inspection/export interfaces. Retain existing preparer locking, ownership, atomic completion, checksum, and replay behavior. Treat MIME/extension as hints, not proof.
- [ ] Inspect the source container/audio track without decoding the video frames. Use its default or only audible track; reject ambiguous/unsupported selections. Reject source duration above 1800 seconds before copying/exporting.
- [ ] Keep compatible size-compliant audio bytes unchanged. Remux selected video audio when compatible; convert when required by codec or prepared-size cap. Validate final audio-only tracks, duration, decodability, bytes, and hash before reservation. Prevent partial export reuse.
- [ ] Enforce R01 original-size/free-space/preparation bounds and cooperative cancellation. Providers with unknown source length require bounded streaming; do not load source media into memory.

**Test seed:** implement `ProcessingMediaPolicy.acceptsPrepared(bytes: Long, durationSeconds: Double)` and test:

```kotlin
assertTrue(policy.acceptsPrepared(100_000_000L, 1800.0))
assertFalse(policy.acceptsPrepared(100_000_001L, 1800.0))
assertFalse(policy.acceptsPrepared(10L, 1800.001))
```

Use a fully populated C1 fixture, and assert legacy policy still rejects 600 seconds. Adapter fakes prove routing; they do not prove native decoder compatibility.

**Validation (android cwd):** `./gradlew :app:testDirectDebugUnitTest --tests '*ProcessingMediaPolicyTest' --tests '*MediaSourceInspectorTest' --tests '*AudioPreparationEngineTest' --tests '*AudioInputPreparerTest'`; `./gradlew :app:lintDirectDebug :app:assembleDirectDebug`.

**Acceptance:** coherent native path with bounded streaming/cancellation and unit/static/build proof; actual Android format support remains unverified until authorized device testing.

## A02 — Files/photo selection, background preparation, and cleanup

**Depends on:** A01. **Consumes/produces:** C5 source inspection/preparation phases, current operation store/WorkManager lifecycle.

**Modify:** `android/app/src/main/java/com/hatem/musicmute/ui/{VocalApp.kt,home/HomeScreen.kt,importing/ImportReviewSheet.kt}`, `processing/{AudioPipelineCoordinator.kt,ProcessingRepository.kt,ProcessingStore.kt,AudioUploadWorker.kt,AudioTaskNotifications.kt}`, `android/app/src/main/AndroidManifest.xml`, and existing coordinator/store/upload recovery tests. Paths under `processing/` are relative to the same `com/hatem/musicmute` package.

**Create:** `processing/MediaPreparationWorker.kt`, `processing/PreparedMediaCleanup.kt`, and matching `MediaPreparationWorkerTest.kt`/`PreparedMediaCleanupTest.kt` in the existing test package.

- [ ] Test one-file picker dispatch, duplicate URI delivery, owner switch, cancellation before/during export, source grant loss, process death, and output upload receipt recovery.
- [ ] Add audio/video document selection and video photo-library selection using scoped system APIs. Preserve display names, existing consent, automatic processing, and per-operation identity. Request no broad library access when a system picker grant suffices.
- [ ] Persist URI permissions where available; determine when bounded private staging is essential. Inaccessible providers after restart must request reselection clearly. Never delete/modify the selected original.
- [ ] Schedule preparation as unique owner-scoped background work under current OS rules. Use foreground execution/notification when required and declare only actually used permissions/service types. Do not keep a foreground service alive while only waiting for remote processing.
- [ ] Persist preparation progress/restartability and bounded retry count; serialize duplicate resume/export attempts. Render inspecting/preparing/uploading separately, with cancellation at each step and no false percentage for unknown work.
- [ ] Delete only temporary prepared audio after server-confirmed upload; reconcile uncertain receipts first. Keep it for upload retry; clean abandoned partial files on cancellation/expiry with owner boundaries. Preserve saved source-library audio and server job identity.

**Required scenario:** interrupt after final export but before reservation, relaunch, reuse the complete verified prepared file once; interrupt after successful S3 PUT but before backend receipt, reconcile before deleting or re-uploading. Logout must prevent the next account from seeing/reusing previous prepared media.

**Validation:** `./gradlew :app:testDirectDebugUnitTest --tests '*MediaPreparationWorkerTest' --tests '*PreparedMediaCleanupTest' --tests '*AudioPipelineCoordinatorTest' --tests '*ProcessingStoreTest' --tests '*UploadRecoveryTest'`; `./gradlew :app:lintDirectDebug :app:lintPlayDebug :app:assembleDirectDebug :app:assemblePlayDebug`.

**Acceptance:** recovery/storage/dispatch logic proven locally; photo picker and OS background execution remain explicitly device-unverified under current authorization.

## A03 — YouTube preflight and bounded download

**Depends on:** A01, A02. **Consumes/produces:** C1/C5 metadata policy and prepared input; all sources use the same backend budget.

**Modify:** `android/app/src/main/java/com/hatem/musicmute/download/{YoutubeAudioDownloader.kt,AudioDownloadPolicy.kt,AudioDownloadWorker.kt}`, `ui/importing/{YoutubeLinkSheet.kt,YoutubeConfirmationSheet.kt}`, and `processing/AudioPipelineCoordinator.kt`.

**Create:** `download/YouTubePreflight.kt` and `android/app/src/test/java/com/hatem/musicmute/download/YouTubePreflightTest.kt`; extend `AudioDownloadPolicyTest.kt` and coordinator tests.

- [ ] Test individual video, explicit playlist/list context, live/upcoming stream, missing/NaN duration, 1800 seconds, real excess, unavailable metadata, and duplicate pasted URLs. Retain accepted URL parsing and consent/disclosure.
- [ ] Resolve bounded metadata before starting the audio download. Reject playlists explicitly; `--no-playlist` alone is insufficient. Reject unknown duration rather than downloading indefinitely to discover it.
- [ ] Fetch only compatible audio candidates. Keep no-video fallback; enforce download byte cap and deadline on actual bytes even when reported content length is absent/wrong. Bound extractor/fragment attempts across restarts, cancel promptly, and clean incomplete download files.
- [ ] Pass finished audio through A01 for measured duration/bytes/decodability before job creation. If it fails limits, no signed upload grant should exist.
- [ ] Preserve one operation identity through source resolution, local preparation, and server admission. A URL workflow cannot bypass audio-file quota or create multiple reservations on retries.

**Required tests:** a metadata fixture with `is_live=true` and duration 100 rejects before downloader invocation; declared 1200 seconds with measured 1900 seconds rejects before job creation; missing content length stops when streamed bytes cross the cap.

**Validation:** `./gradlew :app:testDirectDebugUnitTest --tests '*YouTubePreflightTest' --tests '*AudioDownloadPolicyTest' --tests '*AudioPipelineCoordinatorTest'`; full Android checks in A04. Network metadata fixtures establish logic, not current YouTube availability.

**Acceptance:** early rejection and hard transfer bounds; no unbounded download, original-video transfer, or source-specific allowance loophole.

## A04 — Allowance, queue estimates, and localized UX

**Depends on:** A02, A03, B02, B03, B06. **Consumes/produces:** C2 usage and C6 safe outcomes through current presentation/state architecture.

**Modify:** `processing/{JobsApiClient.kt,AudioTaskPresentation.kt,JobHistoryController.kt,AudioPipelineCoordinator.kt}`, `ui/{ProcessingLabels.kt,ProcessingDetailScreen.kt}`, relevant home/task-card UI, and `android/app/src/main/res/values/strings.xml` plus `values-ar/strings.xml`. Verify actual localized file organization before adding keys.

**Create:** `processing/ProcessingUsageRepository.kt` and matching tests; extend existing presentation/API/failure tests.

- [ ] Add contract fixtures for private usage, partially replenishing allowance, reserved versus spent time, active job, queue full, paused long jobs, stale/unavailable estimates, unknown settlement, and legacy server fallback.
- [ ] Read account availability before expensive preparation when online; explain that definitive admission follows preparation. Race a successful preflight with a full queue and show the authoritative server rejection without silent repeated upload attempts.
- [ ] Show remaining allowance and next replenishment time using server UTC; do not present a rolling allowance as a daily midnight reset. Refresh after create/cancel/terminal outcomes and account change.
- [ ] Show approximate waiting ranges only when evidence is fresh. Explain that fair queue order can change; never show a guaranteed position/finish time. Display preparation and actual processing separately from waiting.
- [ ] Add actionable English/Arabic text for each C6 media/YouTube/quota/capacity error; keep implementation details/raw diagnostics out of user UI. Preserve right-to-left layout, accessibility labels, compact cards, and on-demand output retrieval.

**Validation (android cwd):**

```sh
./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:lintDirectDebug :app:lintPlayDebug :app:assembleDirectDebug :app:assemblePlayDebug
```

Use the existing Kotlin formatting configuration if present; do not invent Flutter commands or add a formatter solely for this task.

**Acceptance:** backend-grounded quota/busy behavior and local validation evidence. Explicitly record that Android device UI, decoder, background, and production behavior were not tested.
