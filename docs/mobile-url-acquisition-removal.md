# Native URL import architecture

This page describes current intake. The shared authority is
[provider architecture](../video_providers/README.md); provider implementation,
tests and deployment evidence live under `video_providers/<provider>/`.

## Supported flow

- Local audio/video: native preparation, review/consent, signed S3 upload and
  normal processing. Web intake supports local audio only.
- Public URL: Android, iOS and web submit `POST /media-imports`. NestJS calls a
  private SaaS adapter, receives audio bytes, validates them, uploads to private
  S3 and submits the existing worker job. Provider media never passes through
  the client, and vendor credentials never leave the adapter.
- Job/import progress uses existing authenticated WebSocket snapshots. HTTP
  remains for commands, grants, transfers and explicit non-live reads.
- Included source metadata is sanitized into nullable MongoDB `extra_data`.
  An included title can populate the source title; missing titles stay absent.
  No paid metadata request or automatic metadata reconstruction is performed.

Only YouTube is qualified by the current VideoScale adapter. Client catalogs
are a UX admission check, not a promise of vendor support. See
[site policy](url-imports/supported-sites.md).

## Boundaries

`POST /jobs` accepts prepared local file submissions. URL acquisition uses
`POST /media-imports`; clients do not upload acquired provider audio.
There is no device extraction runtime or compatibility path for retired intake.
No data migration is required or provided for this provider switch.

Keep account isolation, rights confirmation, source validation, temporary-storage
limits and cleanup intact. S3 input/output retention follows normal account
lifecycle policy. SaaS acquisition does not guarantee uninterrupted access.

## Verification

Use the [provider setup and tests](../video_providers/videoscale/README.md),
[dated deployment proof](../video_providers/videoscale/docs/DEPLOYMENT.md), and
[local cleanup record](../video_providers/videoscale/docs/LOCAL-CLEANUP.md).
Native component READMEs define their build/test commands. Native UI tests may
use only the authorized existing iPhone 17 Pro iOS 26.0 simulator.

This documentation update did not run native/device tests or deploy any code.
