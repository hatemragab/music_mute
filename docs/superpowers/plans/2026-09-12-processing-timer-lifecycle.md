# Processing timer lifecycle repair

Date: 2026-09-12

Status: investigated and planned; implementation has not started.

## Goal

Timers must represent work that actually started. Waiting for consent, an app update, account access, connectivity, a local slot, retry backoff, or remote processing must not appear as ongoing processing. Pausing, reopening, restoring, and retrying must not silently add idle time. A cloud job may continue independently of a blocked or backgrounded client; its authoritative processing measurement remains valid.

## Evidence from the current checkout

This is a native Kotlin/Compose Android app, native Swift/SwiftUI iOS app, and NestJS backend. Flutter commands do not apply.

1. Android `android/app/src/main/java/com/hatem/musicmute/processing/ProcessingRepository.kt:217` stops upload runs for an update, then stores `WAITING` plus `APP_UPDATE_REQUIRED`. `AudioPipelineCoordinator.kt:206` similarly stops URL source work and stores `SOURCE_QUEUED` with that problem. Neither transition records a stopped clock. Import cancellation also needs coverage because the source-pause loop specifically targets URL operations.
2. Android `AudioTaskPresentation.kt:62` classifies waiting, queued, interrupted, and cancelling as active. At lines 80–82 it derives local elapsed time from `now - clientStartedAtMillis`. `ui/AudioTaskCard.kt:36` increments this value while `active`. Consequently an update-blocked waiting operation still ticks.
3. Android `ProcessingStore.kt` persists the original client start but has no dedicated accumulated active-work clock or local completion timestamp. Making the ticker stop alone would still allow a jump after recomposition, reload, or resume. Existing terminal-local tests deliberately return no elapsed value when no end timestamp exists.
4. iOS `ios/Vocal/Processing/AudioTaskPresentation.swift:251` uses an exclusion list for `isActive`; review and awaiting-app-resume are included. `UI/AudioTaskCard.swift:124` calculates `date - createdAt` for any active local task. This counts consent and recovery waiting and restores paused time on resume. `AudioPipelineCoordinator.swift` persists completion timestamps but retry clears them and retains the original start. This establishes a related clock defect, not a device reproduction of Android's update flow on iOS.
5. Both platforms expose separate total and processing measurements. Backend `backend/src/jobs/job-timing.ts` intentionally defines total as wall-clock time from `clientStartedAt` to `finishedAt` or now. Actual processing sums separation intervals and caps expired leases at the last observation. Mobile cards display total time; actual processing is separately available in detail. Changing only a label or subtracting a different initial timestamp cannot repair lifecycle accounting.
6. Existing regression tests cover terminal elapsed stability and backend processing intervals. They do not cover the full blocked/review/restart/resume timer matrix.

Existing uncommitted Android update-installer, update-gate, manifest, build, and README changes are present, alongside a separate app-update integration plan. Preserve them. Re-read their final state before implementation; do not replace or revert them.

## Timing contract

Keep three meanings distinct:

| Measurement      | Meaning                                                                        | Display rule                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processing time  | Backend-measured audio separation intervals                                    | Unavailable until measured; use server values, including approximation flags. Never derive from task creation.                                       |
| Active task time | Time spent executing local intake/upload work and confirmed server work stages | Start at actual execution; accumulate intervals; freeze during idle or blocked states. This replaces the misleading continuously growing card timer. |
| Total elapsed    | Existing backend wall-clock lifecycle age, including waiting                   | Preserve API meaning. If retained in detail, explicitly label it as including waiting and keep it separate from active task time.                    |

Audio/media duration remains independent of all three.

Recommended state rules:

| State                                                                                       | Active task clock                                                                            | Processing clock                                                                    |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Not started, consent/review, local slot queue                                               | Not started, or frozen if earlier work exists                                                | Unavailable unless a prior measured server interval exists                          |
| Source download, input preparation, reservation request, input upload, confirmation request | Runs only while the executor owns and is performing that stage                               | Unchanged                                                                           |
| Update/account/access block, offline wait, retry delay, awaiting app resume                 | Frozen                                                                                       | Preserve measured server work; never fabricate client processing                    |
| Server queue, interrupted/processing unavailable                                            | Frozen                                                                                       | Preserve accumulated processing; no speculative increment                           |
| Confirmed server validation, processing, result upload                                      | Use authoritative measured stage intervals; never count the same local/server interval twice | Changes only for actual separation                                                  |
| Cancellation requested                                                                      | Stop client-owned work timing when that work stops; keep cancellation pending                | Server may finish stopping; use its authoritative measurement until acknowledgement |
| Ready, failed, cancelled                                                                    | Frozen permanently for that attempt                                                          | Frozen server measurement                                                           |
| Unknown/stale state or missing timestamps                                                   | Freeze last known measurement or show unavailable                                            | Freeze last server sample; do not infer activity from an old status                 |

The backend currently provides processing intervals, not a complete active-task interval aggregate for every server stage. Do not pretend stage start timestamps alone prove uninterrupted activity. Initially, use measured local intervals plus backend processing intervals, with clear labeling (for example, “Measured work time”) and leave unavailable server overhead uncounted. If a full all-stage active duration is required later, add explicit server accounting in a separate contract change. Avoid a broad backend timing redesign for this bug.

## Implementation tasks

### 1. Encode the contract with failing regression tests

Extend:

- `android/app/src/test/java/com/hatem/musicmute/processing/AudioTaskPresentationTest.kt`
- `android/app/src/test/java/com/hatem/musicmute/processing/ProcessingStoreTest.kt`
- `android/app/src/test/java/com/hatem/musicmute/processing/AudioPipelineCoordinatorTest.kt`
- `android/app/src/test/java/com/hatem/musicmute/updates/ProcessingUpdateGateTest.kt`
- `ios/VocalTests/AudioTaskPresentationTests.swift`
- `ios/VocalTests/ProcessingStoreTests.swift`
- `ios/VocalTests/AudioPipelineCoordinatorTests.swift`
- `ios/VocalTests/AudioPipelineRestorationTests.swift`

Use injected clocks, advancing time without sleeps. Demonstrate the current bug with Android `SOURCE_QUEUED + APP_UPDATE_REQUIRED` and iOS review/awaiting-app-resume. Assert values at two distant times, not only status flags. Test initial admission rejection creates no running clock, including policy rejection after intake begins. Include source imports, not only URLs.

### 2. Persist local timing at execution boundaries

Modify Android `processing/ProcessingStore.kt`, `ProcessingRepository.kt`, `AudioPipelineCoordinator.kt`, and actual source/upload executor transition sites in `download/AudioDownloadWorker.kt` and `processing/AudioUploadWorker.kt`.

Modify iOS `Processing/ProcessingStore.swift`, the existing pipeline model declaration, `Processing/AudioPipelineCoordinator.swift`, and `Processing/ProcessingRepository.swift`.

First locate and reuse existing clock/session/run-token helpers. Add a small typed timing record containing measurement version, accumulated milliseconds, optional open-interval start/last observation, and optional stop/completion information. Separate run state and block reason from terminal state. Use monotonic time for in-process deltas and conservative persisted observations across process death; never reopen a persisted interval using all time since app exit.

Begin intervals when execution actually starts, not on URL paste, intent creation, or scheduling. Close once when execution yields to consent, update, access, offline, backoff, cancellation, failure, or completion. Store timing and lifecycle transition together; honor owner/session/run-token fences so late callbacks cannot restart or double-close an interval. Update-gate pause must cover active file preparation as well as source/download/upload work.

On resume, open a new interval only after execution resumes. Automatic retries retain measured prior work and exclude delay. A new server retry job uses its new attempt identity; do not combine unrelated attempt durations. Explicitly resumed local work may retain its accumulated work but cannot count the pause.

Decode old records with optional/default fields. For old paused or incomplete records, leave unmeasured work unavailable rather than converting wall-clock age into active time. Preserve IDs, source references, cancellation intent, consent, and existing recovery behavior.

### 3. Separate presentation activity from timing and actions

Modify Android `processing/AudioTaskPresentation.kt`, `ui/AudioTaskCard.kt`, and the existing detail timer renderer. Modify iOS `Processing/AudioTaskPresentation.swift`, `UI/AudioTaskCard.swift`, and `UI/ProcessingDetailView.swift`.

Introduce explicit timer state (not started/running/paused/finished/unavailable) and a sampled duration. Do not reuse `active`/`isActive` for ticking, animation, cancellation, and retry eligibility. Review and blocked jobs may remain cancellable while their timers are stopped.

Use the same timing projection for cards and detail. Include job ID as well as operation ID in Android ticker identity so server-only cards cannot share a null identity. Reset samples on new authoritative observations/attempts. Stop extrapolation when evidence is stale; prefer server processing samples over inventing an unbounded processing ticker. Wall-clock changes must not make local active time jump backward or forward.

Show a specific waiting reason such as “Update required”, “Waiting for confirmation”, or “Processing unavailable”. Do not render a waiting policy block as generic failure or animate it as ongoing processing. Preserve terminal server precedence when stale local failures or pause markers arrive later.

Update existing English/Arabic strings in Android resources and iOS localization files. Use “Processing time” only for separation; label the card's measured-work value truthfully. Explain any remaining wall-clock total in detail as including waiting.

### 4. Preserve and verify the backend timing contract

Extend `backend/src/jobs/job-timing.spec.ts` and `jobs.presenter.spec.ts` for not-started, queued, interrupted, terminal, and repeated observations. Verify update admission rejection does not start a job/interval using the existing `backend/test/admin-update-admission.integration.mjs` harness in its isolated test environment.

Review interval opening/closing at authoritative processing transitions before claiming backend correctness beyond the current unit tests. Keep `totalElapsedMs`, queue ordering, and `clientStartedAt` compatibility unchanged. No database migration or production operation is part of this repair. Modify backend runtime code only if a regression exposes an independent defect; document an additive API change if one proves necessary.

### 5. Validate lifecycle and recovery

Required scenarios: blocked before intake; block during URL download/import/upload; consent wait; local concurrency wait; offline/backoff; queue/processing interruption; pause for several minutes then resume; background/foreground; process restoration; signed-out owner change; cancellation race; server completes while client is update-blocked; terminal reopen; repeated identical snapshots; missing legacy timestamps; device wall-clock changes.

Concrete assertion: 10 seconds of measured local work + 5 minutes paused + 5 seconds resumed must display 15 seconds of local work, including after reopening. Processing time must remain unstarted until backend separation begins. A backend job actually processing while the app is blocked must retain its real server measurement.

Commands after implementation, run sequentially within each platform:

```sh
# backend/
npm test -- src/jobs/job-timing.spec.ts src/jobs/jobs.presenter.spec.ts
npm run typecheck
npm run lint
npm run build

# android/ — no device installation
./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest
./gradlew :app:lintDirectDebug :app:lintPlayDebug
./gradlew :app:assembleDirectDebug :app:assemblePlayDebug

# ios/ — format touched Swift files using xcrun swift-format, then:
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' -derivedDataPath DerivedData -parallel-testing-enabled NO test CODE_SIGNING_ALLOWED=NO
```

Use the existing format tooling only on changed files. Review the final diff for unrelated changes and generated output. The only authorized device/UI target is the existing iPhone 17 Pro, iOS 26.0 simulator above. If unavailable, report it; do not substitute a device. Android gets local unit/lint/build validation; Android device proof remains unavailable under this restriction.

## Investigation validation completed

- Ran `npm test -- src/jobs/job-timing.spec.ts src/jobs/jobs.presenter.spec.ts` in `backend/`: 2 files, 7 tests passed.
- Inspected source, persistence, timing UI, update-pause paths, existing tests, manifests/build configuration, and repository guidance.
- No mobile tests, device tests, or application builds were run during this study. The update symptom is source-confirmed, not device-reproduced.
- Only this plan was added. No implementation, commit, push, deployment, or data changes.
