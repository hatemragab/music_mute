# Observed API behavior

Verified with curl on 2026-09-27. Public source: Blender Big Buck Bunny,
`https://www.youtube.com/watch?v=aqz-KE-bpKQ`. Only separate audio was requested.
No MP3 conversion or video download was requested.

## Authentication and origin

The signed-in documentation specifies `https://gate.apiscrape.net:16262` and HTTP
Basic authentication, not a Bearer token. Credentials were taken from the user's
signed-in docs with explicit permission and used in memory. Authorization was
passed to curl through stdin configuration, not a URL or command-line argument.
Never forward this Authorization header to object storage or redirected hosts.

## 1. Format discovery

`GET /api/formats?video_url=<percent-encoded-source-url>` returned HTTP 200 in
6.753 seconds, with a top-level array of 65 format objects (158,803 response bytes).
This is not a top-level video metadata object.

Selected observed audio fields:

| Field                                 | Meaning / caveat                                                            |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `format_id`                           | Actual response key is lowercase; choose from this response.                |
| `vcodec`                              | Require `none`; that alone is insufficient because storyboards also use it. |
| `acodec`                              | Require a known compatible audio codec, not missing or `none`.              |
| `ext`, `container`                    | M4A/AAC and WebM/Opus options were present.                                 |
| `abr`, `asr`, `audio_channels`        | Bitrate, sample rate and channel count; values can be null/missing.         |
| `filesize`, `filesize_approx`         | Both occurred; neither replaces actual byte counting.                       |
| `language`, `has_drm`, `protocol`     | Useful selection constraints; not universally populated.                    |
| `url`, `manifest_url`, `http_headers` | Provider internals; do not log or directly use these YouTube links.         |

The response contained NO `title` or `duration` keys on format objects and no
top-level title, duration, thumbnail or channel metadata. No undocumented metadata
endpoint was guessed or probed. Fragment durations are not an authoritative
replacement for media duration. The linked Postman collection was access-restricted.

For this test, format `140` advertised AAC, M4A, 129.481 kbps, 44,100 Hz, two
channels, no video, and 10,271,496 bytes. That ID is an observed selection, not a
universal hardcoded choice for a future adapter.

## 2. Create an audio task

`POST /api/download`, authenticated, with JSON:

```json
{
  "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "format_id": "140"
}
```

Returned HTTP 202 in 0.474 seconds:

```json
{
  "format_id": "140",
  "proxy_service": "youtube",
  "site": "youtube",
  "status": "queued",
  "task_id": "00000000-0000-4000-8000-000000000001"
}
```

The task ID above is synthetic. The optional `postprocessors` from the docs were
omitted. Acceptance is not completion, and retrying an uncertain POST could create
duplicate billable work. No idempotency key or cancellation contract was documented.

## 3. Status

`GET /api/status/{task_id}`, tested WITH authentication, returned:

```json
{ "progress": 100.0, "site": "youtube", "status": "processing" }
```

Later it returned `status: completed`, `progress: 100`, and a RELATIVE
`download_url` of `/api/download/{task_id}`. Wait for completed, not percentage 100.
Resolve this relative path only against the configured API origin. The docs' curl
example omits authentication here; unauthenticated status behavior was not tested.
Polling timestamps were not recorded precisely enough to claim task processing latency.

An authenticated request for the all-zero nonexistent task ID returned HTTP 404:

```json
{ "error": "Task not found" }
```

## 4. Resolve final delivery

`GET /api/download/{task_id}`, authenticated, returned HTTP 200 JSON containing
only `download_url`, rather than binary audio or additional metadata.

The observed destination was Scaleway object storage, `s3.fr-par.scw.cloud`,
with an AWS-style signed query (`X-Amz-Expires=3600`). This is an observed one-hour
signature lifetime, not a published guarantee of retention or renewability.

IMPORTANT: the returned URL used **HTTP**, not HTTPS. The diagnostic refused to
fetch it unchanged. Upgrading only the scheme for that exact verified host/path
preserved the signature and succeeded over HTTPS from the VPS. Never apply blind
scheme rewriting or accept arbitrary returned hosts; qualify the provider's
HTTPS delivery policy and retain SSRF/redirect protections in implementation.

The download required no VideoScale authorization header. Its signed URL is a
temporary bearer capability and must not appear in logs or repository fixtures.

## 5. Actual artifact

- Exact downloaded size: **10,264,232 bytes**, different from format discovery.
- One stream: AAC audio, 44,100 Hz, two channels, 127,999 bits/s.
- Container: M4A (FFprobe's MOV/MP4 family).
- Duration: **634.625 seconds**, measured locally on the downloaded file.
- No embedded title or artist was returned by the probe.
- Full FFmpeg decode succeeded; no conversion was performed by MusicMute.

Do not claim byte-for-byte preservation or absence of provider-side remuxing:
the payload differs in size from the advertised source representation. A full
decode was diagnostic proof, not a decision to add another production decode.

## Still unknown

Per-stage bandwidth charging, failed-task charging, concurrency/rate limits,
provider cancellation, idempotency, retention, link renewal, error taxonomy,
title/duration retrieval before acquisition, and sustained success rate. A 401
from the API without credentials was verified from the VPS; all authenticated
API-control requests in this study originated on the Mac.
