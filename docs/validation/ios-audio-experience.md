# iOS automatic audio experience validation

Date: 2026-09-10. Status: I01-I07 complete locally, with the live-service limitations below.

This report covers I01-I07 in the
[iOS plan](../superpowers/plans/2026-09-10-ios-audio-experience.md). Validation
used only the authorized iPhone 17 Pro, iOS 26.0 simulator
`$IOS_SIMULATOR_UDID`.

## Implementation coverage

| Requirement                       | Implemented behavior                                                                                                                                                                                                                                                       | Main source                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 contract and durable metadata | Backward-compatible job metadata/timing, request identity, rename/delete/client-error contracts, UTC millisecond encoding, owner-scoped v2 pipeline persistence, and attempt/cancel/retry state.                                                                           | `ios/Vocal/Processing/JobModels.swift`, `JobsAPIClient.swift`, `ProcessingStore.swift`, `ProcessingRepository.swift`, `UnavailableJobsAPI.swift`                                                                        |
| I02 automatic intake              | Paste, typed URL commit, and selected files create durable operations before work and automatically chain through download/copy, validation, reservation, upload, and confirmation. Event deduplication and a shared two-run cap keep simultaneous operations independent. | `ios/Vocal/Processing/AudioInputPreparer.swift`, `AudioPipelineCoordinator.swift`, `ios/Vocal/State/DownloadModel.swift`, `ProcessingModel.swift`, `ios/Vocal/UI/HomeView.swift`, `ProcessingRootView.swift`            |
| I03 background and restoration    | Background source download uses stable owner/operation/task identity, durable receipts, duplicate/late callback fencing, account-change cancellation, app-delegate restoration, and persisted continuation. Existing file-backed S3 upload restoration remains integrated. | `ios/Vocal/Processing/AudioPipelineRestoration.swift`, `BackgroundTransferCoordinator.swift`, `ProcessingAppDelegate.swift`, `S3MultipartFile.swift`, `NotificationDelegate.swift`, `PushRegistrationCoordinator.swift` |
| I04 task UX                       | Merged local/cloud cards, full timelines, reference/job IDs, total and processing clocks, output-fetch state, processed-only library behavior, rename-aware presentation, RTL/localization, Dynamic Type, reduced motion, and stable accessibility identifiers.            | `ios/Vocal/Processing/AudioTaskPresentation.swift`, `ios/Vocal/UI/AudioTaskCard.swift`, `AudioStepTimeline.swift`, `ProcessingHistoryView.swift`, `ProcessingDetailView.swift`                                          |
| I05 actions and diagnostics       | Cancellation waits for local shutdown and persists intent through acknowledgement. Retries persist delay/attempt state and fence stale runs. A bounded sanitized owner-scoped error outbox retains stable event IDs and flushes only for the matching session.             | `ios/Vocal/Processing/ClientErrorOutbox.swift`, `ProcessingRepository.swift`, `ProcessingStore.swift`, `ios/Vocal/State/ProcessingModel.swift`                                                                          |
| I06 processed media actions       | Ready does not fetch output. Play, native Share, and Save to Files share one verified cached result. Rename controls player/export naming. Confirmed terminal deletion stops playback and removes private artifacts with tombstone fencing.                                | `ios/Vocal/Processing/JobArtifactRepository.swift`, `ArtifactDownloadTransport.swift`, `ios/Vocal/Playback/AudioPlayer.swift`, `ios/Vocal/UI/ProcessedAudioShareSheet.swift`, `ProcessingDetailView.swift`              |
| I07 fixtures                      | Isolated DEBUG graph with synthetic MP3 data, deterministic jobs/transfers, request counters, pasteboard input, and UI flows for intake and media actions.                                                                                                                 | `ios/Vocal/UI/ProcessingUITestHarness.swift`, `ios/VocalUITests/ProcessingUITests.swift`                                                                                                                                |

English and Arabic localization each contain 257 unique keys, with no key
missing on either side.

## Automated validation

Focused unit evidence totals **44 passed tests** with zero failures:

| Suite                                           |    Result | Evidence                                        |
| ----------------------------------------------- | --------: | ----------------------------------------------- |
| `AudioPipelineCoordinatorTests`                 |  4 passed | `/tmp/musicmute-ios-focused-tests.log`          |
| `AudioPipelineRestorationTests`                 |  4 passed | `/tmp/musicmute-ios-focused-tests.log`          |
| `AudioTaskPresentationTests`                    | 10 passed | `/tmp/musicmute-ios-focused-tests.log`          |
| `ClientErrorOutboxTests`                        |  2 passed | `/tmp/musicmute-ios-focused-tests.log`          |
| `JobActionsTests`                               |  8 passed | `/tmp/musicmute-ios-job-actions-tests.log`      |
| `JobArtifactTests` and `ProcessingHistoryTests` | 16 passed | `/tmp/musicmute-ios-artifact-history-tests.log` |

Five distinct exact-simulator UI scenarios passed:

- Offline relaunch retained cached processing history.
- Cancellation remained pending correctly, and retry opened a new queued job.
- Arabic dark mode at Accessibility XL rendered interrupted and Ready details;
  Dynamic Type and text-clipping audits passed.
- A Ready result was renamed before any output request, native Share made one
  request, synthetic MP3 playback/seek worked, Save to Files reused the cache,
  and confirmed deletion removed the result.
- Two pasted URLs created independent jobs; selecting a synthetic MP3 through
  the native Files picker automatically created a third job. Its preserved title
  and local-file timeline were shown without URL source/download stages.

The first two passes are in
`/tmp/MusicMute-ProcessingUI-Remaining-20260910-1608.xcresult`. The Arabic and
Ready-action passes are in
`/tmp/MusicMute-ProcessingUI-Failed3-20260910-1611.xcresult`. Exported visuals
are under `/tmp/musicmute-ios-final-visuals`; inspection found no layout defect
in the passing English/light and Arabic/dark flows.

The complete importer scenario passed in 60.599 seconds, with zero failures or
skips, in `/tmp/MusicMute-ProcessingUI-Import-Complete.xcresult`; command output is
`/tmp/musicmute-ios-import-complete.log`. Its three screenshots are exported to
`/tmp/musicmute-ios-import-complete-visuals`. Visual inspection confirmed the
preserved `Fixture input` title and queued local-file job.

Earlier importer failures were test navigation defects: two installed apps have
the same MusicMute display name, folder captions were not reliable activation
targets, and the test assumed the history list would be visible after import.
The helper now verifies the expected child when choosing between same-named app
folders, taps the icon within the matched Files cell, and returns from detail
before checking the third job. Both installed apps and their data were preserved.
No Files provider indexing failure is inferred from the earlier results.

## Build and source checks

- Exact-simulator build and focused importer test passed after the final helper
  changes: `/tmp/musicmute-ios-import-complete.log`.
- Unsigned generic-iOS Release passed:
  `/tmp/musicmute-ios-release-build.log`, output under
  `ios/DerivedData-audio-experience-release`.
- `swift-format lint --recursive Vocal VocalTests VocalUITests scripts` exits 0
  with no diagnostics after formatting intended Swift files:
  `/tmp/musicmute-ios-swift-format-lint-complete.log`.
- `git diff --check -- ios` returned no error. Coverage is limited because the
  repository migration currently presents the iOS directory as untracked.
- No complete all-target `xcodebuild test` pass is claimed. The evidence is
  44 focused unit tests and five distinct UI scenarios passing in scoped runs;
  successful scenarios were not repeatedly rerun while fixing the importer test.

## Proof boundaries

Deterministic fixtures do not establish deployed rename/delete/report endpoints,
real S3 transfer, APNs delivery, real-account behavior,
or production compatibility.

Background restoration is unit- and simulator-covered. Physical-device
suspension and force-quit behavior were not exercised. iOS may cancel unfinished
local extraction, preparation, or transfer after explicit force-quit; reopening
permits reconciliation. A queued server job proceeds independently.

Native Share and Save-to-Files presentation were exercised with synthetic
processed MP3 bytes. Completed export outside the app container was not asserted.
No alternate device, account creation, live deletion, commit, push, publication,
deployment, or infrastructure change was performed.

I07 is complete for local implementation and scoped simulator verification.
