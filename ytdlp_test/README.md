# MusicMute private yt-dlp audio service

[Migration plan and completion gates](migration-plan.md) · [Private OpenAPI](openapi.yaml)
· [Historical qualification results](results.md)

The `music-mute-ytdlp-test` CapRover app is the private downloader for URL imports.
NestJS submits a public URL and account limits, receives verified native audio,
independently measures it, uploads to the existing immutable S3 input, and submits
the normal worker job. The public Android API and file-upload flow stay stable.
Deployment status is recorded in the migration plan; source changes alone are
not evidence of a live cutover.

All public single-item sites recognized by the pinned yt-dlp build may be tried.
The selector `bestaudio[vcodec=none]` has no video fallback. Sources without a
separate audio stream fail safely. Playlists, live media, credentials in URLs,
private network targets, cookies, proxy rotation, plugins, external downloaders,
and remote EJS components are disabled. Every Python DNS result and socket
connection is checked, including redirects; connections use checked numeric IPs.
Deno EJS runs without network permissions. Unsupported sites and private content
are not promised to work.

## Configuration and deployment

Keep **Do not expose as web-app externally** enabled, no published ports, one
replica, 1 CPU, 768 MiB memory, all capabilities dropped and init enabled. Set
container port 8080. Mount `/work` as 256 MiB tmpfs with nosuid/nodev/noexec and
bound Docker logs to two 5 MiB files. Audio is never stored in a persistent volume.

Mount a separately generated 32–256 character service key read-only at
`/run/musicmute-ytdlp/api-key`, readable by UID 10001. Never put it in the archive.
Use [caprover-override.json](caprover-override.json) for the saved downloader
service override and [caprover-api-hook.js](caprover-api-hook.js) for the backend
pre-deploy hook that injects the same key without putting it in source or an image.
The API is bearer-authenticated. The health endpoint contains no sensitive data
and is available only on the private network.

NestJS configuration:

- `YTDLP_API_URL=http://music-mute-ytdlp-test:8080/`
- `YTDLP_API_KEY`: the same protected service key
- `URL_IMPORT_CONCURRENCY=1`, `URL_IMPORT_MAX_OUTSTANDING=20`
- `URL_IMPORT_ENABLED=true`, `URL_IMPORT_PROCESSOR_ENABLED=true`
- Existing `URL_IMPORT_TEMP_ROOT`, free-space and FFprobe settings still apply.

Deploy the allowlisted source archive using CapRover:

```sh
tar -cf /tmp/musicmute-ytdlp-test.tar -C ytdlp_test \
  Dockerfile captain-definition runner.py server.py extractor.py network_guard.py \
  test_runner.py test_server.py test_network_guard.py runtime_checks.py .dockerignore
```

The process lock allows one acquisition at a time; NestJS supplies the durable
bounded queue. Per-request scratch directories are removed after transfer,
failure, cancellation, or timeout. Startup clears abandoned attempt directories;
container replacement discards the tmpfs. Existing NestJS cleanup also remains.
Delays, transfer caps and bounded retries reduce traffic but do not guarantee
that upstream platforms will never restrict this server.

Dependencies remain checksum-pinned official yt-dlp nightly 2026.09.16.232951
(with matching EJS), Deno 2.9.7 and Python 3.12. FFmpeg/FFprobe inspect and decode local audio only. Compatible native audio is
transferred unchanged; other verified audio containers are converted to AAC/M4A
for the existing MusicMute input contract, without ever acquiring video. Update hashes deliberately and repeat live qualification.

## Validation

```sh
python3 -m unittest discover -s ytdlp_test -v
python3 -m compileall -q ytdlp_test
# From backend/:
pnpm run verify
pnpm run test:integration
pnpm run test:imports:integration
pnpm audit --prod
```

Tests use synthetic local data and isolated MongoDB/Redis. Production proof must
also show real source acquisition, S3 confirmation, job processing and cleanup.
