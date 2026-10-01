# Media pipeline performance review — 2026-10-01

This review covers mobile intake, private Tunelio acquisition, NestJS validation,
private R2 storage, worker processing, durable publication and user downloads.
The improvements below are local source changes. No component was deployed,
published or committed, and no new paid acquisition or real-storage write was
performed for this review.

## Current production evidence

Read-only CapRover checks on 2026-10-01 confirmed API image 102, router image 8
and Tunelio image 2, each with one instance. The API selects the private router;
the router's `YOUTUBE_AUDIO_ACQUISITION_API_URL` selects Tunelio. Earlier October 1
JoJAPI activation notes describe an earlier configuration, not this checked state.
JoJAPI remains installed; this work does not change provider selection.

A correlated existing successful import, beginning at 17:15:50 UTC, recorded:

| Backend stage                   | Recorded duration |
| ------------------------------- | ----------------: |
| Source acquisition and transfer |          3,457 ms |
| Independent audio validation    |            876 ms |
| R2 source PUT                   |          1,235 ms |
| Upload confirmation             |            252 ms |

For that same acquisition, Tunelio recorded a 993 ms creation request and a
1,638 ms media transfer. The backend's first-to-last import-stage log window was
7,569 ms. Its four measured operations total 5,820 ms; the remaining 1,749 ms is
unattributed orchestration overhead, not a measured database duration. These
existing logs exclude mobile submission, later worker execution and user delivery;
they are neither a full end-to-end baseline nor proof of the local improvements.
No user media, source URL, credential or signed grant is included here.

## Every stage and the resulting change

| Step                          | Existing behavior and validation                                                                                                                    | Improvement                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mobile URL submission         | Sends the URL and immutable request identity to NestJS; no phone-side source download or upload.                                                    | Android now retains server timing rows in every import snapshot, fixing the missing elapsed measurement.                                                                                               |
| Local mobile intake           | Native media preparation, duration/size policy, confined input and pre-admission SHA-256.                                                           | Android removes a second pre-PUT hash read; the PUT still hashes the actual bytes and sends the signed R2 checksum.                                                                                    |
| Local reservation and upload  | Durable request replay, ownership/policy admission, unique create-only R2 PUT, confirmation and uncertain-response recovery.                        | A first acknowledged Android reservation uploads immediately, removing one confirmation HTTP request and its guaranteed-missing storage HEAD. Replayed/recovered intents still confirm first.          |
| Backend URL admission         | URL canonicalization, account/policy/quota fences, durable import outbox, shared source/recipe lookup.                                              | Existing shared originals/results remain reused without duplicate acquisition or user copies.                                                                                                          |
| Acquisition queue             | Redis-global concurrency/rate limits, bounded outstanding imports, deadline and scratch reservation.                                                | Preserve twenty active executions and five starts/second; no speculative capacity increase.                                                                                                            |
| Private router                | Authenticated single POST to the selected adapter, bounded length and transfer, no provider URL disclosure or failover.                             | Accept backlog increases from eight to 64, matching the existing bounded handler admission.                                                                                                            |
| Tunelio acquisition           | One paid create request, native audio-only delivery, secure DNS/TLS, limits and optional bounded nonfatal metadata.                                 | Reuse the verified TLS context. A positive verified Content-Length streams vendor bytes directly through the router to NestJS; unknown-length delivery retains bounded scratch staging.                |
| NestJS receive and validation | One streaming byte-count/SHA-256 pass, then one authoritative ffprobe for container, codec, track count and duration before R2 admission.           | Truncated accepted binary deliveries remain permanent invalid audio rather than becoming retryable dependency errors. Local disk errors and cancellation retain their classifications.                 |
| R2 source persistence         | Private unique key, signed size/checksum/type, create-only PUT and one identity-confirming HEAD.                                                    | Preserve these checks; no extra read, copy, public storage or credentials added.                                                                                                                       |
| Shared cache handoff          | Shared source/recipe state fences prevent duplicate acquisition/processing and enforce owned job creation.                                          | Committed source/result changes wake queued shared imports with a 50 ms debounce through the existing single database feed. Full recovery and scratch sweeping remain on the 30-second recovery cycle. |
| Worker claim/input            | Scheduler eligibility, recipe/model readiness, leases, resource limits, conditional download and streaming SHA-256; child handoff checks bytes/SHA. | Preserve checks across process/storage boundaries. Existing direct MP3/WAV inference and warm model reuse remain.                                                                                      |
| Separation and encoding       | One primary-vocal model pass, optional trim, unchanged-trim reuse and bounded 160 kbps MP3 encoding.                                                | Preserve the qualified model/recipe; no speculative batching, codec or quality changes.                                                                                                                |
| Worker output validation      | MP3 metadata/format/duration checks and complete SHA-256 before publication.                                                                        | Run probe and SHA-256 concurrently. Both must finish successfully; failure waits for the hash reader before cleanup.                                                                                   |
| Result upload/publication     | Signed immutable output PUT, actual streamed checksum, ETag-bound confirmation, shared publication and transactional completion.                    | Preserve durable storage and ownership checks, including the one-time shared output publication copy.                                                                                                  |
| User result retrieval         | Realtime Ready state, owner-scoped download grant, verified bytes, atomic private cache promotion and cancellation/session fences.                  | Android/iOS output retrieval requests the authoritative download grant directly, removing a separate serial job-detail HTTP request. Original retrieval retains metadata/readiness behavior.           |

The screenshot's fourth-stage “Sending” label corresponds to server source
upload for a URL import. The phone is waiting for server persistence and handoff.
Missing duration rows are now copied from live import snapshots; unknown media
duration is still not fabricated.

## Measured local improvements

| Measurement                    |     Before |    After | Boundary                                                                                     |
| ------------------------------ | ---------: | -------: | -------------------------------------------------------------------------------------------- |
| Tunelio first byte             |   921.4 ms |   1.0 ms | 8 MiB synthetic fixture, paced vendor and receiver, median of three runs                     |
| Tunelio complete transfer      | 1,867.5 ms | 945.0 ms | Same fixture; preserves exact bytes and rejection behavior                                   |
| Tunelio media scratch written  |      8 MiB |        0 | Positive framed-length fast path; reservation and fallback retained                          |
| Worker final output validation |   33.71 ms | 24.60 ms | Synthetic 24 MB/20-minute MP3, twenty alternating rounds per mode, identical complete hashes |

Native savings are structural: one Android fresh-upload confirmation round trip
and missing-object HEAD, one Android full-file read, and one output detail round
trip on each platform. Their production duration was not measured.

The shared wakeup removes reliance on a possible remaining 30-second recovery
wait. Fifty milliseconds is its debounce, not a total latency promise: change-feed
delivery, queued work and durable admission still take time. Unit tests cover
burst coalescing, no overlapping maintenance, changes arriving during recovery,
feed reconnection and shutdown. Real local MongoDB tests establish committed-event
wakeup and a single feed instance; the shared-media fixture establishes eligible
follower enqueue, source-only waiting, owned cache reuse and no duplicate paid work.

## Validation

Commands run from their component directories:

- Backend: `pnpm run verify`; focused import-file/runtime/retry Vitest suites;
  `pnpm run test:imports:integration`, `pnpm run test:processing:integration`,
  `pnpm run test:realtime:integration`; final compiled runtime/shared-media fixtures.
  Final verification: 1,235 unit tests and 158 HTTP tests; 27 import integration
  tests, 19 processing integration tests, one realtime integration test and thirteen
  focused compiled runtime/shared-media tests passed. `pnpm audit --prod` reported
  no known vulnerabilities. Owned local MongoDB/Redis, mock acquisition/R2 and
  synthetic audio only.
- Tunelio: `python3.12 -B -m unittest -v test_service.py test_official_metadata.py`
  (53 tests). Router: `python3 -B -m unittest -v test_service.py` (30 tests).
  Combined routing: `python3.12 -B -m unittest discover -s video_providers/tests -v`
  (16 tests). Includes vendor → Tunelio → router → compiled NestJS ImportFiles,
  real ffprobe, partial-body permanent rejection and no retry/fallback.
- Android: JDK 17 and the existing Android SDK;
  `./gradlew :app:testDirectDebugUnitTest :app:lintDirectDebug :app:assembleDirectDebug`
  (334 JVM tests, lint zero errors/199 warnings). No Android device/UI test.
- iOS: `xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination
'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07'
-derivedDataPath DerivedData -parallel-testing-enabled NO
-only-testing:VocalTests/JobArtifactTests
-only-testing:VocalTests/ArtifactNativeValidationTests test CODE_SIGNING_ALLOWED=NO`
  (13 tests on the existing authorized iPhone 17 Pro/iOS 26.0 simulator), plus
  strict `swift-format` for touched Swift files.
- Worker: protocol, formatting, lint, typecheck, 552 TypeScript tests
  (18 platform skips), eleven packaging tests, 98 engine tests
  (one existing Windows skip) using the qualified installed Python environment,
  and build. No Windows native execution or worker activation.
- Changed-source formatting and `git diff --check`.

API review used the [official Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-01: rules 100/101 (API-first/OpenAPI), 104 (security), 106
(compatibility), 178 (`Content-*` framing), 151 (success/errors), 176 (problem JSON)
and 155 (responsiveness). The private binary response, REST routes, credentials
and existing full-snapshot WebSocket contracts remain compatible.

## Remaining boundaries

These changes require separate authorized delivery of Tunelio, router, backend,
worker and native builds. Production speed after deployment and a fresh complete
mobile-to-user processing run remain unmeasured. Unknown-length provider responses
still stage to scratch. Provider wait, network throughput, scheduler capacity,
model inference, trim/encoding and durable storage publication remain real costs.
Do not remove authentication, quotas, immutable-object confirmation, media limits
or process-boundary hashes to claim a shorter time. More inference/batching/codec
changes need native capacity and listening-quality qualification.
