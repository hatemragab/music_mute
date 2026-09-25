> Historical qualification plan. Superseded by [migration-plan.md](migration-plan.md), which authorizes production integration and Cobalt retirement.

# Isolated yt-dlp CapRover audio test

Date: 2026-09-25. Owner authorized creation, deployment, and testing of a new
CapRover app. This is not authorization to integrate NestJS or remove Cobalt.

## Scope and success criteria

- Create private `music-mute-ytdlp-test`, one replica, no public domain/host ports.
- Keep all existing apps, Cobalt configuration, NestJS, S3, and user jobs untouched.
- Operator-only CLI test runner; no public download API or arbitrary URL proxy.
- YouTube single-item URLs only for this qualification. Native audio only,
  explicitly `bestaudio[vcodec=none]`; never use `-x`, muxed fallback, or video.
- A successful test requires the entire file, verified byte count/hash, audio
  tracks only, measured duration, full audio decode, and removal of temporary data.

## Author guidance reviewed

1. [Installation](https://github.com/yt-dlp/yt-dlp/wiki/Installation) and
   [README](https://github.com/yt-dlp/yt-dlp): use official yt-dlp; the authors
   recommend nightly for regular users and troubleshooting. Resolve and pin a
   current nightly and dependencies; record installed versions.
2. [EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS): install matching challenge
   scripts bundled in the official executable (or the default dependency group)
   and supported Deno (recommended).
   Pin Deno and verify its release checksum. No runtime remote script downloads.
3. [YouTube extractor guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors):
   begin with default clients, no account cookies. Add 5–10 seconds between
   downloads and conservative request pacing. Account login is not a routine fix.
4. [PO-token guidance](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide): if
   default clients fail, assess the recommended mweb/token-provider setup using
   the provider author's instructions. Do not invent tokens or use personal cookies.

Rate pacing reduces unnecessary requests; it cannot guarantee an IP will never
be restricted. Keep normal VPS egress. No VPN, proxy rotation, IP changes, or
account-cookie collection. Stop on access/rate refusal instead of retry storms.

## Implementation

- [x] Record existing app/image baseline and verify deployment access.
- [x] Build a small non-root container with yt-dlp, Deno, and FFmpeg/FFprobe.
- [x] Enforce one active test, bounded size (50 MB), duration (20 min), wall time,
  conservative retries, fragment concurrency 1, and 5–10 second download delay.
- [x] Use an isolated temporary directory in a bounded 256 MiB tmpfs per test and cleanup on success,
  failure, interruption, and restart. Emit only sanitized result metadata.
- [x] Create/deploy through CapRover and verify private exposure and healthy process.

## Test sequence

- [x] Offline tests: URL rejection (playlist/foreign host/credentials), limits,
  audio-only selection, concurrent-run rejection, errors, and cleanup.
- [x] Runtime versions and dependency checks.
- [x] One complete permitted YouTube item larger than 1 MiB (previous failure point).
- [x] If successful, two more controlled permitted items, including another URL
  shape; no load test or automatic repeated polling.
- [x] Verify rejection/timeout/interrupt cleanup without extra upstream load.
- [x] Recheck existing API/Cobalt health and unchanged images/configuration.
- [x] Record exact results and remaining restrictions in results.md.

If blocked, preserve the isolated app and report the actual refusal and tested
setup. Do not connect it to NestJS or claim production readiness. No commit/push.

Final outcome: three distinct full native-audio downloads passed, with repeat
verification on image :4 and its final tmpfs configuration. See [results.md](results.md).
