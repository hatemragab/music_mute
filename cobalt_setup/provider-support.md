> Retired Cobalt design/evidence. Do not use these deployment instructions. The active replacement is [yt-dlp](../ytdlp_test/README.md), tracked in its [migration plan](../ytdlp_test/migration-plan.md).

# Cobalt provider expansion — 2026-09-25

The owner requested all Cobalt sites, then explicitly reaffirmed **audio-only
acquisition: no temporary video downloads**. The original no-transcoding,
single-item, private-service, and Cobalt-only requirements still apply.

Cobalt's [official service table](https://github.com/imputnet/cobalt/blob/main/api/README.md)
describes output formats, not necessarily the media downloaded upstream. An
“audio supported” check mark often means downloading video and extracting audio.
That does not meet MusicMute's acquisition rule.

## Reviewed capabilities

Reviewed the exact running official source revision
`a636575b09de1fc55d9b8cd98cac88f5f2f16b42`, also the current upstream HEAD on this
check. Existing official image digests are unchanged. No fork, adapter, alternate
extractor, cookies, proxy, client identity override, or network change was added.

| Cobalt service | Audio-only path under current rules | Live evidence on this VPS |
| --- | --- | --- |
| YouTube | Separate native M4A/Opus; watch, Shorts, music, embed, archived live links | Native tunnel returns empty HTTP 200; direct 64 KiB ranges work but HEAD/8 MB/full transfer fail; unavailable |
| SoundCloud | Single native progressive MP3/Opus track | Previously verified through S3, worker, and output download |
| Bilibili | Separate DASH audio resource; individual item/part | Two metadata samples returned `error.api.fetch.empty`; not enabled |
| Reddit | Separate DASH audio URL, never video fallback | Metadata returned `error.api.fetch.fail`; not enabled |
| Newgrounds | `/audio/listen/` native MP3; reject `/portal/view/` | Official audio test fixture returned `error.api.fetch.critical`; not enabled |
| Tumblr | Native MP3 audio post; reject video-to-audio response | Native transfer verified: 17,344 bytes, 1.071020 seconds, one MP3 audio stream |
| TikTok | Only native MP3 proxy response; never request full alternate soundtrack | Tested video returns a video-extraction recipe (`audio`, M4A, copy); rejected before fetching its tunnel |
| Bluesky | Current extractor supplies HLS video | Rejected before Cobalt/media acquisition |
| Dailymotion | Current extractor supplies HLS video | Rejected before Cobalt/media acquisition |
| Instagram | Current extractor supplies muxed video | Rejected before Cobalt/media acquisition |
| Facebook | Current extractor supplies muxed video | Rejected before Cobalt/media acquisition |
| Loom | Cobalt disallows audio mode | Rejected before Cobalt/media acquisition |
| OK.ru | Cobalt disallows audio mode | Rejected before Cobalt/media acquisition |
| Pinterest | Current extractor supplies video/images | Rejected before Cobalt/media acquisition |
| Rutube | HLS video or Yappy muxed video | Rejected before Cobalt/media acquisition |
| Snapchat | Current extractor supplies video/picker | Rejected before Cobalt/media acquisition |
| Streamable | Current extractor supplies muxed MP4 | Rejected before Cobalt/media acquisition |
| Twitch clips | Current extractor supplies muxed clip | Rejected before Cobalt/media acquisition |
| Twitter/X | Current extractor supplies video/picker | Rejected before Cobalt/media acquisition |
| Vimeo | Separate audio HLS exists, but this official Cobalt path uses server processing; local fallback can be video | Rejected under the native/no-Cobalt-transcoding rule |
| VK videos/clips | Cobalt disallows audio mode | Rejected before Cobalt/media acquisition |

All seven native-capable provider names are implemented in URL admission, Mongo
validation, environment validation, and source-reviewed response gates. This is
not a claim that all seven are live-enabled or reliable. Unknown sites retain
`IMPORT_UNSUPPORTED_PROVIDER`; recognized incompatible sites return
`IMPORT_UNSUPPORTED_AUDIO_SOURCE`. An internal tunnel is accepted only when its
provider, response type, format, origin, path, and single-stream shape match the
reviewed native branch. No fallback downloads video after a native failure.

## YouTube findings

The earlier report over-attributed YouTube unavailability to the session helper.
The default `1080`/`h264`, audio-only, non-HLS request uses Cobalt's normal iOS
client without the optional helper. The integration now makes these request
settings explicit and disables better-audio/session selection and full TikTok
audio. This changes neither the upstream client identity nor the media policy.

Both `aqz-KE-bpKQ` (Blender Big Buck Bunny) and upstream fixture `vPwaXytZcgI`
resolved to single native M4A tunnels. Actual transfer returned 200, length 0,
no content type, and no bytes. A bounded Opus attempt on Big Buck Bunny also
returned no bytes. Empty files were rejected and temporary files removed.
No S3 job was created for these failed acquisition probes.

Follow-up source and live request audit found a more specific failure: on one
fresh signed native-audio URL, HEAD returned 403 while GET with a 64 KiB range
returned 206 and 65,536 bytes. A second same-URL matrix read the first two 64 KiB
ranges successfully, while Cobalt's own `bytes=0-8000000` range returned 403.
Separate fresh-URL full GET and full-range GET probes also returned 403. These
results do not prove a blanket IP block, a working full download, or that merely
removing HEAD would fix Cobalt. Its official stream handler masks an upstream
403 as an empty 200; an isolated test of that unchanged function reproduced it.
See [the detailed diagnostic report](youtube-diagnostics.md) for evidence,
configuration, upstream documentation, and remaining uncertainty.

The optional official helper remains incompatible (`POST /get_pot` versus
`/token`) and stopped. It was not silently replaced. Neither a metadata-only
success nor a healthy container establishes a working YouTube import.
Its stale `YOUTUBE_SESSION_SERVER` setting was removed from Cobalt at
2026-09-25T18:35:53Z to stop polling an intentionally stopped service. Saved and
running configurations were verified, with zero helper errors after restart.
SoundCloud and Tumblr native downloads/probing passed again; temporary
directories were empty and API readiness was 200.

## Tests and deployment

- `pnpm run verify`: 913 unit tests, 146 HTTP tests, formatter, lint, type checks,
  secret checks, and build passed.
- `pnpm run test:imports:integration`: all five integration tests passed,
  including the added Tumblr admission → Mongo persistence → native HTTP source
  → measured audio → immutable upload → confirmation → cleanup case.
- Production deployment and final enabled providers are recorded below after
  verification. Other live checks above fetched bounded metadata only, except
  the explicitly identified native audio transfers.

API review used the current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-25: OpenAPI (101), security (104), and backwards compatibility (106).
The existing authenticated routes, snake_case response, and upload/worker
contracts remain unchanged; provider acceptance is additive.

### Final release-64 evidence

- Deployed **`img-captain-api:64`**, preserving the existing official Cobalt image.
  Archive SHA-256:
  `377b782a5bd07c0ad6049e3a1f677de4c304534df4ede08bea9abc1960719274`.
- Enabled **`URL_IMPORT_PROVIDERS=soundcloud,tumblr`** only after the controlled
  Tumblr job completed and its output was downloaded/probed.
- Controlled Tumblr import `6ab6be100ac77b90f078aeb1`, processing job
  `6ab6be134790e4cd7b2be890`: **ready**.
- Then verified the public API: Tumblr import `6ab6be52e7e63858701c84b1`, job
  `6ab6be55e7e63858701c84b3`: **ready**, actual output downloaded/probed.
  Native input 17,344 bytes / 1.071020 seconds; MP3 output 21,986 bytes /
  1.071020 seconds. Temporary result and import directories were empty.
- Public checks also passed: unauthenticated 401; playlist rejection; video-only
  Instagram rejection before acquisition; disabled YouTube rejection; duplicate
  request ID returns the same import.
- To roll back this expansion, restore the provider allowlist to `soundcloud`,
  then roll back the backend to release **63** through CapRover. Preserve the
  existing key hook, queues, S3 objects, and other app settings.
- No Android changes or device tests. No commit or push. Existing unit/HTTP
  suites and import integration checks passed; the earlier release-63 old-upload
  live proof is historical evidence, not a new release-64 upload smoke test.
- Final runtime audit: API 1/1 on release 64, public readiness 200, providers
  `soundcloud,tumblr`, zero temporary import entries. Test login tokens were
  revoked and the temporary test credential file removed.
