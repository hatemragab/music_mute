# Private JoJAPI YouTube audio adapter

The owner explicitly authorized **production test activation** on 2026-10-01
despite the unresolved vendor source-version defect. The router's YouTube
configuration now selects this private adapter; see the
[activation record](docs/ACTIVATION-2026-10-01.md) for deployment evidence.
The later [import failure investigation](docs/IMPORT-FAILURES-2026-10-01.md)
records intermittent Google HTTP 403 refusals and the bounded backend retry change.
Live tests on 2026-10-01 reproduced a
provider source mismatch: separate `YE7VzlLtp-4` and `aqz-KE-bpKQ` requests
returned byte-for-byte identical audio. Sequential requests and cache bypass
headers did not correct it. The initial route was restored to Tunelio before
the later explicit test activation. See the
[deployment and qualification record](docs/DEPLOYMENT-2026-10-01.md).

The native format response has no reliable source identifier. Format, framing,
file hashing and ffprobe can validate audio integrity, but cannot establish that
it belongs to the requested YouTube video. Optional official oEmbed describes
the requested URL and cannot corroborate the vendor's bytes. A vendor fix and
new source-correlation qualification are still required to establish that the
vendor returns the correct requested upload. The test activation does not resolve
that defect.

MusicMute's private `music-mute-jojapi` app acquires YouTube audio with
[Cloud API Hub's JoJAPI endpoint](https://jojapi.com/hub/api/cloud-api-hub-youtube-downloader).
It implements the existing authenticated `POST /audio-imports` binary contract:
NestJS → private router → JoJAPI adapter → vendor, then Google media bytes →
adapter → router → NestJS's independent media probe → private R2 → worker.
Only this adapter receives the vendor key. Clients, the router and NestJS never
receive vendor credentials or signed delivery links. No storage or backend API
changes are needed.

## Verified API contract

The [official OpenAPI](https://jojapi.com/hub/api/cloud-api-hub-youtube-downloader/openapi.json) and
[marketplace documentation](https://jojapi.com/hub/api/cloud-api-hub-youtube-downloader)
were studied on 2026-10-01. One paid request is made per acquisition:

```http
GET https://wgvkv.jojapi.net/download?id=<youtube-video-id>&filter=audioonly&quality=highestaudio
X-JoJAPI-Key: <private-vendor-key>
Accept: application/json
Accept-Encoding: identity
User-Agent: MusicMute/1.0
```

JoJAPI documents two credits per `/download` call and links valid for six hours.
Credits and validity are vendor claims; a link is never persisted or reused by
this adapter. No `/info`, `/mux`, paid enrichment, FFmpeg, extraction runtime,
conversion, fallback or retry is performed. The paid GET can consume credits
even if download or backend validation later fails. Each new uncached
adapter execution is a new paid request. This adapter never automatically
resubmits a failed vendor call. The owner-authorized
[backend retry policy](../../docs/url-imports/retries-2026-10-01.md) can start up
to three additional executions for eligible transient pre-upload failures,
with fresh execution UUIDs and one vendor request in each execution.

Live qualification on 2026-10-01 observed valid JSON returned with
`Content-Type: text/html; charset=utf-8` by the vendor's nginx gateway. The paid
response accepts only `application/json` and this observed `text/html` media
type, still capped at 64 KiB and decoded as JSON before strict native-format
validation. Actual HTML/challenge pages, unknown types and malformed JSON fail
without executing content, starting media transfer or repeating the paid call.
This exception affects vendor acquisition only; the private API continues to
return correct problem JSON and audio MIME, and Google audio MIME is unchanged.

The response must be one format object with `vcodec: none`, `has_drm: false`,
`protocol: https` and native WebM/Opus or M4A/AAC. Arrays, wrapper objects,
video dimensions/codecs, DRM and unrecognized audio formats fail before media
transfer. Unknown descriptive metadata remains absent. The configured highest
audio preference does not guarantee bitrate or language. NestJS independently
probes actual media and enforces duration before accepting or storing it.

Google delivery is restricted to HTTPS `*.googlevideo.com`, the exact
`/videoplayback` path and nonempty query. Root hosts, credentials, ports,
fragments and alternate paths are rejected. Gateway redirects are rejected;
Google media may follow at most three CDN relocations (301/302/303/307/308),
each with exactly one Location revalidated against the same strict policy.
Loops, duplicate/missing Location headers, unsafe destinations and excess hops
fail. Initial and relocated URLs also reject exact runtime credentials, including
percent-encoded key reflection in the query. Legitimate media signatures remain
accepted. Every hop keeps the original deadline and sanitized media headers;
redirect bodies and response headers are never forwarded. Every DNS answer must be
public and is pinned for TLS with hostname verification. Bounded DNS threads
and deadlines prevent resolver accumulation. Media receives only bounded
`User-Agent`, `Accept`, `Accept-Language` and `Sec-Fetch-Mode` values provided by
the vendor plus `Accept-Encoding: identity`. A vendor-supplied `http_headers.Cookie`
is validated as a bounded request-cookie string and is kept only for the initial
exact Google media hostname. It remains unchanged across same-host relocations
and ranges, and is permanently stripped on a cross-host relocation. No cookie
jar, incoming caller cookie or vendor/Google `Set-Cookie` is imported. Cookie
values are request-local and never logged, persisted or returned to NestJS.
Other headers, including API keys, Authorization, Host, forwarded-IP headers
and vendor Range, are discarded. Control characters, duplicate case variants,
runtime credential reflection and invalid allowed-header values are rejected.

The adapter cannot make Google see the vendor's IP by sending an IP header.
Outbound connections use the VPS's real network egress. Matching the extraction
egress would require a documented provider media relay or a common supported
proxy; no such `/download` parameter is currently documented. The `/mux` endpoint
is documented as muxing/conversion and is not proof of an equivalent native
same-egress relay. No additional paid endpoint or proxy is enabled automatically.
The [request-context qualification](docs/REQUEST-CONTEXT-2026-10-01.md) records a
fresh 1 MiB VPS range probe, the different signed-IP parameter and real VPS IP,
the matched browser headers, absent vendor cookies and limitations.

When an exact provider `filesize` is present, media uses program-generated HTTP
Range spans of at most **10 MiB** (10,485,760 bytes), matching the provider's
published `downloader_options.http_chunk_size`. At the 100 MB hard cap this is
at most ten contiguous requests. Every 206 must supply one strict Content-Range
matching the requested start/end and exact advertised total, correct framing,
and exactly that many bytes. Gaps, overlaps, wrong totals, duplicate headers,
oversized or truncated spans fail without retry. All spans share the original
150-second deadline and global three-relocation budget; later spans reuse the
last validated CDN URL. Vendor-supplied Range is ignored.

If the first generated range is ignored with 200, the same response may deliver
one complete bounded file; no later span is appended. A later 200 or ambiguous
Content-Range on 200 fails before duplicate bytes are written. Without exact
provider size, one bounded full GET is retained and unrequested 206 fails.
Live qualification observed severe whole-file throttling, while a native Range
request for the same small file transferred it quickly. This transport behavior
does not establish immunity from Google blocking.

Content-Type must match the chosen native container; native WebM may be served
as `video/webm`. MIME alone is not evidence that a stream is audio-only, which
is why payload validation and the backend media probe both remain required.
Unknown types, compressed bodies, ambiguous framing, empty/truncated media,
oversized media and mismatches between declared and measured bytes fail.

## Capacity, metadata and cleanup

All published JoJAPI plans currently list **one request per second**. This adapter
caps paid starts at one per rolling second, with at least **1.1 seconds**
between starts as a conservative vendor timing margin, even when the router's shared
`ACQUISITION_REQUESTS_PER_SECOND` configuration is five. This is a provider plan
exception to the other adapters' five-start setting. DNS/TLS completes before
start reservation so connection delays cannot bunch requests. It supports twenty
concurrent acquisitions and up to sixty-four HTTP handlers. Capacity/rate waits
remain cancellable inside the original 150-second deadline, before paid work.
Sockets are limited to 25 seconds or the remaining operation budget.

A provider or Google media 429 applies a process-wide bounded Retry-After
cooldown; numeric and HTTP-date values are honored from one second to one day,
with a 60-second default. The failed execution is never replayed. Limits are
process-local: use one replica. Other uses of the same vendor key consume its
allowance too.

Hard request caps are 100,000,000 bytes and 1,800 seconds; lower caller limits
are honored. Duration is measured by NestJS. The existing shared scratch manager
reserves byte capacity plus 128 MB headroom before paid work. Anonymous temporary
files and reservations are released on success, failure and disconnect. CapRover
provides `/work` as a 2 GiB tmpfs and a 3 GiB memory ceiling; twenty maximum-sized
inputs plus headroom fit the scratch bound. Logs retain request UUIDs, safe
stages/status and numerical timings/bytes, never URLs, keys or raw payloads.

Optional schema-versioned metadata carries only actual sanitized `format_id`,
extension, codec, container, language, bitrate, sample rate, audio channels and
provider-declared bytes. Metadata strings reject JoJAPI credential markers.
The bounded optional official YouTube oEmbed lookup can add title/channel with
no API key or paid calls; it never delays or fails audio delivery. Its module
uses the qualified provider implementation with an additional `jk_` credential
marker filter. Missing metadata stays absent.

## Private CapRover deployment

Create `music-mute-jojapi` with web exposure disabled, no published ports/domains,
one replica and container port 8080. Apply `caprover-override.json` to keep the
non-root container read-only with dropped capabilities, bounded memory/CPU,
dedicated scratch and bounded logs. The adapter has no MongoDB, R2 or Firebase
credentials. Its private service is
`http://srv-captain--music-mute-jojapi:8080/`.

Runtime settings:

| Setting                             | Purpose                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `JOJAPI_API_KEY`                    | Vendor key exclusive to this app's private runtime environment. |
| `AUDIO_ACQUISITION_API_KEY`         | Separate internal service bearer shared with the router.        |
| `ACQUISITION_TEMP_ROOT=/work`       | Dedicated ephemeral scratch.                                    |
| `ACQUISITION_CONCURRENCY=20`        | Active capacity, maximum twenty.                                |
| `ACQUISITION_REQUESTS_PER_SECOND=1` | Vendor paid-start ceiling, clamped at one even if set to five.  |

The pre-deploy hook reads only the private acquisition bearer key from
`/captain/data/musicmute-acquisition/jojapi-api-key`. Keep the vendor credential
in this app's CapRover environment. The hook, configuration, tests, docs and
secrets are excluded from the image archive. Never save real keys in this folder.

From this directory:

```sh
python3 -B -m unittest -v test_service.py test_official_metadata.py
python3 -B package_caprover.py /tmp/musicmute-jojapi.tar
caprover deploy -n musicmute -a music-mute-jojapi -t /tmp/musicmute-jojapi.tar
```

The packager allowlists exactly `captain-definition`, `Dockerfile`,
`.dockerignore`, `service.py`, `official_metadata.py`, `acquisition_limits.py`
and `acquisition_scratch.py`, byte-verifying the final archive. Shared helpers
are packaged by basename from the parent provider directory. Deployment requires
user authorization. Root orchestration also checks private routing and the
backend's existing generic validation path.

The optional `live-acquisition.mjs` qualification script uses the real backend
acquisition client and media probe. It is excluded from the image archive and
requires a private runtime with the internal acquisition key. Supply vendor
keys only through runtime configuration; never paste them into command arguments
or save them in a script. It reports safe stage/status/numeric evidence and
cleans up acquisition scratch after every attempt. Root deployment orchestration
controls bounded attempt counts and concurrency; a failed import is not replayed.

Local tests establish contract, framing, cleanup, admission and security behavior
with synthetic media. They do not establish live Google IP blocking, quota,
worker/R2 success or production availability. A successful live sample supports
only that source, egress IP and time; it cannot guarantee future absence of
Google throttling or blocking. Record live qualification separately and never
save signed URLs, provider raw responses or real user audio as evidence.

## API guideline preflight

The [current official Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-10-01. This component keeps the existing private OpenAPI and
service bearer security (104), HTTP method semantics (148), backward-compatible
private contract (106), sanitized problem JSON without stack traces (176/177)
and bounded Content-Type/Content-Length headers (178). Upstream 429 maps to the
existing private 503/Retry-After dependency contract. Zalando-specific registries
and naming conventions do not apply. A paid vendor GET remains non-replayable.
