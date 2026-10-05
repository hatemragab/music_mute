# yt-dlp deployment and qualification, 2026-10-03

The owner explicitly authorized implementation, saving both supplied DataImpulse
plan credentials privately, and computer-controlled deployment. No commit or push
was performed. The local adapter `.env` is ignored and mode 0600; credentials are
excluded from deployment archives and from this record.

## Deployment state

The private adapter is deployed and healthy. After full-policy retry qualification,
the owner-authorized production YouTube route was switched in CapRover to
`http://music-mute-ytdlp:8080/`. The existing private VideoScale route handles
other enabled sources.

| Component | Deployed image                          | Image SHA-256                                                      |
| --------- | --------------------------------------- | ------------------------------------------------------------------ |
| Adapter   | `img-captain-music-mute-ytdlp:5`        | `0b55e84c77cecfaeaf2e0f04396adc521c823e72a311fdb1eb790bfdebfb37d1` |
| Router    | `img-captain-music-mute-audio-router:9` | `2e4dddd770ed93ec95019791bf4c09b68ecf3085bc7a56441f289f4edf0f375a` |
| Backend   | `img-captain-api:106`                   | `140387a8b2d544b2811317b9a18a7ecffaaeba507dcaf106d728d104b0b95f49` |

CapRover uploads and configuration changes used computer control. All private
apps have one replica and no published ports. Adapter checks confirmed UID 10001,
read-only root, 2 GiB `/work` tmpfs, a 4 GiB memory ceiling, two CPU cores, Deno
2.9.5, yt-dlp 2026.8.19, bundled EJS 0.8.0 and bgutil 2.0.1. Node and FFmpeg are
absent from the adapter. Its process health and loopback token-provider ping
returned HTTP 200. Twelve deployed runtime/dependency files match the final
allowlisted archive, SHA-256
`4a059b0fa12a017b5add1b191df26b4be3db8e82e7211e4fa6e120b29066bd44`.

Backend 106 overlays seven acquisition modules and their maps onto the actual
API 105 image. All fourteen files match their release manifest; the other 1,007
runtime files are byte-identical to 105. Package/lock hashes, Node 24 and Mongoose
9.9.5 match. Existing environment, WebSocket support, HTTP settings and service
overrides are preserved. Before activation, Docker service specifications changed
only the backend image and CapRover rollout marker. Public liveness, readiness and app
policy returned 200; unauthenticated realtime/worker socket upgrades returned the
expected 401. Private router health returned 200.

After activation, CapRover and the running router both select the exact yt-dlp
URL. The protected root-owned 0600 service key matches the running router and
adapter keys by constant-time comparison. API 106, router 9 and adapter 5 each
have one healthy current replica and no published host ports. Private API
liveness/readiness and router/adapter health all returned 200.

## Live native-audio qualification

Both credential pairs passed bounded HTTPS proxy checks from the deployed
runtime: Residential 981 ms and Mobile 1,536 ms. Two distinct exits were observed
privately; 27 response payload bytes. The development Mac timed out on its two
checks, which did not establish a credential failure.

The public single-item source `jNQXAC9IVRw` was used with a 1 MiB audio ceiling and
60-second duration limit. Both plans returned native medium WebM/Opus format 250,
143,795 bytes, title `Me at the zoo`, channel `jawed`. Source-ID equality is
enforced during extraction. The actual backend probe accepted one Opus audio
stream, duration 19.021 seconds. SHA-256:
`938c96573f27d57d0c41eff2920044b2c07e246c5d89afbcda4694616b54a49a`.

The successful Residential captures took approximately 22.0 and 9.3 seconds;
Mobile attempt 4 took 21.6 seconds. Mobile stages were extraction 15.411 seconds,
token generation 4.132 seconds and transfer 1.805 seconds. No video, audio
conversion, R2 write, job, quota mutation or worker processing was performed by
these checks. Owned qualification audio was removed after validation.

Ten concurrent single-attempt requests observed ten simultaneous extraction
processes. Eight returned matching verified medium audio; two returned retryable
503 dependency errors before media transfer, at 15.6 and 30.0 seconds. Successful
HTTP times ranged from 12.2 to 28.7 seconds. This measures first-attempt behavior,
not the full four-attempt acquisition policy.

Adapter memory peaked at 1.42 GiB. Minimum host available memory was approximately
554 MiB. There were no OOM events, memory-limit events, CPU throttling or restarts.
Afterwards there were zero extraction processes; adapter memory returned to about
192 MiB and host available memory to 1.91 GiB. The host has two CPU cores and
3.83 GiB total memory; the 4 GiB container limit is a ceiling, not an allocation.

A separate ten-logical-acquisition run applied the complete bounded retry policy.
All ten succeeded: eight on Residential attempt 1, two after a transient pre-media
503 on Residential attempt 2. Exactly twelve POSTs used twelve distinct sticky
ports; no attempt 3 or Mobile fallback was needed in this run. Each recovered job
retained its identical first-start UTC timestamp. All ten payloads matched the
proven native Opus hash, for 1,437,950 media bytes total. Logical completions ranged
from 19.214 to 54.899 seconds; the batch completed in 54.993 seconds. This is one
source/sample and does not guarantee every future request will succeed.

The final post-activation check used the actual deployed API 106
`AudioAcquisitionClient` through the router and selected adapter, using its
generic private authentication and trusted acquisition context. It returned
HTTP 200 with the same original native medium audio, exact size/hash, sanitized
source metadata and accepted one-stream backend probe. Acquisition took 26.284
seconds, native validation 109 ms and the complete check 26.403 seconds.
Dedicated `ImportFiles` scratch cleanup was verified. Correlation:
`c6860f23-d3cb-40be-aaf4-eade98356b20`. This check created no R2 object, database
record, job, quota mutation or worker request.

## Fixes found during deployment

The Deno cache build command does not accept `--cached-only`; build uses
`--frozen --no-check`, while runtime uses cached-only frozen dependencies.
Pinned Deno version validation accepts its platform/channel suffix while still
requiring exactly version 2.9.5.

Raw `extract_info(..., process=False)` formats omit `protocol`. Selection now
normalizes it only after validating the strict native HTTPS Google delivery URL
and audio codec. It preserves original-track identity before size filtering,
prefers plain medium 250 over DRC, and uses raw audio bitrate metadata. Temporary
empty/token-dependent formats return bounded retryable errors; private, live,
playlist, DRM and oversize rejection remains permanent.

Qualification's Docker copy operation could not read a file from the read-only
tmpfs mount. A private binary Docker exec handoff verified the unchanged native
audio through the actual backend probe. This required no application change.

## Evidence limits and rollback

The short public clip qualifies these exact paths; it does not establish universal
YouTube availability, long-source capacity, independent perceptual source
identity, a production latency SLA, or a new R2/worker end-to-end result. Native
fallback, deadlines, cancellation and security rejection also have fixture
coverage. Latest adapter suite: 62 tests passed; router/backend native fixtures
passed. Backend verification previously passed 1,351 unit tests, 181 e2e tests,
27 import integration tests, 19 processing integration tests and 11 shared-media
integration tests, including immutable MongoDB acquisition timestamps.

Sticky ports are leased within one running adapter process and quarantined for
30 minutes. A restart resets this in-memory allocator, and DataImpulse does not
guarantee a distinct or uninterrupted exit IP. The token provider is persistent
as a supervised process; tokens and session state are not persisted to disk.

A protected root-owned 0600 rollback snapshot on the deployment server preserves
the full CapRover configuration and selected service specifications before the
rollout:
`/captain/data/musicmute-acquisition/before-ytdlp-rollout-20261003T194439Z-4bf3a333df2e4ad08c86a044a444ddcf.json`.
Snapshot SHA-256:
`be486875f851b9c4eae5921426410bfe441432424263835f6d76dd74ddbb4668`.
The router hook reads the matching protected `ytdlp-api-key`; its exact equality
to the adapter service key was verified without printing it. Proxy credentials
remain exclusive to the adapter.

The backend overlay preserves the prior Sentry release configuration; uploading
new Sentry source-map symbols was not part of this deployment.
