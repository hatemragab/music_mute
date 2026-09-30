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
   S3 and confirms the normal processing job.
5. The existing worker retrieves the S3 input using its normal grant and produces
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
`finally` cleanup and an orphan sweeper. S3 inputs/results are intentional
retained objects under account lifecycle policy, not VPS scratch.

## Configuration and provider replacement

NestJS has only `AUDIO_ACQUISITION_API_URL` and
`AUDIO_ACQUISITION_API_KEY` for provider access. Its URL points to the private
`music-mute-audio-router` service. The router has separate URL/key pairs for the
YouTube and other-site adapters; it never receives SaaS credentials. The Tunelio
key belongs only in `music-mute-tunelio`; the VideoScale credential remains only
in `music-mute-videoscale`. Run all three as private CapRover apps without public
exposure or published ports. The adapters and router have no MongoDB, S3 or
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
Local tests are not live-provider, S3, worker or deployment proof.

From the repository root, qualify both private HTTP hops with synthetic native
Opus and the real backend media probe after building the backend:

```sh
python3.12 -B -m unittest discover -s video_providers/tests -v
```

This test requires locally installed Node, FFmpeg and ffprobe to create/probe its
fixture. It makes no real SaaS call. The deployed adapters contain no FFmpeg.
