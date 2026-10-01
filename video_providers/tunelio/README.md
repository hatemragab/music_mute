# Private Tunelio audio adapter

This adapter remains deployed, while production YouTube configuration selects
[JoJAPI](../jojapi/README.md) for the [owner-authorized test activation](../jojapi/docs/ACTIVATION-2026-10-01.md).
The [2026-10-01 vendor source-version mismatch](../jojapi/docs/DEPLOYMENT-2026-10-01.md)
is still unresolved.
Acquisition failures never trigger automatic provider fallback.

Tunelio is the YouTube-only SaaS adapter for MusicMute. Its private contract is
the same as VideoScale: authenticated POST /audio-imports returns bounded audio
bytes to NestJS, which independently validates audio/duration, stores the input
in private R2 and starts the existing worker flow. Clients and workers never
receive the vendor API key or signed download link.

This app lives beside music-mute-videoscale; it does not replace or configure
that app. A private provider router can select Tunelio for canonical YouTube items
and VideoScale for other enabled public sites. There is no fallback or replay
after a Tunelio request fails. NestJS remains provider-neutral.

## Provider behavior

Exactly one GET https://tunelio.dev/create per acquisition with quality=opus
and audioBitrate=128. This requests the nearest native Opus tier without
re-encoding; 128 is a preference, not a measured bitrate guarantee. There is no
paid /info, format probing, job polling, extraction runtime or FFmpeg in this
adapter. NestJS retains its actual media validation and encoding responsibilities.

The returned delivery must be HTTPS, exact host tunelio.dev, exact path
/tunnel, and contain a nonempty query. Signature/expiry validation belongs to
Tunelio. Audio repackaging parameters are rejected. The anonymous tunnel request
receives no Authorization, cookies or vendor response headers. Redirects are
never followed. Every DNS answer must be public and is pinned when connecting;
TLS verifies the provider hostname. DNS time and resolver threads are bounded.

Both creation and media requests execute once. Even though /create uses GET,
it is paid and has no verified idempotency contract: transport errors, 429,
malformed responses, bad media, expiry and disconnect never create another link
automatically. An already-created link can still have consumed credits when
local acquisition later fails. A new user import is a separate billable action.

The adapter validates the successful create response's native-audio mode and
quality, advertised file size, actual delivery Content-Type, response framing and
complete byte count. Content-Length and advertised bytes, when present, must
match the measured audio bytes. Unknown types, compressed bodies, empty or
truncated media and oversized bodies fail. Native WebM/Opus may use audio/webm
or video/webm MIME: MIME alone is not evidence of audio-only media; NestJS probes
the downloaded file before accepting it.

The hard input limits are 100,000,000 bytes and 1,800 seconds. Lower caller limits
are honored. Duration is independently measured/enforced by NestJS because this
adapter does not pay for metadata. The complete request deadline is 150 seconds,
with upstream sockets capped at 25 seconds or the remaining operation budget.
Up to twenty acquisitions run at once. A request that reaches a full adapter
waits for a slot within the original deadline and stops promptly on disconnect;
no paid request starts while it is waiting. Sixty-four HTTP handlers maximum
bound slow-client thread use and leave room for health and bounded waiters.
The backend retains excess imports in its durable queue until active capacity
is available, instead of making users wait for the current audio to finish.

## Shared request limits and cooldown

The router and both adapters use the same generic configuration and shared
source: `ACQUISITION_CONCURRENCY=20` and
`ACQUISITION_REQUESTS_PER_SECOND=5`. The router enforces the overall active limit
across both providers and paces submissions; each adapter also paces its paid
creation calls to at most five starts per rolling second. Waiting for a start
checks cancellation and the original operation deadline every 100 ms; it is
admission before the first paid request, never a retry or paid fallback.
DNS/TLS connection completes before the paid start is reserved, so varying
connection delays cannot create a larger burst at the provider. An admitted
attempt reserves a start even if the subsequent HTTP request fails.
Twenty concurrent downloads and five starts per second are separate limits:
the first twenty start in paced groups, while finished downloads free slots.
The paid provider plan must support these configured limits before deployment;
the previous trial's fifteen starts per minute is not suitable for this setting.

An upstream 429 imposes a process-wide cooldown. Numeric and HTTP-date
Retry-After values are honored between one second and one day; missing/invalid
values default to 60 seconds. The failed import is not replayed. Limits are
in-memory and reset on container restart; the vendor's own key-wide rate limit
remains authoritative. Other uses of the same vendor key also consume its
allowance. Credit exhaustion and vendor auth errors are sanitized dependency
failures, not source failure or a reason to use another vendor.

## Metadata and cleanup

The bounded optional X-Import-Extra-Data-Base64 header includes schema version 1,
provider tunelio, site youtube, the MIME-recognized container/extension and
the provider-advertised file size. It does not invent codec, bitrate, channels or
sample rate from the requested quality, and does not include raw filename, URLs,
response bodies or credentials. NestJS adds measured file size/duration.

The packaged official_metadata.py is byte-identical to the existing qualified
VideoScale module. Its optional fixed YouTube oEmbed lookup runs beside acquisition
and is never awaited before audio delivery. It uses no API credentials, no paid
calls, no redirects and no retries: one lookup slot, three-second normal IO
budget, 64 KiB response cap, 128-entry bounded memory cache and host cooldown.
Only sanitized title/channel can enter metadata; a miss or stalled lookup is
nonfatal. A later request can use completed cached metadata.

Anonymous/unlinked TemporaryFile handles keep scratch bounded and clean on
success, upstream failure, client disconnect and process/container termination.
Before any provider request, the adapter atomically reserves the requested byte
limit plus 128 MB of free headroom against all unfinished scratch reservations.
Written bytes reduce the outstanding reservation after flushing, so free-space
checks do not count existing files twice. Failure releases every reservation.
CapRover mounts /work as a 2 GiB tmpfs; twenty 100 MB inputs plus the headroom
fit within this bound. The non-root container has a read-only root, dropped capabilities, 3 GiB memory,
one CPU, bounded logs and no database, R2, Firebase or persistent media access.
Logs contain only request correlation IDs, safe stages, HTTP status and numeric
byte/timing data, with exception type/code line rather than raw exception text.

## Runtime configuration and deployment

Create private CapRover app music-mute-tunelio, **not exposed as a web app**,
without published ports/public domains, one replica, container port 8080.
Apply caprover-override.json. Its internal service is
http://srv-captain--music-mute-tunelio:8080/.
The public config.example.json records these app settings and secret key names.

Runtime settings:

| Name                            | Meaning                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| TUNELIO_API_KEY                 | Vendor bearer key, only in this app's CapRover environment.             |
| AUDIO_ACQUISITION_API_KEY       | Separate internal bearer key shared only with the private router.       |
| ACQUISITION_TEMP_ROOT           | Dedicated scratch, default /work; no general /tmp or persistent volume. |
| ACQUISITION_CONCURRENCY         | Shared active acquisition capacity, default and maximum 20.             |
| ACQUISITION_REQUESTS_PER_SECOND | Shared paid-start rate, default and maximum 5 per rolling second.       |

Use the same limit values in the router and both adapters; there are no
provider-specific capacity settings. One replica per service preserves the
in-memory limits. The tmpfs limit uses RAM on demand; the 3 GiB memory cap is a
ceiling, not reserved memory. Apply the new resource override with the release;
the old 128 MiB scratch / 256 MiB RAM settings cannot support twenty large files.

Install caprover-adapter-hook.js as this app's pre-deploy hook. It injects the
private bearer key from /captain/data/musicmute-acquisition/tunelio-api-key
without sharing the existing VideoScale/API private key or cloud credentials.
The hook and secret file are operational inputs and are excluded from the image
archive. Never save either real key in this folder, .env, docs or test output.

From this directory:

    python3 -m unittest -v test_service.py test_official_metadata.py
    python3 package_caprover.py /tmp/musicmute-tunelio.tar
    caprover deploy -n musicmute -a music-mute-tunelio -t /tmp/musicmute-tunelio.tar

The packager includes only seven fixed files: captain-definition, Dockerfile,
.dockerignore, service.py, official_metadata.py, acquisition_limits.py and
acquisition_scratch.py. Shared helpers are sourced from the parent provider
directory and included by basename. It verifies member types/names
and exact bytes before publishing the archive. No vendor/private keys, hooks,
tests, docs or generated files enter the build context.

Root deployment orchestration also validates the provider router and backend.
Run backend verification and imports/processing integration checks sequentially
as documented in the root provider guide. Local fixture tests do not establish
live Tunelio availability, R2/worker success, deployment or acquisition latency.
Record those separately after deployment; no unlimited availability or immunity
from YouTube restrictions is implied.

## API guideline preflight

On 2026-09-30, the implementation read the current
[official Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/).
The existing component-internal private contract is preserved: documented
OpenAPI, service bearer security, standard methods, snake_case fields,
Content-Length/Content-Type semantics, sanitized problem JSON and compatibility.
Applicable rules are 104 (endpoint authentication), 148 (HTTP methods),
176 (problem JSON), 177 (no stack traces), 178 (Content-* headers) and
106 (backward compatibility).
Provider 429 maps to the existing private 503 dependency contract with
Retry-After, rather than introducing a new upstream-vendor wire contract.
Zalando organization-specific permission registries, hostnames and proprietary
headers are outside this service's scope. The vendor's paid GET is explicitly
treated as non-replayable despite its method.

Provider reference checked on the same date:
[Tunelio API documentation](https://tunelio.dev/docs/).
