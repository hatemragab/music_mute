# Server-owned job stage timings

Job views, administrator job detail and media-import views expose the optional
`server_stage_timings` object. Native apps and the dashboard show its measurements
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

## Local verification (2026-09-26)

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

These checks establish local behavior only. Live production timing and an actual
GPU processing run remain unverified. Deployment and package publication are
separate from merging this change.
