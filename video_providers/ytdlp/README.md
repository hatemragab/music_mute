# Private yt-dlp YouTube audio adapter

This owner-requested adapter downloads native YouTube audio through DataImpulse.
It is deployed privately; [dated deployment evidence](docs/DEPLOYMENT-2026-10-03.md)
records qualification and activation status. NestJS and the private
router keep their provider-neutral contract; only this adapter receives proxy
credentials. Existing SaaS adapters remain available as separately selected routes.

## Acquisition behavior

- Public single-item YouTube only. Reject playlists (including watch URLs with
  `list`), channels, searches, ongoing/upcoming live streams, private sources and
  sources requiring account cookies before media transfer.
- Extract once per attempt, validate the requested video ID, and select only
  original-track native audio with no video codec. Prefer WebM/Opus format 250,
  YouTube's usual medium tier around 70 kbps; then other native WebM/Opus tiers;
  then AAC/M4A. IDs and bitrates vary, so selection also checks actual codec,
  extension, bitrate and track metadata. Never convert audio to obtain a tier.
- Only native HTTPS Google media audio is eligible. Reject DRM, combined video,
  manifests, fragments and known tokenless formats. No video extraction fallback,
  FFmpeg, repair, merging, transcoding, external downloader or postprocessor.
- A failed format uses the same extracted metadata and sticky proxy to try another
  eligible audio format. No overlapping retry loops or parallel fragments. Media
  bytes received across all format candidates share the caller's byte ceiling;
  failed partial files are removed. Sequential native ranges are at most 10 MiB.
- NestJS owns at most four executions: attempts 1–3 use Residential and attempt 4
  uses Mobile. Each execution has a fresh leased sticky port and at most 30 seconds
  after adapter admission. A durable first-acquisition timestamp limits the whole
  acquisition to 120 seconds, including retry backoff and later admission waits.
  Initial backend queue time and worker processing are excluded. The final Mobile
  attempt can therefore have less than 30 seconds. Socket waits are five seconds.
- Transient pre-upload failure returns a sanitized 503 with `Retry-After: 1`.
  NestJS retains the same import, trim, recipe and usage hold. Exhausted time returns
  terminal `IMPORT_ACQUISITION_EXHAUSTED`; permanent source/validation failures
  remain terminal. Upload or job recovery never starts another acquisition.
- Ten acquisitions can overlap; at most two new starts per rolling second.
  Scratch reservation and cancellation checks precede proxy traffic. The adapter
  leases separate ports under a lock and quarantines them for the sticky TTL.
  This guarantees separate session endpoints, not distinct provider exit IPs.

Unavailable, removed, private, blocked or unsupported sources can still fail.
Retries cannot guarantee availability. Known format absence is handled through
native audio fallback rather than downloading video.

## DataImpulse settings

Apply the same session settings to both plans, with separate plan credentials:

| Setting                         | Initial choice                            | Reason                                                                  |
| ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| DNS hostname                    | Enabled; `gw.dataimpulse.com`             | DataImpulse selects a nearby gateway.                                   |
| Type                            | **Sticky**                                | Extraction, token generation and media must share an attempt's proxy.   |
| Protocol                        | **HTTP/HTTPS**                            | Native yt-dlp HTTP proxy transport; HTTPS destinations use CONNECT.     |
| Rotation interval               | **30 minutes**                            | Port quarantine matches `sessttl.30`; attempts last at most 30 seconds. |
| Ports                           | **10000–20000**                           | The adapter allocates a fresh sticky port for each attempt.             |
| Anonymous filter                | **Off initially**                         | Do not narrow the pool without qualification evidence.                  |
| Exclude ASN                     | **Empty initially**                       | Add exclusions only after repeated measured failures for a known ASN.   |
| Country                         | Unrestricted initially                    | Qualify latency and availability before narrowing geography.            |
| State/city/ZIP/ASN targeting    | Off                                       | DataImpulse documents doubled traffic charges for Target Filter.        |
| Export format in the screenshot | `protocol://login:password@hostname:port` | Standard proxy URI; credentials are encoded by the adapter.             |

Do not configure rotating port 823 for this adapter: rotating every HTTP request
can change the exit between extraction and media. Do not paste an exported proxy
URI into NestJS, client code or router configuration. Set the separate login and
password fields privately in the adapter environment. Existing operator login
parameters are preserved, with `sessttl` replaced by the adapter's configured TTL.

DataImpulse sticky sessions are best effort: a peer can disappear before its TTL,
and separate ports can select the same exit IP. Failed attempts acquire new ports;
the adapter does not pay for a separate IP lookup on every download. Account Plan 1
traffic balance and pricing must be checked in the account, not inferred from
public pricing. See [connection types](https://docs.dataimpulse.com/proxies/types-of-connections),
[connection hosts](https://docs.dataimpulse.com/proxies/connection-hosts),
[anonymous filtering](https://docs.dataimpulse.com/proxies/parameters/anonymous),
[targeting billing](https://docs.dataimpulse.com/proxies/targeting), and
[sticky session drops](https://help.dataimpulse.com/en/articles/15930965-sticky-session-drops-proxy-disconnects-mid-session).

## Deno, EJS and Proof of Origin tokens

The runtime pins yt-dlp 2026.08.19, yt-dlp-ejs 0.8.0 and bgutil provider 2.0.1
using wheel hashes. Its immutable bgutil Deno image supplies Deno 2.9.5 and locked,
cached server dependencies. Deno is the only JavaScript runtime selected by
yt-dlp; EJS is bundled and remote EJS component fetching is disabled.

A persistent private bgutil HTTP token provider runs on loopback port 4416. Its
plugin receives the attempt's proxy, so token preparation uses the same sticky
session as extraction and transfer. Only this HTTP provider is enabled; script
provider fallback is removed from each isolated yt-dlp child's registry. No
manually pasted tokens, browser cookies or public token service are used.

The image applies a deterministic, source-hash-checked patch to bgutil 2.0.1:
five-second upstream network timeouts, one upstream attempt, no nested sleep/retry,
a bounded 128-entry proxy minter cache, and serialized global BotGuard
configuration/snapshot work with per-challenge configuration capture. Network
fetch and audio transfer remain parallel. The Deno provider has a bounded V8 heap.
Requalify these patches when changing the pinned upstream version.

Bootstrap validates installed versions and bundled EJS, starts Deno with frozen
cached dependencies, checks the provider version, and fails closed if either
service exits. Provider logs are discarded because third-party diagnostics can
contain proxy credentials. Tokens and proxy sessions stay in process memory.
PO tokens address YouTube integrity requirements; they do not guarantee that an
exit IP is accepted. See [yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS),
[PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide), and
[bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider).

## Private HTTP boundary and data safety

See [OpenAPI](openapi.yaml). `POST /audio-imports` accepts only `url`, `max_bytes`
and `max_duration_seconds`; maximums are 100,000,000 bytes and 1,800 seconds.
The optional trusted header trio carries attempt ordinal, maximum attempts and
the immutable first-acquisition timestamp. Missing all three permits one legacy
execution, with no hidden retry loop; partial, duplicate or malformed context
is rejected. Bearer service authentication is required. `GET /health` checks the
process, not paid provider availability.

The response is unchanged native `audio/webm` or `audio/mp4`, with measured exact
`Content-Length`, no redirect and optional sanitized metadata. NestJS counts and
hashes the transfer, probes audio/duration and uploads to private R2 through the
existing shared-media flow. FFmpeg processing belongs to the existing worker.
No provider URL, token, raw extractor payload, proxy IP or credential is returned.

Proxy secrets enter the isolated extractor via an anonymous stdin pipe, never
arguments or files. Ambient credentials/proxies are removed from its environment.
The entire process group is stopped at deadline/disconnect; request scratch is
removed on success or failure. A token operation already submitted to the
persistent provider may finish after its caller disconnects; its network steps
remain bounded but full internal cancellation is not guaranteed.
Responses and logs use stable sanitized codes.
Logs correlate `X-Import-Request-ID` with extraction, token-generation and transfer
timings. Extraction timing excludes the measured token-provider wait; backend
validation/upload and worker timings remain separately measured.

Each request log also records the last observed phase, the sticky port (not its
exit IP), eligible format count and numeric native format/codec facts when known.
Failures retain partial timings and allowlisted reasons such as
`attempt_deadline`, `network_timeout`, `http_forbidden`, `http_rate_limited` and
`no_native_audio`, with numeric upstream HTTP status/errno and known exception
types when available. `upstream_phase` identifies a failed network operation that
an extractor subsequently wrapped or swallowed. A recovered format failure can
appear alongside `result: completed`; `format_attempt` identifies the final
candidate. These diagnostics never change the generic private HTTP response.
Raw exception messages, stack traces, URLs, video IDs, titles, proxy credentials,
cookies and tokens are excluded. Log writes are serialized so concurrent requests
cannot concatenate JSON records.

The isolated child sends only allowlisted phase updates over its existing anonymous
stdout pipe. This lets the parent retain the last observed extraction/token/transfer
phase when the hard deadline kills the process group. There are at most 64 updates
of 1 KiB each, an 8 KiB final result and a 72 KiB total protocol ceiling; malformed
or excessive output fails closed. Third-party stdout/stderr remain discarded.
This is diagnostic transport, with no additional acquisition or retry loop.

## Configuration and deployment

[config.example.json](config.example.json) describes the private app and secret
names; [.env.example](.env.example) contains empty placeholders only. Configure
`AUDIO_ACQUISITION_API_KEY` with 32–256 URL-safe ASCII characters. The Residential
and Mobile login/password pairs are required. Never commit real environment files.

The deployment override uses one private replica, no published ports, a read-only
filesystem, 2 GiB dedicated scratch, a 4 GiB memory ceiling and two CPU cores.
Scratch accounting conservatively reserves each whole maximum while child writes
are active. Capacity limits are ceilings; they are not host-capacity proof.
Only the router should call `http://srv-captain--music-mute-ytdlp:8080` with this
adapter's separate bearer key. Set its YouTube URL/key pair when activation is
explicitly authorized. Keep generic NestJS settings pointed to the router.

Package the allowlisted source without secrets or tests:

```sh
python3.12 -B video_providers/ytdlp/package_caprover.py /tmp/music-mute-ytdlp.tar
```

Do not activate the candidate before container build/start qualification and
bounded real-proxy source-identity, throughput, concurrency and billing checks.
The owner authorized app creation, private credential configuration and deployment
on 2026-10-03. The dated record distinguishes live proof from fixture coverage.

## Local verification, 2026-10-03

Run with the pinned Python requirements installed in a disposable environment:

```sh
python3.12 -B -m unittest discover -s video_providers/ytdlp -p 'test_*.py' -v
python3.12 -B -m unittest discover -s video_providers/router -p 'test_*.py' -v
python3.12 -B -m unittest discover -s video_providers -p 'test_acquisition_context.py' -v
python3.12 -B -m unittest discover -s video_providers/tests -v
```

Core tests use synthetic HTTP responses with the real pinned native downloader;
routing tests create/probe local native Opus fixtures using local FFmpeg/ffprobe.
Fixture generation does not add FFmpeg to the deployed adapter. Provider patch
tests execute patched TypeScript with host Deno and mocked network/VM dependencies.
These tests establish local behavior, not YouTube, DataImpulse, source identity,
production capacity, R2/worker delivery or a built container. Docker is unavailable
on the development host; container build/start was subsequently verified on the
deployment server, as recorded separately in the dated evidence.

To reproduce the offline provider concurrency fixture in a disposable checkout,
install its pinned upstream dependencies first, then deny runtime network access:

```sh
provider_qualification_dir="$(mktemp -d)"
git clone --depth 1 --branch 2.0.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$provider_qualification_dir/bgutil"
python3.12 -B video_providers/ytdlp/patch_provider.py "$provider_qualification_dir/bgutil/server/src/session_manager.ts"
cp video_providers/ytdlp/test_provider_runtime.ts "$provider_qualification_dir/bgutil/server/"
cd "$provider_qualification_dir/bgutil/server"
deno install --frozen --allow-scripts=npm:canvas
deno check --cached-only --frozen src/main.ts
deno run --cached-only --frozen --no-check --deny-net --allow-env --allow-read=./node_modules --allow-ffi=./node_modules --v8-flags=--max-old-space-size=384 test_provider_runtime.ts
```

Local native Deno checks used host version 2.9.7; the image pins 2.9.5. The
offline fixture verifies ten parallel challenge fetches, one isolated VM snapshot
at a time, five-second transport timeouts, no nested retries and bounded cache.

API preflight read the [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-03. Rules 104, 106, 118, 176, 177 and 178 apply: documented compatible
private headers, service authentication, sanitized problem responses and bounded
binary content headers.
