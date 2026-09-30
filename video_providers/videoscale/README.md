# VideoScale private audio acquisition

All provider-specific implementation, tests, deployment configuration and dated
evidence live here. NestJS has a provider-neutral client only.

`VideoScale → private adapter → NestJS validation → private R2 → existing worker`

## Contract and limits

See [OpenAPI](openapi.yaml). `POST /audio-imports` accepts `url`, `max_bytes`
(up to 100 MB decimal), and `max_duration_seconds` (up to 1800). It returns measured
binary audio with optional `X-Import-Extra-Data-Base64` metadata. Only public,
single-item links are enabled for YouTube, Instagram (including Reels), TikTok,
Vimeo, SoundCloud and Facebook (including Reels), plus the existing catalog's
Bandcamp, Mixcloud, hearthis.at, Clyp, Vocaroo and Whyp item shapes.
Only YouTube has recorded live end-to-end proof; other sites are enabled for
per-link provider evaluation, not guaranteed to offer separate audio. Preference is
audio-only WebM/Opus, then MP3, then M4A/AAC; video and DRM are rejected.
Format IDs are selected from each response, never hardcoded to `140`. A missing
or ineligible preferred format does not prevent choosing another eligible one.
Missing/null bitrate or channel-count metadata is allowed as a fallback; explicit
invalid values, advertised bitrate above 160 kbps or more than two channels still
exclude a candidate. Within each container preference, complete metadata ranks
first, then non-DRC and bitrate. Unknown metadata is omitted, not invented. Actual codec, single-audio
stream, byte count and duration are independently checked by NestJS. Missing
quality metadata does not establish a measured bitrate/channel guarantee.
No local extraction runtime, conversion, or paid enrichment is used. Optional
official oEmbed lookup supplies title/creator independently of audio acquisition.
Provider-managed HLS/DASH formats and AAC-HE are eligible alongside HTTPS audio;
MusicMute never fetches their manifests or fragments. The final file must still
arrive over the pinned HTTPS delivery host and pass independent validation.
The provider does not report reliable duration before acquisition; **NestJS must
probe and enforce duration before uploading or creating a processing job**.

The adapter selects a format, submits once, waits for `status: completed`, obtains
the delivery URL, and downloads it. It never treats progress 100 as completion.
Only the observed Scaleway storage host is allowed; its returned HTTP URL is
upgraded to HTTPS. All TLS certificates are verified. Public DNS answers are
validated and pinned per connection; redirects and credential forwarding are
disabled. A new provider delivery host requires qualification and adapter update.

Up to twenty acquisitions at a time, sixty-four bounded HTTP handlers,
25-second upstream socket timeouts and a 600-second operation deadline. Busy
slots wait cancellably within the original operation deadline before any
upstream request. Excess imports remain in the backend's durable queue until
active capacity is available. There is **no automatic POST retry**: the
provider has no verified idempotency/cancellation API. Cancellation stops local
work, but already-submitted SaaS work may still consume provider quota.

Cost boundary: at most one task-creation POST per import execution, not one
charge per URL forever. WebM → MP3 → M4A is pre-submission format selection,
not paid fallback after a task fails. Status GETs reuse the accepted task and
the audio file is fetched once, without automatic media-transfer retries.
NestJS deduplicates the same owner/request ID, atomically claims queued imports,
uses one queue attempt and does not reacquire on stalled-execution recovery.
A new user request ID (including manually starting over with the same URL) may
create another billable task. Vendor billing of GETs, failed/cancelled tasks,
cached tasks and provider-internal retries is not verified; do not equate one
outbound POST with a guaranteed invoice amount. Use an existing Library item
instead of importing it again when possible.

A returned task's status-only 404 response has a ten-second propagation grace.
Its read-only retries wait 1/2/3/4 seconds within the shared four-retry budget;
each retry resumes immediately after its wait without an extra pending-state
pause. This never resubmits the acquisition. An observed `already_exists` response is
handled using its returned task ID and the same completed-state checks.

Read-only calls retry transient 500/502/503/504 and selected transport failures
at most twice (1s/2s backoff). An unsupported/empty format list is rechecked once,
without relaxing audio-only, DRM, known-quality or size checks. All read retries,
including fresh-task 404 grace, share a four-retry operation budget, cancellation
checks and the existing deadline. 401/403/429, invalid JSON, oversized
audio, media-byte transfers and paid POST requests are not automatically retried.

Vendor JSON GETs reuse one verified connection during a single acquisition,
only after a complete, valid response has been drained. Server-close responses,
transport failures, malformed/truncated responses and cancellation discard it.
Transport/HTTP failure retries use a fresh connection with the existing bounds. The
paid POST always uses an isolated fresh connection and is never replayed. The
retained read connection closes before audio transfer and on every exit;
imports do not share connections. Storage transfer stays separate and receives
no vendor credentials. Normal pending/unknown status checks still wait two
seconds. This reduces repeated connection setup, not provider extraction time.

Unrecognized/missing task-state fields in a JSON object are inconclusive, not
proof of an unavailable source. Recheck the same task after two seconds for at
most 60 seconds from the first unknown state or 30 rechecks, independently of
the four transient HTTP read retries; only explicit `completed` permits delivery.
The global deadline and cancellation still apply. Exhaustion returns
`IMPORT_DEPENDENCY_FAILED`; explicit failed/cancelled states
still stop immediately. Non-object/invalid JSON remains a protocol failure.
Safe `task_status_shape` distinguishes missing, invalid type, literal `unknown`
and other strings without logging their raw content. No task is resubmitted.
See [the deployed follow-up](docs/STATUS-WEBM-FIX.md) for evidence and release status.

Internal `X-Import-Request-ID` correlates backend execution and adapter logs.
Logs contain human-readable step/reason messages, phase, numeric HTTP status,
allowlisted task status, poll/retry counts, format rejection counts, sanitized
selected-format metadata and timing. Unexpected exceptions include only type and
adapter code line, not exception text, stack locals, URLs, bodies or credentials. See
[failure recovery and diagnostics](docs/IMPORT-RELIABILITY.md).
Each vendor request and storage transfer logs `request_duration_ms`,
`response_headers_ms` and `reused_connection` beside its stage. The first two
measure elapsed time through completion/failure and through response headers
(null if no headers arrive). They include connection setup and pre-submission pacing, exclude local
retry/polling waits and never
contain request URLs or bodies.
See [latency investigation](docs/PERFORMANCE.md) for measured baseline and the
boundary between local optimization checks and live release proof.

## Shared acquisition capacity

The router and both adapters use one shared limit implementation with the same
generic configuration: `ACQUISITION_CONCURRENCY=20` and
`ACQUISITION_REQUESTS_PER_SECOND=5`. The router enforces active capacity
across providers. This adapter also waits before the first paid task-creation
POST until its rolling one-second allowance is available. DNS/TLS connection
completes before reserving the paid start, preventing connection delays from
bunching requests at the provider. Read-only status
polling does not consume paid-start reservations. A vendor 429 applies an
in-memory cooldown honoring bounded Retry-After while the failed task remains
failed; it is never resubmitted. Capacity, rate and cooldown waits check
cancellation and the original deadline every 100 ms.

The same settings apply to Tunelio and VideoScale; no provider-specific
capacity knobs exist. Five starts per second differs from twenty concurrent
downloads: the first twenty start in paced groups, then finished downloads free
slots. Configure the providers' paid allowances to support these limits before
deployment. Local tests do not establish VideoScale's account-wide allowance;
its own limits and other uses of the credentials remain authoritative.

## Included metadata

MongoDB `audio_jobs.extra_data` is nullable, server-written, sanitized, and not
added to public job projections. No migration or old-provider fallback is included. Retries
preserve it. Native uploads/missing metadata use null. Allowed fields:

- `schema_version: 1`, `provider`, `site`, `format_id`, `extension`, `audio_codec`,
  `container`, `language`, `bitrate_kbps`, `sample_rate_hz`, `audio_channels`,
  `provider_file_bytes` (advertised, not authoritative).
- Backend-measured `duration_seconds` and `file_bytes` when included metadata exists.
- Bounded `title` and `channel` can come from official oEmbed lookup. VideoScale's
  observed responses do not include these fields. Other descriptive fields are
  only accepted when included, never through paid enrichment.

An included sanitized `title` also supplies the import/job source title. Metadata
uses only this structured header; no separate title-header protocol is supported.

Metadata headers are capped at 4096 characters. Unknown fields, raw responses,
URLs, headers and recognizable credentials are discarded. Admission always uses
measured audio, never advertised metadata. Missing/invalid metadata does not fail
an otherwise valid import or trigger another provider request.

### Optional official metadata

`official_metadata.py` supports YouTube, canonical TikTok video URLs, Vimeo and
SoundCloud track URLs through fixed official oEmbed endpoints. Instagram,
Facebook, shortened TikTok/SoundCloud links and other sites skip metadata;
audio support is unchanged. No scraping, yt-dlp, new API keys or paid API calls.
Titles/creator names are sanitized into the existing header; NestJS already
persists them in `extra_data` and uses `title` as the source title.

Lookup runs beside acquisition, with no waiting before audio delivery. One daemon
lookup maximum, three-second socket/elapsed budgets, 64 KiB JSON cap, pinned
public TLS DNS, no redirects, no credentials, no retries. A stalled OS DNS lookup
can occupy that one metadata slot but cannot block audio or spawn more workers.
In-memory cache: at most 128 entries, one-hour success and one-minute miss TTL;
403/429 impose a host cooldown (numeric Retry-After honored up to one day;
otherwise one hour). No metadata files or persistent storage are created.
If audio finishes before lookup, this import omits the title; a later import may
use the cache. No background MongoDB writes or historical-job backfill.
See [implementation and verification](docs/OFFICIAL-METADATA.md).

## Configuration and deployment

Create CapRover app `music-mute-videoscale` as **not exposed as a web app**, with no
host port mapping or public domain, one replica. Apply `caprover-override.json`:
non-root read-only container, dropped capabilities, 2 GiB tmpfs, 3 GiB memory,
one CPU, and bounded logs. No persistent media volume.
The new scratch size fits twenty maximum 100 MB files plus 128 MB headroom.
Tmpfs consumes RAM as used; the memory cap is not a memory reservation.
Apply this override with the release; the previous small resource limits
cannot support twenty large concurrent files.

Set private runtime `AUDIO_ACQUISITION_API_KEY` and `VIDEOSCALE_BASIC_AUTH`.
Never put actual credentials into files here or deployment archives. NestJS uses
`AUDIO_ACQUISITION_API_URL=http://music-mute-videoscale:8080/` and the matching
`AUDIO_ACQUISITION_API_KEY`. It never receives SaaS credentials. A replacement
adapter implementing this contract can be deployed and selected through these
two generic settings without editing NestJS code.

Set `ACQUISITION_CONCURRENCY=20` and
`ACQUISITION_REQUESTS_PER_SECOND=5` identically in the router and both adapters
(these are also the shared defaults, with ranges 1–20 and 1–5 respectively).
`ACQUISITION_TEMP_ROOT` defaults to `/work`. Each private service keeps one
replica so that in-memory capacity, pacing and cooldown bounds remain valid.

Adapter scratch files are anonymous/unlinked TemporaryFile handles; success,
failure, disconnect, process death and container recreation reclaim them. Tmpfs
provides a hard media-storage bound. NestJS retains its existing dedicated scratch
directory, byte limits, deadline/finally cleanup, free-space checks and orphan
sweeper. Disk usage cannot be promised literally zero: logs/images and unrelated
services still need operational retention policies.
Before any provider request, the adapter atomically reserves the request's
maximum bytes against current free space, outstanding reservations and the
128 MB headroom. Flushed writes reduce outstanding reserved bytes; this avoids
counting already-written files twice. All reservations release on exit.

From this directory:

```sh
python3 -m unittest -v test_service.py test_official_metadata.py
python3 -B package_caprover.py /tmp/musicmute-videoscale.tar
```

Upload the allowlisted tar through CapRover Deployment. Only seven files enter the
byte-verified archive: captain-definition, Dockerfile, .dockerignore, service.py,
official_metadata.py and shared acquisition_limits.py/acquisition_scratch.py
(sourced from the parent directory and bundled by basename).
Run backend `pnpm run verify`, `pnpm run test:imports:integration` and
`pnpm run test:processing:integration` before releasing. Keep release proof in
[TASKS.md](TASKS.md) and [deployment evidence](docs/DEPLOYMENT.md).

[Research and API qualification](docs/README.md) predates implementation. No
availability SLA, unlimited requests or guaranteed immunity to YouTube blocking
is implied by this integration.

For this capacity change, the current
[official Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-09-30. The private bearer contract and measured binary headers
remain compatible under rules 104, 148, 176, 177, 178 and 106; OpenAPI describes
the new bounded pre-submission waits. Local tests do not establish deployment.
