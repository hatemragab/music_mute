# Official metadata lookup — 2026-09-28

Deployed as adapter image 6 on 2026-09-28. No paid download submitted for validation.

The adapter starts an optional `OfficialMetadata` lookup beside VideoScale
acquisition. Completed sanitized `title` and `author_name` (mapped to `channel`)
fill missing fields in the existing bounded metadata header. Included metadata
wins. NestJS's existing normalization, MongoDB `extra_data` persistence and source
title selection remain unchanged. No new public endpoint, schema or credentials.

## Sources and scope

- YouTube: `https://www.youtube.com/oembed`, public URL plus `format=json`.
  Live read-only probe through this implementation returned the official Blender
  Big Buck Bunny title and creator. This was metadata only, not acquisition proof.
- [TikTok official documentation](https://developers.tiktok.com/docs/en/embed-videos):
  `https://www.tiktok.com/oembed`, canonical video links only.
- [Vimeo official documentation](https://developer.vimeo.com/api/oembed/videos):
  `https://vimeo.com/api/oembed.json`; player URLs normalize to numeric item URLs.
- [SoundCloud official documentation](https://developers.soundcloud.com/docs/oembed):
  `https://soundcloud.com/oembed`, canonical track links only.

Other sites and shortened TikTok/SoundCloud URLs skip metadata without affecting
audio. These resolvers do not imply universal title availability or unrestricted
endpoint quotas. No HTML scraping, yt-dlp, source-page redirects, paid metadata,
VideoScale task replay, descriptions/HTML/thumbnails/raw payload persistence.

## Bounds and failure behavior

- One daemon lookup maximum, no unbounded thread queue. Acquisition never waits.
- Three-second socket and elapsed-loop budgets; OS DNS may outlast that budget
  but still occupies only the one metadata slot and never blocks audio delivery.
- 64 KiB response limit, fixed TLS endpoint hosts, existing public-IP DNS pinning,
  no redirects, no Authorization headers, no retries.
- Memory-only LRU cache, 128 entries, one-hour success and one-minute miss TTL.
- 403/429 host cooldown: at least five minutes for numeric Retry-After, capped
  at one day; otherwise one hour. No promises of immunity to throttling.
- Each title/creator at most 200 Unicode code points; control/format characters,
  obvious credential/URL strings and HTML rejected; 4096-character header cap.
- If the lookup is pending when audio completes, omit metadata for that import.
  No late database mutation or historical-job backfill. Restart clears the cache.

## Validation

- `python3 -m unittest -q test_service.py test_official_metadata.py`: 49 passed.
- Backend focused metadata/acquisition/transfer tests: 19 passed.
- Live YouTube metadata-only GET returned title and creator; no VideoScale call.
- Other platform behavior tested with synthetic fixtures, not live acquisition.
- `pnpm run verify`: formatting, lint, typecheck, secret checks, transfer benchmark,
  965 unit tests, 148 HTTP tests and build passed.
- `pnpm run test:imports:integration`: 8 passed.
- `pnpm run test:processing:integration`: 15 passed.
- `git diff --check`: passed. No backend source changes needed for this feature.

Read [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-28: preserve secure endpoint authentication (104), existing snake_case
metadata (118), and compatible optional response fields (106). The existing
binary private contract remains intact; no Zalando-specific headers introduced.

Deployment must include `official_metadata.py` alongside `service.py`; Dockerfile
and `.dockerignore` are updated. No mobile E2E was performed here.

## Authorized deployment — 2026-09-28 18:14 UTC

- CapRover CLI deployed `music-mute-videoscale` from image 5 to image 6.
- Archive: `videoscale-official-metadata-2026-09-28.tar`; only the five allowlisted
  runtime/build files, no credentials or tests.
- Archive SHA256: `ae2a9cbf656d17187069207560df46d787728e1ceac029bd34309a8d9434b875`.
- Running container `7af7ab2f61cd`: healthy, read-only root filesystem,
  no published service ports. No permission or credential changes.
- Deployed `service.py` SHA256:
  `326a02607d3209f88ef650f886104b822689e9561f6054f52da02dd38020c2dc`.
- Deployed `official_metadata.py` SHA256:
  `40542948159f8c7bf0dea5de1a883c44789fe8cb372b7eca54cce9fd99ef2c87`.
- Both hashes match local source; adapter health HTTP 200 and public backend
  `/health/ready` returned `status: ok`. No backend redeployment was necessary.
- Official YouTube lookup executed inside the deployed container returned the
  expected Big Buck Bunny title and Blender creator; existing metadata merge
  passed. This used no VideoScale API request or paid download.
- Re-ran all 49 adapter tests before packaging: passed.
- No fresh end-to-end mobile import, MongoDB/S3 write or worker run in this release
  verification. Existing jobs are not backfilled; test a new import on mobile.
