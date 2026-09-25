> Retired Cobalt design/evidence. Do not use these deployment instructions. The active replacement is [yt-dlp](../ytdlp_test/README.md), tracked in its [migration plan](../ytdlp_test/migration-plan.md).

# Cobalt URL-import pilot: deployed result

Updated: 2026-09-25. Branch: `hatem/cobalt-url-import`, based on
`93b825046643`, with uncommitted changes. No commit or push was performed.

## Final service state

- **Implemented and deployed:** backend release `img-captain-api:64`.
- **Enabled:** authenticated SoundCloud single-track and Tumblr native-audio
  imports. Only reviewed native, non-HLS tunnels are fetched. Existing account
  limits apply. See [all-provider review and follow-up evidence](provider-support.md).
- **Live-tested:** public API → Cobalt → measured audio validation → S3 → existing
  worker → downloadable, probed result. Request replay returned the same import.
- **Unavailable:** YouTube. Follow-up native M4A/Opus transfer tests returned
  zero-byte audio despite successful metadata. The default audio path does not
  require the helper; the helper mismatch alone was not a sufficient diagnosis.
  The optional inspected official image pair is also incompatible:
  Cobalt requests `POST /get_pot`, which returns HTTP 404 from the generator.
  The generator's `GET /token` also returned 503 during the bounded live check.
  No adapter, fork, downgrade, alternate extractor, or network workaround was added.
- **Preserved:** existing upload API, worker contract, shared Redis, account policy,
  and user media. Android UI implementation remains outside this task.

| App | Internal address / final state |
| --- | --- |
| `api` | `img-captain-api:64`, one running replica; public readiness HTTP 200 |
| `music-mute-cobalt` | `http://music-mute-cobalt:9000/`, one running replica, no public route or host ports |
| `music-mute-yt-session` | `http://music-mute-yt-session:8080/`, private, scaled to zero after incompatible endpoint check |

Cobalt rejects requests without its service key (`error.api.auth.key.missing`).
The key is stored at `/captain/data/musicmute-cobalt/keys.json`, inside a root-only
host directory, mode 0600, readable by the official image's UID 1000 through a
read-only bind mount at `/run/music-mute-cobalt/keys.json`. CapRover's standard
backend pre-deploy hook reads that file and injects `COBALT_API_KEY` into the
backend runtime. The key is absent from source, deployment archives, and reports.
Private networking is shared with other cluster apps; authentication supplies the
additional processing boundary.

The generator logs token values upstream. Its container log driver was set to
`none` before the live compatibility check. It remains stopped and is not a
working YouTube dependency.

Follow-up configuration fix at **2026-09-25T18:35:53Z**: removed the stale
`YOUTUBE_SESSION_SERVER` variable from Cobalt through CapRover and restarted it.
Leaving the URL configured after stopping the helper had caused recurring
`ENOTFOUND music-mute-yt-session` errors. The saved service and running container
now both omit the variable. Cobalt only starts the helper polling loop when that
variable exists; no helper-loading or DNS errors appeared after restart.
Native SoundCloud and Tumblr downloads were revalidated and temporary files
cleaned up; public API readiness remained 200. Historical logs are retained.
This fixes the stale dependency, not YouTube's separate zero-byte media failure.

A deeper follow-up found request-dependent Googlevideo responses and confirmed
that Cobalt masks upstream errors as empty HTTP 200 responses. Small audio
ranges succeeded, but full downloads still failed. See the
[YouTube diagnostic report](youtube-diagnostics.md); a blanket IP block is not
established, and YouTube remains disabled.

## Reproducible image and deployment evidence

| Official image | Verified Linux amd64 digest |
| --- | --- |
| `ghcr.io/imputnet/cobalt` | `sha256:df14a3b3fe4390d4e1c2d4761ed58981d34aa5fc82d0df2091bab890e7dfaa8b` |
| `ghcr.io/imputnet/yt-session-generator` | `sha256:2b2a9e7462a29836eb3a0c661180968c8d07e2ddcb2e27168f8d860b62a4a8f5` |

Cobalt reports source package 11.7.1, revision
`a636575b09de1fc55d9b8cd98cac88f5f2f16b42`. The running image's SoundCloud
extractor, action selector, and YouTube session helper matched SHA-256 hashes of
the reviewed official revision exactly. The generator's actual image code layer
was also inspected, not inferred from the repository's default branch.

The accepted SoundCloud path selects native audio, sets audio-copy processing,
and produces one raw proxy tunnel when non-HLS. Live response: `local-processing`,
service `soundcloud`, type `audio`, format `mp3`, copy `true`, HLS `false`, one
internal tunnel. Picker, video/merge, cover/subtitle processing, ambiguous
responses, external tunnel origins, and unverified HLS paths are rejected before
requesting media bodies. A final audio filename alone is not the acceptance proof.

The initial release-63 allowlisted backend archive SHA-256 is
`c2bb91bc1c102d6702732f2a851cce4076c7a390824195e90c6bc5cd6e5256f2`.
CapRover built and deployed release 63 successfully. The provider expansion is
release 64, archive SHA-256
`377b782a5bd07c0ad6049e3a1f677de4c304534df4ede08bea9abc1960719274`. Release 60 is the pre-change
rollback baseline. One earlier build session timed out; release 60 remained live.
The first deployed import attempt exposed a missing streaming `Content-Length`;
release 63 fixes it using the measured bytes. The corrected fixture reproduced
the failure before the fix and passed afterward.

## Android API contract

Use existing Firebase authentication and `X-Installation-Id` processing access:

```http
POST /media-imports
Authorization: Bearer <USER_ID_TOKEN>
X-Installation-Id: <INSTALLATION_UUID>
Content-Type: application/json

{"url":"https://soundcloud.com/<artist>/<track>","request_id":"<UUID_V4>"}
```

HTTP 202 returns `import_id`, `status`, nullable `job_id`/`error`, and timestamps;
`Location` points to `GET /media-imports/{import_id}`. Poll that owner-scoped
endpoint until `submitted` or `failed`, then use existing `GET /jobs/{job_id}`.
Submission is not separation completion. Reuse `request_id` for retries of the
same URL; a different canonical URL with that ID returns 409. Android sends only
the URL and does not acquire or upload this source audio.

Progress: `queued → downloading → validating → uploading → submitted` or `failed`.
Public live checks rejected missing authentication, SoundCloud collections, and
YouTube admission. Unknown providers, playlist-bearing links, unsupported audio,
size/duration excess, capacity, and upstream failures have sanitized error codes.

[OpenAPI](../backend/openapi.yaml), the
[client contract](../docs/api/client-contract.md), and the
[route/security matrix](../docs/backend-security/route-matrix.md) document the API.

## Queue, validation, and cleanup

- Existing Redis, prefix `musicmute-import`, queue `musicmute-url-imports`.
- Global concurrency **2**, including multiple backend processors; maximum
  **20 active plus waiting** imports, enforced through MongoDB transactions.
- Durable queued records repair lost enqueue operations. Normal work starts
  immediately; the 30-second maintenance interval is only for recovery/cleanup.
- One upstream attempt; no rapid retries for refusals, authentication, or
  unsupported sources. Queue payloads contain only an import ID.
- Native audio is streamed once into a generated private directory, with actual
  byte counting, SHA-256, a 120-second transfer deadline, and account/hard limits
  (at most 50,000,000 bytes and 1,200 seconds).
- FFprobe measures duration/container/tracks without transcoding. S3 uses the
  existing immutable signed PUT and exact-object confirmation/accounting.
- Each attempt has a 15-minute deadline. `finally` removes its media on success,
  rejection, upload/finalization failure, abort, and shutdown. Low disk refuses
  acquisition; default spare-space threshold is 128 MB plus the file budget.
- Startup/periodic bounded sweeps reclaim expired owned directories after a
  one-hour grace period, preserving active, foreign, and symlink paths. Empty
  directories from interrupted marker creation are also reclaimed.
- Failed unsubmitted job reservations are cancelled through existing accounting
  and storage cleanup. Accepted jobs are preserved after lost confirmation replies.
- Terminal import records expire after seven days; account deletion includes them.
  Accepted S3 inputs/results retain existing product retention.

Live temporary import directories were empty after both failed and successful
attempts and after public enablement. No persistent Cobalt media volume exists.
Only its key file is mounted. Downloaded smoke-test results were also removed
from their separate temporary directory after probing.

## Live smoke evidence

The separate test account used normal Firebase password authentication, session
bootstrap, installation headers, and unmodified standard account limits.

Permitted source: [Clear Skies (CC-BY), Scott Buckley](https://soundcloud.com/scottbuckley/clear-skies-cc-by).
Attribution: music by Scott Buckley, released under Creative Commons Attribution.
This material was used only for integration verification.

- Controlled import and subsequent public import both reached worker `ready`.
- Each input: native MP3, **3,120,900 bytes**, measured **195.030204 seconds**.
- Downloaded result: MP3, **381,954 bytes**, measured **19.069388 seconds**.
  The existing job recipe had `trimEnabled=true`; the worker reported 19.03
  seconds before codec padding. The shortened result follows existing gap trimming.
- Public import `6ab6b3abb5349c09026e9801` produced existing processing job
  `6ab6b3afb5349c09026e9803`. Replaying its request ID did not create another import.
- Old upload API smoke was repeated after release 63 and public enablement,
  using a generated three-second tone: 48,944-byte MP3 input,
  worker `ready`, downloadable 61,170-byte MP3 result, measured 3.030204 seconds.
- Both failed pre-fix imports removed temporary audio and released only their
  unsubmitted job reservations. S3 HEAD returned 404 for both failed reservation
  keys. No failed import was submitted for separation.

The public feature was enabled only after the controlled worker result passed.
A second import then verified the actual public route and main deployed processor.

## Validation

- `pnpm run verify`: formatting, lint, type checks, secret scan, **913 unit tests**,
  **146 HTTP/E2E tests**, and build passed after the provider expansion.
- `pnpm run test:imports:integration`: build and all **5** tests passed, including
  real isolated MongoDB/Redis, native FFprobe, HTTP streams, global queue limits,
  recovery, enabled Nest startup/shutdown, and upload/confirmation fault cases.
- The S3 fixture now omits `Content-Length` from the grant, as production does,
  and rejects uploads without the correct explicit measured length.
- `pnpm run test:processing:integration`: all **15** existing processing tests passed.
- `pnpm run test:integration`: native Node startup and authenticated Redis
  outage/recovery passed with isolated services.
- `pnpm audit --prod`: no known vulnerabilities. New untracked import source/test
  files were additionally scanned for secrets; none found.
- Live proof covers private Cobalt authentication/networking, public authenticated
  admission/status/replay, S3 upload, worker completion, result download/probe,
  existing upload behavior, and empty temporary media directories.
- Final audit confirmed global queue concurrency 2, no active/waiting imports,
  the unique owner/request index and seven-day TTL index. Test login tokens were
  revoked and the temporary credential file removed; result evidence is retained.
- Refusal, overload, orphan/crash, and failure-path stress checks use local
  fixtures; public providers were not load-tested. No Android UI/device tests
  or Android code changes were part of this backend-only pilot.

The [Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were checked for OpenAPI, authorization, naming, async responses, safe errors,
and compatibility; existing MusicMute wire/error conventions are preserved.

## Configuration and rollback

Final public settings: `URL_IMPORT_ENABLED=true`,
`URL_IMPORT_PROCESSOR_ENABLED=true`, `URL_IMPORT_PROVIDERS=soundcloud,tumblr`,
`URL_IMPORT_CONCURRENCY=2`, `URL_IMPORT_MAX_OUTSTANDING=20`,
`COBALT_API_URL=http://music-mute-cobalt:9000/`,
`URL_IMPORT_FFPROBE_PATH=/usr/bin/ffprobe`.

1. In CapRover → `api` → App Configs, set `URL_IMPORT_ENABLED=false` and save.
2. Leave the processor running until outstanding imports are terminal; then set
   `URL_IMPORT_PROCESSOR_ENABLED=false` if stopping the processor is required.
3. To roll back only the provider expansion, first restore
   `URL_IMPORT_PROVIDERS=soundcloud`, then roll back to `img-captain-api:63`.
   If the entire URL-import feature requires rollback, use `api` → Deployment → Version
   History → rollback beside **`img-captain-api:60`**. Verify `/health/ready` and
   existing upload/status calls afterward.
4. Preserve other environment values and the protected-key hook. Do not clear
   Redis, remove shared volumes, delete user media, or alter worker protocols.
   New collections/indexes are additive and do not prevent release 60 running.

VPS SSH was restored with explicit owner approval using the Mac's existing public
key, scoped to this VM with expiry **2026-09-25T19:19:03Z**. The local command is
`musicmute-ssh`. No IAM or firewall changes were made. Expiry affects operator
login only; it does not stop the deployed import services.
