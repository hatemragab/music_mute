# JoJAPI YouTube acquisition: deployment and qualification, 2026-10-01

This historical record covers the initial qualification ending around 01:25 UTC.
Its Tunelio route selection was superseded by the later
[owner-authorized JoJAPI production test activation](ACTIVATION-2026-10-01.md),
which accepted the unresolved source-version defect. Its measurements and
blocker evidence remain unchanged. The later
[request-context follow-up](REQUEST-CONTEXT-2026-10-01.md) records the additional
header/cookie handling and the current private adapter deployment. Measurements
and image references below describe the initial qualification phase.

**Release blocked: JoJAPI returned audio from a different YouTube upload of the
requested film.** Valid media and successful Google transfers do not establish correct
source acquisition. Production configuration and the original router source have
been restored to Tunelio, followed by the final safe-selection router deployment
and live verification. The new JoJAPI app remains private for qualification and requires
a vendor fix before production selection. VideoScale, NestJS's generic settings,
and the existing private R2/worker flow are retained.

Work started on `main` at `690ea4cf` with a clean checkout. No commit or push has
been made. This record covers fixture checks, direct and routed transfer
measurements, and the source-correctness release blocker.

## Deployment state

| CapRover app              | Confirmed image/state                           | Purpose                                                   |
| ------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `api`                     | `img-captain-api:101`, retained                 | Existing provider-neutral API and media probe.            |
| `music-mute-videoscale`   | `img-captain-music-mute-videoscale:8`, retained | Other enabled sites.                                      |
| `music-mute-tunelio`      | `img-captain-music-mute-tunelio:2`, retained    | Original production YouTube destination restored.         |
| `music-mute-jojapi`       | `img-captain-music-mute-jojapi:4`, active       | Private qualification only; production selection blocked. |
| `music-mute-audio-router` | `img-captain-music-mute-audio-router:7`, active | Strict operator selection; Tunelio remains selected.      |

The saved `musicmute` CapRover CLI connection was used to deploy allowlisted
archives. The production host was verified through Google Cloud as
`34.28.228.205`. No backend working-tree package was deployed. The API's existing
`AUDIO_ACQUISITION_API_URL` and `AUDIO_ACQUISITION_API_KEY` remain unchanged;
the JoJAPI route was tested with router image 4 before the blocker was found.
The final router selects `http://music-mute-tunelio:8080/` and retains VideoScale
for the other-site route.
The router remains private, one replica, with no published ports, domains or
volumes. The JoJAPI image is healthy, runs as
`10001:10001`, and its deployed source hashes match the current `main` working
tree.

The JoJAPI app is private, one replica, container port 8080, without published
ports, domains or persistent volumes. Its runtime uses UID 10001, a read-only
root, init, all capabilities dropped, one CPU, 3 GiB memory, a dedicated 2 GiB
`/work` tmpfs and two bounded 5 MB log files. Scratch is ephemeral. The adapter
has no database, Firebase or R2 credentials.

`JOJAPI_API_KEY` exists only in the new app's runtime environment. The separate
internal service bearer is read from
`/captain/data/musicmute-acquisition/jojapi-api-key`, owned by root with mode
0600 in a mode-0700 directory. The qualification router hook read this file and
the existing common `api-key` file without receiving the vendor key. Production
restored its original destination/hook before deploying the final selected-key
hook with Tunelio retained. Credentials are
excluded from source, documentation, test output and deployment archives.

| Archive                             | Ordinary allowlisted files | SHA-256                                                            |
| ----------------------------------- | -------------------------: | ------------------------------------------------------------------ |
| JoJAPI                              |                          7 | `38e5317a9554a4d5d96139e59fc2446b00c4057e3cef1cf2b1b2a5016bb7c2d8` |
| Router qualification image 4        |                          6 | `3684d795951831e969f19f9a90cf6269ca950e74bfdbf4bc667a6f56c50675b8` |
| Restored original router            |                          6 | `34e0fcf6d2a44cc0a25ee8f9b4e0dc8066a0d858bc11b310606fb1db3ba8d4bf` |
| Router with explicit safe selection |                          6 | `6618bcf6b2ba6288e8518658758148711e9067927f53be7c27611a4c521e0b49` |

Packagers verified exact source bytes and regular file membership. Secrets,
dotenv values, tests, docs, hooks and generated outputs are excluded.

The attempted rollback to the old image-3 tag failed because CapRover tried to
pull a local image tag. The recovery used a six-member archive reconstructed
from unchanged `HEAD` at `690ea4cf` and deployed through the CapRover CLI at
01:17:38 UTC on 2026-10-01. That deployment completed successfully. This is an
operator restoration before release, not automatic per-request fallback.

The final router source accepts exactly one operator-selected YouTube private
destination from Tunelio or JoJAPI; the example retains Tunelio. The hook
validates exactly one configured YouTube URL before reading any key, then reads
only that adapter's protected service bearer plus the common ingress/VideoScale
key. Missing, duplicate or unqualified configuration fails closed. There is no
automatic retry, fallback, provider switch or backend vendor branch. JoJAPI
selection remains blocked until source correctness is independently qualified.

The final CLI deployment completed at 01:25:20 UTC on 2026-10-01. CapRover
version 7 is active, its build is complete, and the private service has one
replica without published ports, domains or volumes. Its runtime files all
match the current `main` working tree; it is healthy and runs as `10001:10001`.
The selected YouTube bearer matches the protected Tunelio key file. Neither
the vendor key nor JoJAPI's internal bearer is present in the router runtime.
The installed final hook SHA-256 is:

`727f5a1f33201dbfeb71ae8c678fa6838845399f1a76477c7f9385ca79757992`

One complete acquisition through the restored default generic API route
requested `jNQXAC9IVRw`, returned `provider: tunelio`, and passed the API
container's deployed `ImportFiles` and ffprobe checks. The native WebM measured
19.021 seconds and 255,427 bytes, with acquisition time 2,773 milliseconds and
SHA-256 `f9884de69a8447dafa84219297e282eabcc62bdc0f38a8a9a3a7cfa23ce2c05b`.
Scratch was empty afterward. This verifies the restored private acquisition
route, not a new R2 upload or worker processing job.

## Release blocker: wrong source version

Read-only checks of the official YouTube players on 2026-10-01 independently
measured `video.duration` for both uploads:

| Requested upload                                           | Official player title   | Measured player duration |
| ---------------------------------------------------------- | ----------------------- | -----------------------: |
| [YE7VzlLtp-4](https://www.youtube.com/watch?v=YE7VzlLtp-4) | Big Buck Bunny          |          596.501 seconds |
| [aqz-KE-bpKQ](https://www.youtube.com/watch?v=aqz-KE-bpKQ) | Big Buck Bunny 60fps 4K |          634.601 seconds |

These are different versions of the same film, not unrelated films. The earlier
596.544-second audio for the first upload aligns with its official player within
43 milliseconds. Its later 634.624-second result instead aligns with the second
upload within 23 milliseconds and does not match the requested version's length.

An acquisition requesting `YE7VzlLtp-4` returned 30,767,611-byte, 634.624-second
native M4A, matching the measurements from `aqz-KE-bpKQ`, rather than the
28,921,366-byte, 596.544-second audio observed earlier for the requested source.
Separate sequential direct acquisitions for both IDs then returned exactly
identical files with this SHA-256:

`595acb084489cf9bee90547335de299189114b341445c2f2d62b168c4b77a513`

A standalone vendor `/download` request for `YE7VzlLtp-4` also returned the wrong
size/duration. The incorrect vendor result persisted with `Cache-Control:
no-cache` and `Pragma: no-cache`; the observed Cloudflare cache status was
`DYNAMIC`. This reproduces the mismatch outside the router and concurrent adapter
path and establishes an upstream source-selection problem. No signed URLs or
raw provider payloads are retained in this record.

The gateway format response provides no source ID for the adapter to verify.
Fourteen completed image-4 files passed media probing, including the additional
sequential comparison, but at least one requested source was incorrect. The
twelve initial direct/routed completed transfers therefore are **not twelve
fully source-qualified imports**. ffprobe verifies media properties and duration;
it does not establish that bytes belong to the requested video. JoJAPI must fix
this source-selection behavior before production routing is enabled.

Final image-4 numerical logs confirm 14 paid-creation HTTP 200 responses and
14 completed transfers totaling **303,191,881 bytes**, with 34 media HTTP 206
range spans and 15 media HTTP 302 CDN relocations. No Google HTTP 403 or gateway
HTTP 429 appeared in these fourteen completed attempts. Four separate gateway-only
diagnostic responses were HTTP 200 and are not counted in these fourteen media
transfers. These figures do not state total credits consumed: earlier prototype
failures and other diagnostics are separate.

## Vendor study and live transport findings

The [official marketplace documentation](https://jojapi.com/hub/api/cloud-api-hub-youtube-downloader)
and [OpenAPI specification](https://jojapi.com/hub/api/cloud-api-hub-youtube-downloader/openapi.json)
were studied on 2026-10-01. The adapter makes one paid
`GET /download?id=<id>&filter=audioonly&quality=highestaudio` with
`X-JoJAPI-Key`, then downloads the selected native audio. Vendor documentation
states two credits per download request and six-hour link validity. No `/info`,
`/mux`, paid enrichment, media extraction runtime or audio conversion is used.
Every qualification attempt is a distinct authorized acquisition; failed paid
requests are never automatically replayed or sent to another provider.

Live investigation established these transport requirements:

- The gateway returned HTTP 403 for Python urllib's default User-Agent. Setting
  the adapter's explicit `MusicMute/1.0` User-Agent resolved this gateway issue.
  This was a JoJAPI gateway response, not a Google media refusal.
- The vendor sometimes returned valid bounded JSON with `Content-Type:
text/html`. That observed type is accepted only for the bounded gateway body,
  followed by JSON decoding and strict audio-format validation. Actual HTML and
  malformed JSON still fail.
- Google media returned HTTP 302 CDN relocations. Up to three relocations are
  allowed, with every destination revalidated as public HTTPS Google media.
  No gateway redirect or arbitrary host is accepted.
- A roughly 31 MB whole-file Google transfer exceeded the original 150-second
  deadline. Strict generated ranges of at most 10 MiB corrected the observed
  throttling. The 100 MB cap permits at most ten contiguous ranges; their exact
  Content-Range, total size and framing are checked. All ranges retain the
  original deadline and do not repeat paid acquisition.
- A gateway HTTP 429 was observed with nominal one-per-second pacing. Paid
  starts now have at least 1.1 seconds between them and a maximum rate of one
  per second. A bounded Retry-After cooldown pauses later starts; the failed
  execution is not replayed.

The initial direct prototype had four attempts: one success, two deadline
failures and one gateway 429. This is separate from the final image-4 results
below. The fixes above have synthetic regression coverage. No Google HTTP 403
was observed in the live attempts covered by this record.

## Direct live transfer measurements

Image 4 completed **six of six** direct private media transfers, requesting three
public YouTube IDs twice each in batches with concurrency three. The check
ran the real backend acquisition client and ffprobe from the existing API
container, directed at the private JoJAPI adapter. Each returned file passed
independent real-media probing. These earlier measurements do not clear the
later source-correctness blocker.

| Requested YouTube ID | Earlier measured duration | Measured bytes per transfer | Completed/probed transfers |
| -------------------- | ------------------------: | --------------------------: | -------------------------: |
| `jNQXAC9IVRw`        |         19.063583 seconds |                     309,288 |                          2 |
| `aqz-KE-bpKQ`        |           634.624 seconds |                  30,767,611 |                          2 |
| `YE7VzlLtp-4`        |           596.544 seconds |                  28,921,366 |                          2 |

The six acquisition durations were 3,659, 14,258, 11,568, 17,666, 2,670 and
9,524 milliseconds, a 2.670–17.666-second range. These are acquisition timings,
not worker processing or complete user-job timings. The aggregate transferred
audio was **119,996,530 bytes**. Adapter scratch contained zero entries after
qualification.

These transfers show that the tested Google media accepted this server's
requests at that time. They do not guarantee future IP acceptance, account
quota, every YouTube video, or twenty concurrent live acquisitions. A later
Google refusal still fails safely without paid replay or fallback.

## Routed live transfer measurements

Router image 4 completed **six of six** private media transfers in a wave with
concurrency three. This wave used the API's existing default generic acquisition
URL and service key, then the deployed `ImportFiles` implementation and real
ffprobe. Every transfer completed and passed independent media validation.
The aggregate was **121,660,129 bytes**, with acquisition times of 2,829, 4,479,
13,162, 14,231, 11,533 and 9,688 milliseconds, a 2.829–14.231-second range.

The fourth requested public source, `eRsGyueVLvQ`, returned native WebM measuring
888.061 seconds and 14,524,004 bytes in each of two acquisitions. The confirmed
other request records include `jNQXAC9IVRw` at 19.063583 seconds/309,288 bytes
and two `aqz-KE-bpKQ` records at 634.624 seconds/30,767,611 bytes, with native
M4A audio.

Routed execution index 3 requested `YE7VzlLtp-4` but returned the
634.624-second/30,767,611-byte M4A implicated in the release blocker. Completion
and probing of this transfer are confirmed; source-correct acquisition is not.
Production selection was restored to Tunelio after the independent sequential
and standalone vendor checks reproduced the wrong-source response.

## Local validation

Validation commands were run from the listed working directories:

| Working directory             | Command/scope                                                            |
| ----------------------------- | ------------------------------------------------------------------------ |
| `backend/`                    | `pnpm run verify`                                                        |
| `backend/`                    | `pnpm run test:imports:integration`                                      |
| `backend/`                    | `pnpm run test:processing:integration`                                   |
| `video_providers/jojapi/`     | `python3.12 -B -m unittest -v test_service.py test_official_metadata.py` |
| `video_providers/router/`     | `python3.12 -B -m unittest -v test_service.py`                           |
| `video_providers/videoscale/` | `python3.12 -B -m unittest -v test_service.py test_official_metadata.py` |
| `video_providers/tunelio/`    | `python3.12 -B -m unittest -v test_service.py test_official_metadata.py` |
| Repository root               | `python3.12 -B -m unittest discover -s video_providers/tests -v`         |
| `video_providers/`            | `python3.12 -B -m unittest -v test_acquisition_scratch.py`               |

| Python scope                                                     | Passing tests |
| ---------------------------------------------------------------- | ------------: |
| JoJAPI service and optional official metadata                    |            78 |
| Router                                                           |            30 |
| VideoScale                                                       |            71 |
| Tunelio                                                          |            46 |
| Shared limits and native adapter/router/NestJS probe integration |            13 |
| Shared scratch                                                   |             4 |
| Total                                                            |       **242** |

JoJAPI and router tests use fake keys, generated audio and local HTTP fixtures.
The integration qualification exercises actual adapter and router code, then
the real NestJS media probe. It covers key isolation, format/framing/range
validation, safe redirects, refusal/expiry, no replay or fallback, metadata
sanitation, rate limits, cancellation, bounded scratch and cleanup. The existing
Tunelio qualifier remains available. Fixture results are not live Google proof.
The final router suite passed 30 tests after adding explicit Tunelio retention,
JoJAPI selection, strict destination isolation and selected-key hook validation.
The shared/native integration suite passed all 13 tests again after that change.
The final 78-test JoJAPI suite also passed a synthetic concurrent-isolation
regression with three distinct responses completing in reverse order. Together
with sequential and standalone vendor reproduction, this separates the upstream
source-version defect from adapter response sharing or concurrent routing.

Backend `pnpm run verify` passed formatting, lint, TypeScript, tracked-secret
checks, transfer benchmarks, 1,197 unit tests, 158 HTTP tests and compilation.
`pnpm run test:imports:integration` passed **24 of 24** tests.
`pnpm run test:processing:integration` passed **18 of 19** tests; the one failure
is the existing date-dependent UTC-month fixture described below. No backend
code or fixture was edited for this deployment.

`test/processing-usage.integration.mjs:338` expects two concurrent 40-second
reservations after lowering the monthly allowance to 60 seconds. Earlier in the
same test it explicitly consumes 26 seconds in October 2026; the later
reservations omit their time argument and use the real current month. On
October 1 the first reservation takes the total to 66 seconds, so the second
correctly rejects and the fixture observes one success instead of two. A focused
unchanged rerun reproduced this failure. The same test passed with a process-only
Date preload simulating September 29, confirming the date collision. This is
recorded as a failed check, not counted as a passing integration suite.

## Evidence boundaries

Final private health, unauthenticated acquisition and malformed-body checks
returned 200/401/400. Explicit-User-Agent public health checks for the private
adapter/router returned 404; API live/readiness checks returned 200. JoJAPI's
runtime files matched current source and its UID, read-only root, capabilities,
init, CPU/memory/tmpfs bounds and protected key permissions were verified.
Its scratch contained zero entries, with no open deleted files remaining.

The live checks establish private acquisition and independent real-media
validation. No new R2 upload, worker processing job, authenticated user import,
device test or MusicMute UI journey was run in this qualification. Existing R2 and worker
behavior is retained but was not newly measured. No real data was deleted,
provider plan purchased, or credentials written into repository files.

The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-10-01. The existing private bearer contract, bounded binary
headers, compatible response shapes and sanitized problem responses remain
consistent with the preflight documented in the [adapter guide](../README.md).
Local and sampled live evidence does not establish production-wide compliance
or future provider reliability.
