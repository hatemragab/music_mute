# VideoScale implementation handoff

Updated 2026-09-28. Read [provider README](../README.md), [tasks](../TASKS.md),
[private contract](../openapi.yaml) and [deployment evidence](DEPLOYMENT.md).
The cross-provider authority is [provider architecture](../../README.md) and
[provider contributor instructions](../../AGENTS.md).

## Current architecture

`Apps -> NestJS -> private provider adapter -> VideoScale`

`SaaS audio -> adapter -> NestJS validation -> private S3 -> existing worker`

- NestJS uses `AudioAcquisitionClient` and only
  `AUDIO_ACQUISITION_API_URL` / `AUDIO_ACQUISITION_API_KEY`.
- The adapter alone receives the VideoScale credential. No MongoDB, S3 or
  Firebase credentials belong in it. No public exposure or published ports.
- Included metadata is sanitized into nullable MongoDB `extra_data`.
  Titles use its optional `title` field. No extra paid metadata requests.
- New providers must implement the private contract. Changing a raw SaaS URL
  cannot make incompatible APIs work; deploy a matching adapter then change env.
- Preserve bounded transfers, independent byte/duration validation, deadlines,
  temporary-file cleanup and existing raw WebSocket snapshots.
- Never automatically repeat paid task creation after an ambiguous result.
  Status-only retries do not create another paid task.
- Missing metadata remains null by design, not for old-client compatibility.

## Legacy removal

The owner explicitly authorized breaking removal without migrations. The old
self-hosted downloader source, tests, deployment configuration, mitigation code
and temporary deployment bridge have been deleted locally. Do not recreate them,
old environment aliases or a separate title-header parser. Current hooks are
`caprover-api-hook.js` and `caprover-adapter-hook.js`.

The cleanup was deployed as backend image 82 on 2026-09-28; adapter image 2
remains active. A fresh signed-in web import reached Ready; MongoDB metadata,
both S3 objects' size/checksum/version/type, playback and empty scratch were
verified. See [release 82 evidence](RELEASE-82.md) for exact results and limits.

## Remaining boundaries

Released follow-up: [official metadata](OFFICIAL-METADATA.md) adds optional oEmbed
title/creator lookup; no scraping or extraction fallback. Include
`official_metadata.py` in every new adapter deployment archive. Adapter image 6
is deployed; live metadata-only lookup and health verified, no new paid import.

Latest follow-up: [transfer crash and status-window fix](TRANSFER-CRASH-FIX.md).
ImportFiles uses native HTTP streams to avoid Undici's fatal paused-parser bug.
Unknown status waits are bounded separately from transient HTTP retries; never
resubmit a paid task. See that report for release verification.

Released follow-up: [task-state and WebM preference fix](STATUS-WEBM-FIX.md).
Current source prefers WebM/Opus → MP3 → M4A and rechecks inconclusive task
states within the shared read budget; adapter image 4 contains this fix.

For authorized releases, use the authenticated CapRover CLI connection
`musicmute` at `https://captain.music-mute.com`, not Chrome. The owner explicitly
authorized CLI deployment on 2026-09-28. Run with a PTY:
`caprover deploy -n musicmute -a music-mute-videoscale -t <absolute-allowlisted-tar>`.
Package only `captain-definition`, `Dockerfile`, `.dockerignore`, `service.py`,
`official_metadata.py`.
Keep credentials in CLI/runtime storage; never print its config or tokens.
Verify the Docker service image, health and source hash after deployment.
This does not authorize unrelated deployments, credential or permission changes.

Released follow-up: [import reliability](IMPORT-RELIABILITY.md) documents prompt
terminal-execution recovery, failure UI, diagnostics and bounded GET retries.
These shipped in backend 83, adapter 3 and web 11; see the separate
[release verification](DIAGNOSTICS-PLATFORMS.md#verified-live-release).

The deployed adapter/web follow-up enables the shared catalog plus Instagram/Reels, TikTok and Vimeo
at the owner's request. Facebook/Reels and SoundCloud no longer fail at the
adapter's host allowlist. Only YouTube has live E2E qualification; each other site
still needs real acquisition proof. See [diagnostics and platform update](DIAGNOSTICS-PLATFORMS.md).
Uptime, unlimited use, exact billing,
upstream cancellation and retention guarantees remain unverified.

Observed provider responses omitted title/channel/description. Do not add paid
enrichment or invent fields. The owner should rotate the provider credential
exposed in a prior browser snapshot; see deployment notes. Never print secrets.

Root/component AGENTS apply. Read the realtime handoff before modifying live
updates. Preserve unrelated dirty work. No new deployment, account/data deletion,
credential changes or purchases are authorized by this local cleanup.
