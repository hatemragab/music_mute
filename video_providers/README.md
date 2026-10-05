# Audio acquisition providers

URL imports use private audio acquisition adapters. The private
[router](router/README.md) sends YouTube items to [yt-dlp](ytdlp/README.md)
and other enabled items to [VideoScale](videoscale/README.md). The
[2026-10-03 deployment record](ytdlp/docs/DEPLOYMENT-2026-10-03.md) distinguishes
live native-audio, retry and concurrency proof from remaining verification.
[Tunelio](tunelio/README.md) remains deployed without automatic fallback. The
historical JoJAPI source-version mismatch remains unresolved; its
[earlier qualification record](jojapi/docs/DEPLOYMENT-2026-10-01.md) does not
establish requested-source identity. Each provider owns
its source, tests, configuration and documentation under
`video_providers/<provider>/`.

The owner-requested yt-dlp adapter uses Deno, bundled EJS, a persistent private
PO Token provider and DataImpulse sticky Residential/Mobile sessions. It downloads
original native audio without video or adapter FFmpeg processing. Credentials stay
exclusive to the adapter; there is no device extraction path.

## Request and file flow

1. Clients submit an authorized URL import to NestJS through `POST /media-imports`.
   Existing realtime snapshots report progress; clients never call the source provider.
2. NestJS's `AudioAcquisitionClient` calls the private router's
   `POST /audio-imports` with `url`, `max_bytes`, `max_duration_seconds`
   and a shared service bearer key.
3. The router selects one adapter before acquisition. The adapter handles provider
   authentication, audio-only format selection, any bounded status checks and
   HTTPS delivery. It returns audio bytes, not a provider delivery URL. Neither
   the router nor the adapters automatically resubmit or switch providers after
   an acquisition failure.
   The yt-dlp adapter uses NestJS's existing bounded pre-upload retries, carrying
   generic trusted attempt/deadline headers through the router. Residential/Mobile
   selection remains inside that adapter; NestJS has no proxy/vendor branches.
4. NestJS counts/hashes the transfer into bounded temporary storage, probes
   audio and enforces duration/size, then uploads the validated input to private
   R2 and confirms the normal processing job.
5. The existing worker retrieves the R2 input using its normal grant and produces
   the output. Neither clients nor workers receive SaaS credentials or URLs.

The [private OpenAPI contract](videoscale/openapi.yaml) is provider-neutral.
Each adapter and the router document this same boundary. Keep request fields, binary
responses, structured metadata and sanitized error semantics consistent across
adapters. Do not introduce provider-specific branches in NestJS business logic.

## Metadata and cleanup

Prefer metadata already included in acquisition; optional official oEmbed
lookups may fill missing title/creator fields without paid enrichment. They run
inside the adapter, never fail or delay audio delivery, and never repeat paid
acquisition. The optional bounded `X-Import-Extra-Data-Base64` header carries
schema-versioned JSON. NestJS allowlists fields into nullable
`audio_jobs.extra_data`, adds measured size/duration when metadata exists and
uses an included sanitized `title` for the source title. Missing metadata is
null. Never store raw payloads, secrets or delivery URLs.

The adapter uses bounded temporary storage and cleans up success, failure and
disconnect paths. NestJS retains transfer caps, free-space checks, deadlines,
`finally` cleanup and an orphan sweeper. R2 inputs/results are intentional
retained objects under account lifecycle policy, not VPS scratch.

## Configuration and provider replacement

NestJS has only `AUDIO_ACQUISITION_API_URL` and
`AUDIO_ACQUISITION_API_KEY` for provider access. Its URL points to the private
`music-mute-audio-router` service. The router has separate URL/key pairs for the
YouTube and other-site adapters; it never receives vendor credentials. DataImpulse
credentials belong only in `music-mute-ytdlp`. The JoJAPI
key belongs only in `music-mute-jojapi`; the VideoScale credential remains only
in `music-mute-videoscale`. Run the router and adapters as private CapRover apps without public
exposure or published ports. The adapters and router have no MongoDB, R2 or
Firebase credentials.

To change vendors, implement and test another adapter against the same private
contract, deploy it privately, then update the router's appropriate URL/key pair.
A raw vendor API URL is not a drop-in replacement.
No backend business-logic changes are needed for a contract-compatible adapter.
Do not automatically replay paid submissions or fail over after ambiguous
creation responses: that can double-charge.

The owner requires a clean implementation without compatibility aliases,
migration bridges or device-side/server-side extraction fallbacks. Do not
reintroduce these paths to support old clients.

## Shared import capacity

NestJS reuses [permanent shared URL media](../docs/url-imports/shared-media.md)
before contacting this router. Canonical sources reuse their verified original,
and matching processing recipes reuse published vocals. Provider credentials and
adapter contracts stay unchanged; no paid metadata lookup is added.

URL import capacity is shared across providers. The backend now defaults to
20 active imports, five starts per second and 100 outstanding imports total.
The remaining 80 slots form a durable waiting backlog. Users can submit another
link while a previous link is downloading; account, media and usage limits still
apply. A provider request is made only when active capacity and a start slot are
available. Twenty requests start over at least three seconds under the five-per-
rolling-second ceiling, then up to twenty downloads can remain active together.

The router and adapters use the same shared admission module. The router and
VideoScale allow twenty active acquisitions and five starts per second:

```dotenv
ACQUISITION_CONCURRENCY=20
ACQUISITION_REQUESTS_PER_SECOND=5
```

The selected yt-dlp adapter allows ten active acquisitions and two starts per
second. Its gate spaces starts while downloads overlap. The backend retains its
generic import settings:

```dotenv
URL_IMPORT_CONCURRENCY=20
URL_IMPORT_REQUESTS_PER_SECOND=5
URL_IMPORT_MAX_OUTSTANDING=100
```

The deployed yt-dlp adapter's private override provides 2 GiB scratch and a 4 GiB
memory ceiling. Its four trusted attempts have thirty-second ceilings and share
a 120-second acquisition budget from the first active claim; its one-second retry
hint shortens existing backoff without increasing the attempt count. Attempts
1–3 use Residential and attempt 4 uses Mobile. Router/backend capacity settings
remain unchanged.

Each provider's ceiling follows its qualified operating configuration; source
changes do not establish a subscribed plan or its live availability. Upstream
cooldowns pause new paid starts within each operation's original deadline.
Waiting never repeats an already submitted paid request or switches providers.

Existing SaaS adapter deployment overrides provide 2 GiB dedicated temporary storage
and a 3 GiB memory limit for twenty bounded 100 MB files plus free-space headroom.
Scratch reservations happen before paid work and account for allocated writes.
The backend keeps container-local disk reservations too; allow approximately
4 GB plus its 128 MB headroom for worst-case concurrent transfer reservations.
Memory limits are ceilings, not a claim that the host has this capacity.

Deploy adapters with their resource overrides, then the router and any required
backend changes. Explicit environment values override source defaults. See dated
deployment evidence for the actual selected route and runtime checks. Private apps
must remain one replica for their process-local admission and scratch accounting;
the backend's BullMQ concurrency and start limiter are Redis-global.

API preflight read the [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-30. Rules 104, 106, 176, 177 and 178 preserve private bearer admission,
compatibility, sanitized problem responses and bounded binary transfer headers.
The existing private 503/Retry-After dependency contract is retained for upstream
429 responses; no public endpoint or provider-specific error format is added.

## Current support and verification

The selected yt-dlp adapter admits public single-item YouTube URLs and prefers
medium native WebM/Opus, then other WebM/Opus tiers and AAC/M4A. It rejects
playlists, live streams, video-containing formats and account-restricted sources.
Both proxy plans and ten concurrent logical acquisitions passed a bounded short
clip qualification; this is not universal source or sustained-capacity proof.
Native Google media delivery remains subject to source-IP, expiry and availability
restrictions. VideoScale accepts
the other public single-item URLs in the shared catalog, including
Instagram/Reels, TikTok, Vimeo, SoundCloud and Facebook/Reels. Each request must
expose eligible separate audio. VideoScale's existing direct YouTube capability
is retained, while the configured YouTube route selects yt-dlp. Enabled URL admission
is not evidence of successful acquisition; see the dated provider evidence for
the exact sources and journeys verified.
See [site policy](../docs/url-imports/supported-sites.md). No provider guarantees
unlimited requests, uninterrupted availability or immunity to source blocking.

- [VideoScale implementation and setup](videoscale/README.md)
- [yt-dlp adapter, DataImpulse settings and qualification limits](ytdlp/README.md)
- [yt-dlp deployment and live qualification, 2026-10-03](ytdlp/docs/DEPLOYMENT-2026-10-03.md)
- [JoJAPI implementation and setup](jojapi/README.md)
- [JoJAPI owner-authorized production test activation, 2026-10-01](jojapi/docs/ACTIVATION-2026-10-01.md)
- [JoJAPI deployment, source mismatch and restored routing, 2026-10-01](jojapi/docs/DEPLOYMENT-2026-10-01.md)
- [Tunelio implementation and historical setup](tunelio/README.md)
- [Private routing and configuration](router/README.md)
- [Tunelio routing deployment and live proof, 2026-09-30](docs/TUNELIO-ROUTING-2026-09-30.md)
- [Current-main private provider rollout, 2026-09-30](docs/R2-ROLLOUT-2026-09-30.md)
- [Agent handoff](videoscale/docs/AI-HANDOFF.md)
- [Dated deployment evidence](videoscale/docs/DEPLOYMENT.md)
- [Local cleanup evidence](videoscale/docs/LOCAL-CLEANUP.md)

Run adapter tests plus backend verification and import/processing integration
checks. Run backend build-producing commands sequentially: they share `dist`.
Local tests are not live-provider, R2, worker or deployment proof.

From the repository root, qualify both private HTTP hops with synthetic native
Opus and the real backend media probe after building the backend:

```sh
python3.12 -B -m unittest discover -s video_providers/tests -v
```

This test requires locally installed Node, FFmpeg and ffprobe to create/probe its
fixture. It makes no real SaaS call. The deployed adapters contain no FFmpeg.
