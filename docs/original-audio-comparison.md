# Original audio comparison and optional trimming

## Behavior

New completed jobs retain their uploaded, unseparated input in private S3 storage.
The database stores the pinned object identity and comparison timeline; audio bytes
remain in S3. Existing owner-scoped input download grants authorize playback and
export. Job/account deletion continues to clean up both artifacts. Cancelled,
expired, and non-retryable failed uploads retain their existing cleanup behavior.

Android and iOS expose Voice/Original playback and original-audio export. Switching
preserves the play/pause state and corresponding position. Each artifact has its
own private cache. Voice playback prefetches the original in the background.
Switching uses the cached library timeline; iOS also persists the input format
alongside the artifact so naming/export does not require a fresh API request.
Once both artifacts are downloaded, playback and comparison work offline,
including after reopening the app. A missing or invalid cache still needs one
download; older iOS caches may need one metadata fetch to populate the sidecar. Android also persists the selected source when restoring a
queue after restart. Account/session fences prevent downloads from crossing users.

Both native import flows start with trimming off and explicitly submit
`trim_enabled: false`. Android and iOS URL imports persist this choice through retries.
The API's omitted-field default remains unchanged for older clients and stable
idempotent retries. There is no database migration or dependency change.

For trimmed jobs, the worker carries the engine's retained 44.1 kHz source sample
intervals into `comparison_ranges`. The backend validates and stores them. Clients
map between original and output time; removed gaps map to the next retained sample.
Untrimmed jobs use the same timestamp directly. The position calculation has unit
coverage for both directions and missing/invalid historical maps.

Original means the prepared audio that was uploaded for separation, which may have
been extracted/converted during import. This does not add another audio conversion
or retain the original source video.

## Main implementation files

- `backend/src/processing/processing-storage-cleanup.service.ts`: retain ready-job inputs.
- `backend/src/worker-fleet/attempts/worker-attempt.service.ts`: save comparison ranges and account for retained input bytes.
- `backend/src/processing-usage/processing-usage.service.ts`: release both retained byte amounts on deletion, preserving legacy accounting.
- `backend/src/jobs/jobs.presenter.ts`, `jobs-query.service.ts`, `comparison-ranges.ts`, and `backend/openapi.yaml`: additive response contract, validation, and unavailable historical-input handling.
- `worker/src/runtime/contracts.ts`, `control-plane-client.ts`, and `worker-runtime.ts`: preserve and report engine edit maps.
- Android `processing/JobArtifactRepository.kt`, `playback/AudioPlaybackController.kt`, `ComparisonPosition.kt`, `PlaybackQueue.kt`, and `ui/player/FullPlayer.kt`: private input cache, playback comparison, restoration, and controls.
- Android import models/coordinator/API and `ui/home/HomeScreen.kt`: durable trim preference and default-off switch.
- iOS `Processing/JobArtifactRepository.swift`, `Playback/AudioPlayer.swift`, `State/ProcessingModel.swift`, and `UI/ProcessingDetailView.swift`: original playback/download and timeline mapping.
- iOS `UI/AudioImportReview.swift` and processing coordinator/store/API: explicit persisted trim choice.

API changes follow the additive compatibility, authentication, and snake_case
principles in the [Zalando RESTful API Guidelines](https://opensource.zalando.com/restful-api-guidelines/).

## Verification on 2026-09-26

- Backend: `pnpm run verify` passed formatting, lint, typecheck, secret scanning,
  build, 885 unit/integration tests, and 147 HTTP tests.
- Worker: scoped Prettier check, `pnpm run lint`, `pnpm run typecheck`,
  `pnpm exec vitest run tests/worker-runtime.spec.ts tests/separation-timings.spec.ts`
  (47 tests), and `pnpm run build` passed.
- Android: `:app:testDirectAuthE2eUnitTest` scoped to `processing.*` and `playback.*`
  passed 177 tests; `:app:lintDirectAuthE2e` and `:app:assembleDirectAuthE2e` passed.
  An earlier unscoped run exposed an unrelated `DirectUpdateInstallerTest` flavor
  expectation failure; the entire Android test suite is not claimed green.
- iOS: `xcodebuild ... -only-testing:VocalTests test` passed 140 tests with one skip.
  Two focused UI tests passed: native file review requires rights confirmation and
  trim starts off/toggles; Voice/Original switching downloads separate artifacts and
  reuses the cached voice file. UI data is synthetic and uses the real native views,
  models, and artifact repositories with fixture transport.
- All iOS device tests used only iPhone 17 Pro, iOS 26.0,
  UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`. No Android device was used.
- `git diff --check` passed. Public mobile distribution was not performed.

## Backend deployment

CapRover app `api` is deployed as `img-captain-api:73` (2026-09-26 17:45 UTC).
The first full source build, version 72, failed with a BuildKit context timeout;
version 71 remained active until the successful replacement. Version 73 overlays
the verified compiled backend on the existing version 71 runtime/dependencies;
no dependency or environment changes were necessary.

Deployment archive SHA-256:
`45b1270d8af55ac8ed401b6a4484aeb99da964cc3df3519838edf72349c3972b`.
Live `https://api.music-mute.com/health/live` and `/health/ready` returned HTTP 200
with `status: ok`; unauthenticated `/jobs` returned HTTP 401.
Previous image `img-captain-api:71` remains available for rollback.

## Worker deployment

The installed macOS worker was staged as an immutable local release
`0.1.0-mvp.45-original.local.20260926.1`, preserving the previous
`0.1.0-mvp.45-trim6-timing.local.20260926.1` release. Only the result parser and
completion payload were updated on top of the installed runtime; its existing
engine, timing behavior, model, dependencies, and pairing were preserved.

The release inventory was verified. The prior capacity evidence correctly failed
its new-release identity check, so `mw benchmark --workers 2 --json` was run on the
built-in qualification fixture. Both recipes passed and two-worker capacity passed
with measured throughput speedup 1.62x. `mw doctor --full --json` passed every check.
`mw status --json` confirmed active, model-ready, claim-eligible, and healthy.
This is a local worker rollout, not a published fleet-wide worker release.

## Compatibility and remaining scope

- Deleted historical originals cannot be recovered. Jobs whose input was already
  scheduled for cleanup do not advertise original download availability.
- Older trimmed jobs without a comparison map cannot safely switch timelines;
  clients report unavailable comparison instead of silently playing a wrong time.
- Native playback remains limited to formats supported by the platform decoders.
- Original retention increases stored bytes; new jobs account for input plus output.
- Mobile changes require distribution of a new app build. The web client was not changed by this feature.
- Live backend health and worker qualification are verified; a new authenticated
  production job covering S3 retention, completion, and native playback end-to-end
  has not been run. Synthetic native UI tests are not production S3 proof.

## Offline switching follow-up

The previous selector made an unconditional job-detail request despite cached audio.
Android now reads the existing owner-scoped library record, and iOS uses its cached
selected job. Both prefetch the original when voice playback starts without delaying
voice playback; failures leave voice playable and allow an explicit retry. Android
original export also uses cached metadata. No backend or worker change is required.

Regression coverage recreates artifact repositories with networking rejected,
verifies file/metadata reuse without additional download grants, and runs the native
comparison UI with API access rejected after the two artifacts have downloaded.

Follow-up validation: 34 focused Android artifact/playback tests, DirectDebug lint
and build passed. The debug APK was installed in place and launched on connected
OPPO CPH2573 (`709a147`). iOS artifact tests and the offline comparison UI test
passed on the specified iPhone 17 Pro simulator. Physical-phone airplane-mode
comparison has not been measured; no latency number is claimed.

Integration with the supported-sites change on main preserves URL validation and
adds the same persisted, default-off trim choice to the newly added iOS URL import
form. Older pending iOS URL imports keep an omitted trim field for idempotency.

Post-main integration checks passed: 179 focused Android processing/playback tests,
DirectDebug lint/build, 150 iOS tests with one skip, and both offline-comparison
and unsupported-link UI tests. XcodeGen regenerated the project locally for
validation; generated project output is not included in this change.
