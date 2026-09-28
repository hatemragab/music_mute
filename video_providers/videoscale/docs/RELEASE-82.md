# Backend release 82 — 2026-09-28

Explicitly authorized backend deployment and real YouTube end-to-end test.
CapRover reports local deploy time 00:14 on 2026-09-28 (build started
2026-09-27 21:14:32 UTC). No commit, push, client/worker release, credential
change, subscription purchase or real-data deletion was performed.

## Release identity

- Backend: `img-captain-api:82`, independently read back from Swarm, 1/1 running.
- Existing adapter: `img-captain-music-mute-videoscale:2`, healthy, 1/1 running.
- API readiness returned HTTP 200 with `{"status":"ok"}`.
- Adapter remains read-only with no published ports.
- Runtime backend has only generic acquisition URL/key settings; no vendor key,
  retired client module or separate title-header parser.

Saved ignored archive: `../backend-release-2026-09-28.tar`.
SHA-256: `25e8c0fce85c4a3bb7c5ce78db327ce072fecd733e8cf205e6ed93adc68fe951`.
The 320-file allowlisted archive contains no dotenv files, tests, credentials or
retired downloader source. Comparison with the previous deployed archive found
only the intended `backend/src/url-imports/import-files.ts` change.

## Real authenticated E2E

A fresh import of the public Blender Big Buck Bunny YouTube sample was submitted
through the signed-in web app after release 82 was running. The retained job is
named **VideoScale release 82 E2E verification**.

- UI progressed through validation/upload/processing to **Ready**.
- Adapter logged one successful acquisition, 8,681 ms.
- MongoDB: ready, source kind URL, no error, provider videoscale, site youtube,
  format 140, AAC/M4A, 44,100 Hz, stereo, included bitrate/advertised size and
  independently measured 634.625 seconds / 10,264,232 bytes.
- S3 input: 10,264,232 bytes; vocal output: 1,555,374 bytes.
  Read-only HEAD of each exact object version verified size, SHA-256 checksum,
  version ID and content type against its stored identity.
- The new vocal result loaded and played to 16.3 seconds before being paused.
  This proves playback advancement, not an independent audio-quality review.
- Backend scratch entries: zero. Adapter scratch files: zero.
- The browser briefly reconnected while a blocking rename prompt was open, then
  returned to live updates and showed the completed job without a page refresh.

| Backend-measured stage | Duration |
| ---------------------- | -------: |
| Import queue           |   367 ms |
| Acquisition            | 8,719 ms |
| Validation             |   748 ms |
| S3 input upload        |   565 ms |
| Upload confirmation    | 1,459 ms |

This was one successful fresh MusicMute job using an already-qualified sample.
The provider may reuse upstream work; this does not prove an uncached YouTube
fetch, universal availability, unlimited quota or immunity to blocking.
Test job/S3 artifacts remain under normal account retention.

## Checks run

- `pnpm run verify`: formatting, lint, typecheck, secret/transfer checks,
  949 unit tests, 148 HTTP tests and build passed.
- `pnpm run test:imports:integration`: 6 passed.
- `pnpm run test:processing:integration`: 15 passed.
- `python3 -B -m unittest -q test_service.py`: 12 passed.
- Verification helper executed read-only against the exact tested job and S3
  objects; syntax/format checks passed.
- Archive inspection and `git diff --check` passed.

The read-only [verification helper](../inspect-live-job.mjs) now checks S3 object
identity as well as MongoDB state and scratch cleanup. No credentials or signed
URLs are printed. Prior credential-rotation and vendor-limit notes in
[deployment evidence](DEPLOYMENT.md) remain applicable.

![Release 82 real import and playback](release-82-e2e.png)
