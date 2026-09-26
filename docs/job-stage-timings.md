# Server-owned job stage timings

Job views, administrator job detail and media-import views expose the optional
`server_stage_timings` object. The dashboard shows its measurements
alongside the stage timeline. No duration in this object uses a phone timestamp.
Old jobs without the new timing ledger return `null`; clients show unavailable
data rather than inventing measurements. Native total timers no longer extrapolate
while offline or fall back to `client_started_at`.

## Measurement boundaries

| Stage                                                                                                         | Measurement                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server total                                                                                                  | Job reservation acceptance to terminal transition, or the current server sample. For URL imports, starts at import acceptance, before the audio job exists. Explicit user retries create a new job and a new total.           |
| Source queue                                                                                                  | Import creation to processor acquisition.                                                                                                                                                                                     |
| Source download                                                                                               | Monotonic backend elapsed time around source acquisition.                                                                                                                                                                     |
| Source validation                                                                                             | Monotonic backend elapsed time around media probing.                                                                                                                                                                          |
| Source upload                                                                                                 | Monotonic backend elapsed time around the signed input upload; omitted when no transfer runs.                                                                                                                                 |
| Upload confirmation                                                                                           | Backend confirmation operation for imported input.                                                                                                                                                                            |
| Submission and confirmation                                                                                   | Local-file job creation to server upload confirmation. Includes user/network/confirmation delays; **not** a measurement of the phone-to-S3 transfer itself.                                                                   |
| Worker queue                                                                                                  | Sum of queue-entry to claim intervals, excluding execution and explicit retry backoff.                                                                                                                                        |
| Retry wait                                                                                                    | Sum of explicit backoff portions of those queue intervals.                                                                                                                                                                    |
| Worker setup                                                                                                  | Worker resource check, workspace preparation and input grant acquisition.                                                                                                                                                     |
| Worker download                                                                                               | Input transfer through its integrity checks.                                                                                                                                                                                  |
| Input validation, preparation, model loading, music removal, denoising, trimming, encoding, output validation | Monotonic worker stage intervals observed around child progress transitions. Music removal is separation only. Skipped stages are absent. Existing fine-grained engine timings remain separately available to administrators. |
| Result preparation                                                                                            | Output-ready event through output publication preparation.                                                                                                                                                                    |
| Result upload                                                                                                 | Worker output publication, including grant requests and transfer retries within that publication.                                                                                                                             |
| Server finalization                                                                                           | Backend completion request handling through the ready-state write, including output verification. Excludes the response trip and worker completion acknowledgement.                                                           |

Durations are integer milliseconds. Totals include coordination and persistence
overhead, so they are **not** calculated by summing stages. The worker and backend
use monotonic clocks for operation durations and backend timestamps for lifecycle
intervals. Invalid negative lifecycle intervals remain unavailable.

## Progress, failure and retry behavior

The worker sends an optional cumulative `execution_timings` snapshot on existing
progress, completion and failure endpoints. During a long stage it samples every
five seconds; the existing bounded, serialized progress reporter coalesces updates.
Each entry contains `stage`, `duration_ms` and `complete`. Request validation rejects
unknown stages, duplicates, fractional/negative durations, more than 13 entries,
and per-stage durations above the existing two-hour attempt bound.

NestJS stores a bounded per-attempt ledger on the job. The existing ownership and
sequence fences protect progress updates; terminal writes use the existing
transactions and idempotency checks. A snapshot replaces its attempt's previous
snapshot, so duplicate delivery does not add time twice. Automatic retries retain
earlier attempt measurements. Public views expose attempt numbers and measurements,
never internal machine or attempt identities.

`complete: false` means **the last recorded lower bound**, not a completed duration.
A crash, cancellation or lost lease retains the last accepted snapshot and never
extends it to the recovery time. An abrupt failure before delivery cannot provide
an exact duration. Aggregated rows stay partial if any contributing attempt is
partial, or an entire attempt has no timing snapshot. Missing/skipped stages are
not fabricated as zeroes. A measured operation may legitimately round to zero ms.

URL acquisition snapshots are persisted on the import, including failed operations,
then copied to its job. The import acceptance timestamp is supplied through an
internal service argument; it is not accepted from `CreateJobDto` and does not
change the client's idempotency hash.

## Rollout and compatibility

Deploy **backend first, worker second, clients last**. Existing workers can omit
`execution_timings`; their missing stages remain unavailable. Existing client
fields, including administrator `stage_timings`, retain their contracts. No data
migration, backfill or new index is required. This implementation does not deploy
or publish any component.

API guideline preflight: the official [Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were retrieved on 2026-09-26. Applicable rules: OpenAPI (101), authentication and
authorization (104), backward compatibility (106), compatible extensions (107),
snake_case JSON (118), absent/null equivalence (123), and integer formats (171).
The existing millisecond duration convention is preserved.

## Prior implementation verification (2026-09-26)

The following historical checks ran in the separate `job-stage-timings` checkout.
The realtime worktree integrates the backend, worker, and dashboard portion;
Android/iOS presentation changes remain in the original checkout. These historical
results are not validation of this integration. See the integration record below.

- Backend: `pnpm run verify` passed (format, lint, typecheck, secret scan,
  unit tests, HTTP tests, build). Final timing/finalization changes also passed
  the focused stage-timing and worker-attempt service tests and the compiled
  worker integration again.
- Backend integration: `pnpm run test:worker:integration`,
  `pnpm run test:imports:integration`, and
  `node --test test/dashboard-contract.integration.mjs test/admin-jobs.integration.mjs`
  passed with isolated local services. Worker integration uses a fixture engine
  and local transfers; it does not establish real-GPU or production performance.
- Worker: `pnpm run protocol:check`, `pnpm run lint`, `pnpm run typecheck`,
  `pnpm test` (391 passed, 2 skipped), and `pnpm run build` passed.
  `pnpm run verify` stops at an existing formatting issue in the unchanged
  `pnpm-lock.yaml`. Running the remaining checks independently reached
  `pnpm run test:engine`, which failed because the selected Python environment
  lacks `audio_separator` (74 tests run, one error, one skip). No engine code or
  Python dependencies were changed.
- Dashboard: `npm run lint`, `npm run typecheck`, `npm test` (77 tests), and
  `npm run build` passed. Full `npm run format:check` reports an existing issue
  in the unchanged `src/observability/sentry.test.ts`; changed files pass.
- Android: `./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest
:app:assembleDirectDebug :app:assemblePlayDebug :app:lintDirectDebug
:app:lintPlayDebug` passed. No Android device/emulator tests were run.
- iOS: `xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination
'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07'
-derivedDataPath DerivedData -parallel-testing-enabled NO
-only-testing:VocalTests/AudioTaskPresentationTests
-only-testing:VocalTests/JobsAPIClientTests test CODE_SIGNING_ALLOWED=NO`
  passed: 24 tests on the existing iPhone 17 Pro / iOS 26.0 simulator.
- Changed TypeScript/Markdown/YAML files pass Prettier checks; changed Swift
  files pass `xcrun swift-format lint --strict`. `git diff --check` passed.

No commit, push, deployment, production mutation, or package publication was
performed. Live production timing and an actual GPU processing run remain
unverified.

## Realtime integration (2026-09-26)

The dashboard uses the same full WebSocket snapshots and never polls for timing.
It displays milliseconds for short operations, readable seconds/minutes for longer
ones, an explicit server total, partial measurement labels, and per-attempt detail.
Historical jobs show their saved successful-worker engine measurements when present;
missing lifecycle durations are not inferred from zero processing counters.
Server finalization is recorded even when an older worker omits execution snapshots.

Deploy the updated backend before activating timing reporting on workers. The local
installed `mvp.45` contains changes beyond the repository's `mvp.36` package version;
never replace that installed runtime wholesale with the checkout build. New captures
require a worker with the timing reporter; historical missing measurements cannot be
recovered by this change. No database backfill or production data write is performed.

Job lists include aggregate timing rows but omit per-attempt detail to bound live
snapshot size. Detail includes the bounded attempt history.

### Integration checks before deployment

- Backend `pnpm run verify`: passed (921 unit tests, 148 HTTP tests, format,
  lint, typecheck, secret scan and build). After bounding list payloads, typecheck,
  28 focused job/query/attempt tests and build passed.
- Compiled local integration: seven realtime, URL-import and worker-flow tests
  passed with isolated MongoDB/Redis and fixture processing/transfers.
- Worker lint/typecheck, 391 tests (two skipped) and build passed. No Python
  engine code changed and no real GPU or production worker activation was tested.
- Dashboard lint/typecheck, 79 unit tests, build, 11 deployment tests and two
  Chrome realtime tests passed. Browser assertions cover partial-to-complete
  socket updates, no polling, and no overflow at 390px; desktop/mobile screenshots
  were reviewed. Values in these screenshots are synthetic fixtures.
- Source packaging is prepared for manual CapRover upload. No production deploy,
  worker activation, mobile rebuild, commit or push was performed for this fix.


### Production deployment — 2026-09-26

The user authorized direct CapRover deployment. Uploaded the verified archives
from `~/Downloads/musicmute-stage-timings-2026-09-26/` through the existing
MusicMute CapRover browser session. No production settings or credentials changed.

- Backend: `img-captain-api:71`, deployed before the dashboard; build succeeded
  and `GET https://api.music-mute.com/health/ready` returned HTTP 200, `status: ok`.
- Dashboard: `img-captain-dashboard:13`; build succeeded and its public page
  returned HTTP 200. The authenticated job detail showed “Live updates”.
- The reported historical job now shows saved engine durations (music removal
  11.86 s, preparation 1.14 s, encoding 2.38 s), while missing server totals are
  explicitly unavailable. This verifies historical presentation, not a new job's
  full timing ledger. Historical missing measurements cannot be reconstructed.
- Production screenshot: `~/Downloads/musicmute-stage-timings-2026-09-26/production-stage-durations.png`.
- Previous CapRover images remain available for rollback: API 70, dashboard 12.


Worker activation completed after backend deployment:

- Active local release: `0.1.0-mvp.45-trim6-timing.local.20260926.1`.
- Cloned the installed mvp.45 release and replaced only compiled worker-runtime,
  progress-reporter and the new stage-clock files, plus package version metadata.
  The installed runtime matched the pre-timing baseline for the two modified
  implementations. Manifest comparison confirmed all other installed files,
  including newer engine and retry fixes, were unchanged.
- Manifest regenerated and verified; previous release retained. Existing
  installation, update, lifecycle and capacity records were backed up privately.
- Graceful stop completed with zero active attempts. The first benchmark refused
  because explicit drain intent was required; after `mw drain --json`,
  `mw benchmark --workers 2 --json` passed with 1.567x throughput and a fresh
  release-bound two-slot receipt. No forced stop was used.
- `mw resume --json`, `mw start --wait-ready --json` and
  `mw doctor --full --json` passed. Final readiness was ready, modelReady and
  localReady true, claimEligible true, with no blockers.
- This updates the local installed worker/CLI runtime only; no signed fleet
  package was published. Other processing machines need the timing reporter too.
- No new production job was submitted for this deployment. A complete new-job
  timing timeline still needs live processing confirmation. No mobile rebuild,
  commit or push was performed during this deployment.
