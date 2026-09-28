# Deployment evidence

Latest release: [backend 82 and real E2E verification](RELEASE-82.md), 2026-09-28.
The sections below retain the dated initial release-81 evidence.

Implemented and deployed 2026-09-27 using the user's Chrome CapRover session.
No commit, push, client release, worker downgrade, purchase or subscription change.

## Confirmed local checks

- Adapter `python3 -m unittest -q test_service.py`: 12 tests passed, including
  private DNS rejection, audio-only selection, completed-state gating, credential
  isolation, byte response/metadata, failure cleanup, capacity and disconnect cleanup.
- Backend `pnpm run verify`: formatting, lint, TypeScript, secret-scan/transfer
  scripts, 948 unit tests, 148 HTTP tests and compiled build passed.
- `pnpm run test:imports:integration`: 6 passed against isolated MongoDB/Redis;
  included metadata reaches the job service but cannot contaminate S3 input fields.
- `pnpm run test:integration`: compiled API startup, Redis authentication and
  outage/recovery passed using isolated local services.
- `pnpm run test:processing:integration`: 15 passed; metadata sanitization was
  additionally asserted against actual isolated MongoDB persistence.
- `pnpm audit --prod`: no known vulnerabilities found.
- `git diff --check -- backend`: passed.

## Confirmed live release

- API upgraded from `img-captain-api:80` to `img-captain-api:81`, one running replica;
  readiness returned HTTP 200 with status ok after final configuration restart.
- Adapter `img-captain-music-mute-videoscale:2`, one replica, Docker health healthy.
- Created `music-mute-videoscale` using authenticated Chrome CapRover UI.
- Disabled external web access before adding any runtime credentials/code.
- Swarm read-back: published ports null, read-only root true, `/work` tmpfs
  134217728 bytes. Resource/log limits saved via UI override.
- Existing uncommitted public-policy source is already in API image 80:
  compiled public-pages controller and public-policy module SHA-256 match the
  local build. Keeping those files in the package does not introduce new changes.

The user confirmed private credential access. The internal key was copied without
rotation to `/captain/data/musicmute-acquisition/api-key`, then injected by the
two pre-deploy hooks. Final API environment key-name read-back contains only
`AUDIO_ACQUISITION_API_URL` and `AUDIO_ACQUISITION_API_KEY` for acquisition,
with no provider-specific acquisition settings. Only the current generic hooks
remain; no deployment migration hook is required.

### Live test

Public licensed Blender Big Buck Bunny YouTube item, imported through the signed-in
web app. The retained job is named **VideoScale deployment verification**.
The UI reached Ready through existing live updates. Read-only MongoDB verification
of that exact job confirmed:

- `status: ready`, `source_kind: url`, no error code.
- Confirmed private S3 input: 10,264,232 bytes.
- Confirmed private S3 vocal output: 1,555,374 bytes.
- `extra_data`: schema 1, provider videoscale, site youtube, format 140, M4A,
  AAC (`mp4a.40.2`), container m4a_dash, bitrate 129.481 kbps, 44100 Hz, stereo,
  advertised size 10,271,496 bytes, measured duration 634.625 seconds and measured
  size 10,264,232 bytes. No delivery URL or provider authentication stored.
- Backend scratch had zero entries after completion. Adapter `/work` had zero
  files; it is a bounded tmpfs with anonymous media handles.

The web player loaded the completed vocal artifact and reached its 1:17 endpoint.
This is browser playback-path proof, not an independent listening-quality review.

| Backend-measured stage |  Duration |
| ---------------------- | --------: |
| Import queue           |    365 ms |
| Acquisition            | 10,471 ms |
| Validation             |     94 ms |
| S3 input upload        |    538 ms |
| Upload confirmation    |  1,500 ms |

These are one observed job's server measurements, not an SLA or universal speed.

### Packages

Ignored deployment archives are retained in this provider folder:

- `videoscale.tar`: SHA-256 `eeae451ef677e1140d99ede6d7f5704585a3b4365a95989fd7a4b3764dcd232e`.
- `backend-release-api.tar`: SHA-256 `936a534fdbc355ce600416ccd14bd78bd25da55dc0185ac7582e308e16f51087`.

The adapter tar is allowlisted to captain-definition, Dockerfile, .dockerignore
and service.py. It excludes research, tests, credentials and media.

## Remaining limits and operational notes

- One initial live attempt returned source unavailable. A later diagnostic returned
  `already_exists`, completed status and valid audio. The first failure's exact
  upstream cause was not captured. Status-only 404 reads now have a tested ten-second
  propagation grace; POST submission is never automatically repeated. Availability
  and unlimited quota are not guaranteed.
- Only YouTube is qualified/enabled by this adapter. Existing client supported-site
  copy still lists other providers; those receive unsupported-provider errors.
  Expanding support requires independent audio-only qualification.
- Provider title/channel/description were absent. No paid enrichment was added.
- Upstream cancellation, retention, exact billing and concurrency guarantees remain
  unverified. Local cancellation may not stop already-submitted SaaS work.
- At deployment time the old downloader checkout was preserved. The owner then
  authorized its complete local removal without migrations on 2026-09-28.
  That cleanup has not been deployed. Unrelated edits remain preserved; no device
  or worker release was performed.
- One configuration browser snapshot exposed the provider Basic credential in tool
  output. No credential was saved into repository files or archives. The account
  owner should rotate it in VideoScale and replace VIDEOSCALE_BASIC_AUTH in the
  private adapter. Credential changes require user completion of the vendor UI.
- The successful test job and its S3 artifacts are intentionally retained under
  normal account lifecycle policy. VPS media scratch is temporary; S3 is intentional.

![Private adapter configuration](deployment-private.png)

![Backend release 81](backend-release.png)
