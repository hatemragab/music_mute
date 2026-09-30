# Audio acquisition providers

URL imports use SaaS providers behind private adapters. The private
[router](router/README.md) sends YouTube items to [Tunelio](tunelio/README.md)
and other enabled items to [VideoScale](videoscale/README.md). Each provider owns
its source, tests, configuration and documentation under
`video_providers/<provider>/`.

## Request and file flow

1. Clients submit an authorized URL import to NestJS through `POST /media-imports`.
   Existing realtime snapshots report progress; clients never call the SaaS.
2. NestJS's `AudioAcquisitionClient` calls the private router's
   `POST /audio-imports` with `url`, `max_bytes`, `max_duration_seconds`
   and a shared service bearer key.
3. The router selects one adapter before acquisition. The adapter handles provider
   authentication, audio-only format selection, any bounded status checks and
   HTTPS delivery. It returns audio bytes, not a provider delivery URL. Neither
   the router nor the adapters automatically resubmit or switch providers after
   an acquisition failure.
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
YouTube and other-site adapters; it never receives SaaS credentials. The Tunelio
key belongs only in `music-mute-tunelio`; the VideoScale credential remains only
in `music-mute-videoscale`. Run all three as private CapRover apps without public
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

URL import capacity is shared across providers. The backend now defaults to
20 active imports, five starts per second and 100 outstanding imports total.
The remaining 80 slots form a durable waiting backlog. Users can submit another
link while a previous link is downloading; account, media and usage limits still
apply. A provider request is made only when active capacity and a start slot are
available. Twenty requests start over at least three seconds under the five-per-
rolling-second ceiling, then up to twenty downloads can remain active together.

The router and both adapters use the same shared module and settings:

```dotenv
ACQUISITION_CONCURRENCY=20
ACQUISITION_REQUESTS_PER_SECOND=5
```

Keep those identical in all three private apps; there are no separate Tunelio
or VideoScale capacity settings. The backend retains its generic import settings:

```dotenv
URL_IMPORT_CONCURRENCY=20
URL_IMPORT_REQUESTS_PER_SECOND=5
URL_IMPORT_MAX_OUTSTANDING=100
```

The start ceiling uses the owner's stated paid-plan allowance; source changes do
not establish the subscribed vendor plan or its live availability. Upstream
cooldowns pause new paid starts within each operation's original deadline.
Waiting never repeats an already submitted paid request or switches providers.

Each adapter's deployment override provides 2 GiB dedicated temporary storage
and a 3 GiB memory limit for twenty bounded 100 MB files plus free-space headroom.
Scratch reservations happen before paid work and account for allocated writes.
The backend keeps container-local disk reservations too; allow approximately
4 GB plus its 128 MB headroom for worst-case concurrent transfer reservations.
Memory limits are ceilings, not a claim that the host has this capacity.

To activate this change, deploy the updated adapters with their resource
overrides, then the router, then the backend and clients. Explicit environment
values from earlier deployments override the new defaults. No production
configuration is changed by these local source edits. All three private apps must
remain one replica for their process-local admission and scratch accounting;
the backend's BullMQ concurrency and start limiter are Redis-global.

API preflight read the [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-30. Rules 104, 106, 176, 177 and 178 preserve private bearer admission,
compatibility, sanitized problem responses and bounded binary transfer headers.
The existing private 503/Retry-After dependency contract is retained for upstream
429 responses; no public endpoint or provider-specific error format is added.

## Current support and verification

Tunelio accepts public single-item YouTube URLs and requests native Opus audio
without an additional paid metadata call or audio conversion. VideoScale accepts
the other public single-item URLs in the shared catalog, including
Instagram/Reels, TikTok, Vimeo, SoundCloud and Facebook/Reels. Each request must
expose eligible separate audio. VideoScale's existing direct YouTube capability
is retained, but the router selects Tunelio for YouTube. Enabled URL admission
is not evidence of successful acquisition; see the dated provider evidence for
the exact sources and journeys verified.
See [site policy](../docs/url-imports/supported-sites.md). No provider guarantees
unlimited requests, uninterrupted availability or immunity to source blocking.

- [VideoScale implementation and setup](videoscale/README.md)
- [Tunelio implementation and setup](tunelio/README.md)
- [Private routing and configuration](router/README.md)
- [Tunelio routing deployment and live proof, 2026-09-30](docs/TUNELIO-ROUTING-2026-09-30.md)
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
