# yt-dlp production import migration

Authorized scope: replace Cobalt with the existing private
`music-mute-ytdlp-test` app. Admit public single-item URLs supported by yt-dlp;
download only a separate audio stream. Preserve the current authenticated
MusicMute import/progress API, account limits, immutable S3 input, and worker flow.

## Gates

- [x] Private authenticated audio endpoint, bounded concurrency, size and duration.
- [x] Public-network-only outbound connections, including redirects and DNS changes.
- [x] Reject playlists, live media, video tracks, and sources without native audio.
- [x] Cleanup on completion, error, cancellation, timeout, and container restart.
- [x] Replace backend adapter and remove Cobalt provider/configuration gates.
- [x] Unit, HTTP, native integration, build, and dependency checks.
- [x] Deploy downloader, then backend; verify real YouTube and Facebook imports
      through S3 and the existing processing flow.
- [x] Retire Cobalt runtime/configuration and verify service health.

## Contract and guidance

Reviewed the current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-25: rules 101 (OpenAPI), 104 (authentication), 106 (compatibility),
118 (snake_case), 151 (responses), and 176 (problem JSON). Existing public API
errors remain compatible. The new private endpoint uses bearer authentication,
snake_case JSON requests, binary success, and sanitized problem JSON failures.
Health is private and contains no sensitive data.

Use the pinned official yt-dlp executable and bundled EJS/Deno setup already
qualified in `results.md`. Retain conservative request delays, one download at a
time, bounded retries, and no account cookies or proxy rotation. Site support is
determined by yt-dlp, with network and audio-only checks applied independently.
Historical Cobalt design documents are retained only as retired records.

## Verified progress (2026-09-25)

- API image `img-captain-api:65` deployed with only the new downloader settings.
- Downloader image `img-captain-music-mute-ytdlp-test:5` passed authenticated
  HTTP Facebook and YouTube acquisition, full decode, zero-video and cleanup.
- Facebook import `6ab6d70a354498106c8cf933` produced MusicMute job
  `6ab6d718354498106c8cf935`; public polling observed `ready` after worker output.
- Local backend verify: 860 unit tests, 146 HTTP tests, format/lint/typecheck,
  secret checks and build passed. Native infrastructure test and all five import
  integration tests passed. Production dependency audit found no known issues.
- The first deployment health sample briefly returned 522; subsequent public
  Cloudflare and direct-origin health checks both returned 200. Python urllib
  from the VPS receives a separate public 403; real Node API calls passed.
- Local downloader suite now has 21 passing tests, including real socket
  disconnect/process cleanup and WAV-to-AAC normalization. Its final image
  update and complete YouTube-to-worker proof subsequently passed (see below).
- Cobalt app is absent. Old backend adapter, provider gate and configuration keys
  are removed. Historical user specifications remain marked retired.


## Completion evidence

Final downloader image `:6` is healthy and its exact source hashes match this
checkout. All 21 tests also passed during its CapRover build. YouTube import
`6ab6d8d66e4c49edc7b903a1` produced job `6ab6d8e96e4c49edc7b903a3`, which reached
`ready`. Authenticated downloads of both Facebook and YouTube processed outputs
passed complete decoding; their temporary validation files were removed.

The final saved API hook has no Cobalt fallback. API environment keys contain no
Cobalt settings or provider allowlist. The obsolete key and temporary test session
were removed, and test refresh tokens revoked. The old helper is inert at zero
replicas; it is not a dependency of the new system.

A controlled restart was performed only after the database showed zero active
imports. The operator SSH connection dropped during observation; a fresh check
of the same Swarm update proved `completed`, a newly started healthy `:6`
container, and no seeded/abandoned media. No second restart was issued. Public
API readiness was independently rechecked as HTTP 200.

Detailed results, limits, commands and source links are in [results.md](results.md).
No mobile changes, Git commit or push were performed.
