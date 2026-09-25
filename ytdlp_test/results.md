# yt-dlp isolated test results — 2026-09-25

## Outcome

Created and deployed **music-mute-ytdlp-test** in CapRover. Three distinct public
Blender open movies completed as native audio-only downloads. Every confirmed
success matched the reported file size, contained no video tracks, passed a
complete FFmpeg audio decode, and had its temporary audio removed.

No NestJS integration, S3 upload, worker job, Android change, account cookies,
proxy/IP change, or Cobalt removal occurred. Existing API, Cobalt, and session
helper service specifications matched their pre-test hashes exactly. API
`GET /health/ready` returned 200/`{"status":"ok"}`; Cobalt root returned 200.
An initial audit used the wrong `/api/v1/health/ready` path (404); the source
README's actual `/health/ready` path was then verified successfully.

## Deployment

- CapRover image: `img-captain-music-mute-ytdlp-test:4`.
- Image ID: `sha256:c45b99823fb9422a476d3da584a2a186c3d2826cbed696aa4a8cddc39aec5230`.
- One healthy replica; user `tester` (UID 10001); dropped Linux capabilities.
- Private app, no published ports, no HTTP listener, no persistent volume.
- 1 CPU / 768 MiB memory limit; bounded Docker logs.
- `/work`: 256 MiB tmpfs, observed `nosuid,nodev,noexec`; audio does not accumulate
  in retained container filesystem layers. Normal completion/failure removes it
  immediately; container replacement discards the entire mount.
- Running Python source hashes matched this checkout for all four source/test files.
- yt-dlp: official nightly **2026.09.16.232951**, matching bundled EJS scripts.
- Deno: **2.9.7**. FFmpeg: **5.1.9-0+deb12u1**. Python: pinned 3.12 image manifest.
- yt-dlp and Deno artifacts verified against release SHA-256 digests before execution.
- A local-image deployment attempt failed because CapRover tried pulling that
  name from Docker Hub. Deployment was completed using a source tarball through
  CapRover; no registry credential or public image publication was needed.

## Complete live downloads

| Item | Submitted URL form | Bytes | Measured duration | Actual format | Result |
| --- | --- | ---: | ---: | --- | --- |
| Big Buck Bunny (`aqz-KE-bpKQ`) | YouTube watch | 10,202,210 | 634.601 s | 251 / Opus / WebM | Passed |
| Charge (`UXqq0ZvbOnk`) | youtu.be | 4,365,234 | 262.721 s | 251 / Opus / WebM | Passed |
| Sintel (`eRsGyueVLvQ`) | YouTube watch | 14,400,537 | 888.061 s | 251 / Opus / WebM | Passed |

The initial three tests used image :3. A complete Charge repeat on final image
:4 also passed, including the new explicit byte-count and duration-comparison
checks. Its hash matched the previous result. A further complete Charge
download after the tmpfs restart also passed with the same bytes, duration,
hash, full decode, and cleanup.

SHA-256:

- Big Buck Bunny: `fb175ebbd378fc7afbe7ede65eb26f2bcd14b09e2c03c2d034ccadc49342810b`
- Charge: `9944da1cc0c0ae3498e51dca71b06c2e06521df826cd09b03c548b16d7dd109f`
- Sintel: `0dbb10272e61b93cf557f5ca582c70b875b588d53ac1f0ad9c87b7d4ffe1c2ec`

Only metadata, watch/player resources and selected native audio are acquired.
The selector is `bestaudio[vcodec=none]` with no combined-media fallback and no
`-x` extraction. FFmpeg decodes to a null sink for validation, without writing a
converted audio file. Source media and signed delivery URLs are not retained.

## Fault and isolation checks

- 11 unit/validation tests passed locally and in the CapRover build.
- Tests cover canonical single-item URLs, playlist/host/credential rejection,
  no-video arguments, nonblocking concurrency lock, cooldown, failed-attempt
  cleanup, interruption, timeout, actual synthetic audio decode, non-audio
  stream rejection, and expected size/duration mismatch cleanup.
- Real process SIGTERM test: downloader child stopped; partial audio removed.
- Real process timeout test: downloader child stopped; partial audio removed.
- Both process tests passed again on the running tmpfs configuration and made
  no YouTube requests.
- Restarted only this test service after seeding a disposable partial file.
  A new healthy container had no remaining attempt directories. The operator
  connection dropped during the scripted check; a fresh connection independently
  verified the new container, tmpfs mount, empty workspace, and runtime checks.
  Download output lost during that connection interruption is not counted as a
  confirmed success.
- No provider token helper was required or installed. Default clients worked.

## Request pacing and limits

One active test, fragment concurrency one, one second between extraction
requests, 5–10 seconds before downloads, ten-second admission cooldown after
completion, bounded retries (one), 1 MiB/s transfer cap, 50,000,000-byte media
cap, twenty-minute duration cap, and ten-minute download deadline. Upstream
access refusals must stop the manual test sequence; do not run a retry loop.
These settings reduce unnecessary traffic; they do not guarantee freedom from
future YouTube account/IP/session restrictions.

## Scope of the evidence

This proves current VPS downloads for three public items, with complete media
validation. It does not prove every YouTube item, restricted/private/member
content, livestreams, playlists, or production concurrency. No load test was
performed. Shorts URL parsing was unit-tested, not live-qualified on a Short.
AAC/M4A output was not separately qualified; observed output was native Opus.
The test runner deletes its media, so it is not a public download service.

No backend suites were rerun because no backend file was changed in this task.
`python3 -m unittest discover -s ytdlp_test -v`, `python3 -m compileall -q ytdlp_test`,
and `git diff --check` passed. No commit or push.

## Sources

- [yt-dlp installation](https://github.com/yt-dlp/yt-dlp/wiki/Installation)
- [Official nightly recommendation and format options](https://github.com/yt-dlp/yt-dlp)
- [EJS and recommended Deno setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [YouTube pacing and account guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube)
- [PO tokens, if needed later](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [Reviewed optional provider instructions; not installed](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
- [Charge official release](https://studio.blender.org/blog/charge-premiere/)
- [Sintel official watch page](https://durian.blender.org/download/)

## Owner-requested Facebook test

On 2026-09-25 the owner requested audio from
`https://www.facebook.com/share/v/19duj8sfLg/`. The installed official yt-dlp
resolved it without login/cookies to Facebook item `1124573773248219` and
reported ten formats, including one separate HTTPS audio-only M4A stream.

A one-off process inside the existing test app admitted only this exact URL and
reused the runner's audio-only download, limits, lock, validation, and cleanup.
No installed source or service setting was changed; the normal runner admission
still accepts YouTube only. No NestJS/S3 integration or Cobalt mutation occurred.

- Complete native AAC/M4A: **165,823 bytes**, **28.165805 seconds**.
- Format `1748803056418754a`, source codec `mp4a.40.5`, `vcodec=none`.
- FFprobe: one audio stream and zero video streams. Full decode passed on VPS.
- Local delivered copy independently probed and SHA-256 verified against VPS:
  `55fddb61700530e08d3a439017c73b619d6b59025599c7cd530fb474331b6a2e`.
- Delivered file: `/Users/hatemragap/Downloads/music-mute-tests/facebook-1124573773248219.m4a`.
- VPS temporary audio removed; zero remaining attempt directories.

The [official supported-site list](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
includes Facebook and Facebook Reels. That does not guarantee native audio-only
availability for every link; private, restricted, or combined-video-only items
remain unqualified under this project's audio-only rule.


## Production migration — 2026-09-25

The later migration authorization supersedes the isolated-test scope above.

- Backend: `img-captain-api:65`; private downloader:
  `img-captain-music-mute-ytdlp-test:6`, healthy, one replica, no public ports.
- Active backend adapter, source admission, schema, examples and public API docs
  no longer contain Cobalt configuration or the former seven-provider gate.
- CapRover API configuration and the saved pre-deploy hook use the new protected
  yt-dlp service key. Old Cobalt key file removed. Cobalt app absent; its unused
  session-generator helper remains stopped at zero replicas.
- Every public single-item URL is delegated to yt-dlp without a site allowlist.
  Private network connections, playlists, live media, video streams and external
  downloader fallback are blocked. Account limits and S3/job behavior remain.
- Compatible native audio is transferred unchanged. Other verified audio formats
  are normalized to AAC for the existing MusicMute contract; no video is fetched.

### Full public API → S3 → worker → output proof

| Source | Import | Job | Input | Result |
| --- | --- | --- | --- | --- |
| Owner Facebook link | `6ab6d70a354498106c8cf933` | `6ab6d718354498106c8cf935` | 165,823 bytes, 28.165805 s, M4A | ready |
| YouTube Charge | `6ab6d8d66e4c49edc7b903a1` | `6ab6d8e96e4c49edc7b903a3` | 4,365,234 bytes, 262.721 s, WebM | ready |

Both jobs completed via the existing worker. Their authenticated output download
grants delivered MP3 files that passed FFprobe and full FFmpeg decoding. Facebook
output: 418,003 bytes / 20.871837 s. YouTube output: 2,155,668 bytes / 107.755102 s.
Output durations differ because the existing worker pipeline trims vocal gaps;
the acquired input durations were complete and unchanged. Test output files were
removed immediately. The synthetic test account's refresh tokens were revoked
and its protected session file was deleted.

Public API checks also proved unauthenticated rejection, localhost/metadata-IP
rejection, playlist rejection, request idempotency, and conflicting-request 409.
The first diagnostic poller expected `completed`; it was corrected to the actual
existing terminal status `ready`, and the existing Facebook job was reread rather
than downloaded again.

### Validation

- Backend `pnpm run verify`: format, lint, typecheck, secret checks, 860 unit tests,
  146 HTTP tests, and compiled build passed.
- `pnpm run test:integration`: external Redis outage/recovery test passed.
- `pnpm run test:imports:integration`: all five isolated native MongoDB/Redis/import
  lifecycle tests passed, including Nest startup/shutdown and queue recovery.
- `pnpm audit --prod`: no known vulnerabilities.
- Downloader: 21 tests passed locally and in the final Docker build, including
  actual disconnect/child-process cleanup and native WAV → AAC normalization.
- Live final image: offline SIGTERM and timeout fault tests killed child processes
  and removed partial media; deployed Python source hashes matched the checkout.
- `python3 -m compileall -q ytdlp_test` and `git diff --check` passed.

These results qualify the tested public Facebook and YouTube links, not every
item in yt-dlp's site catalog. Private/restricted sources or sources lacking a
separate audio stream can still fail safely. No Android/iOS changes, commit or
push were made by this migration.


Final restart audit: database active-import count was zero before the controlled
restart. A synthetic orphan was seeded. Swarm update completed at
2026-09-25T20:31:05Z; the new `:6` container was healthy with no attempt directories.
An SSH observation interruption was resolved by checking the same update, without
restarting again. Public API `/health/ready` returned 200 afterward.
