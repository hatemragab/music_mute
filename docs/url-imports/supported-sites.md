# URL import admission and provider support

Updated 2026-09-28 after removal of the self-hosted downloader.

## Current acquisition support

The private [VideoScale adapter](../../video_providers/videoscale/README.md)
accepts public, single-item links for the shared catalog, now including Instagram
(posts/Reels), TikTok and Vimeo, as well as YouTube, Facebook/Reels and SoundCloud.
It requests audio-only formats;
NestJS independently validates bytes and duration before R2 upload and processing.
Unsupported platforms return `IMPORT_UNSUPPORTED_PROVIDER`. No extractor catalog,
local downloader or downloader-based qualification command remains in this project.

## Client admission

The shared client catalog is
[`supported-audio-sites.json`](../../web-client/src/site-policy/data/supported-audio-sites.json).
Web imports it directly; Android and iOS bundle the same resource. The
[URL fixtures](../../web-client/src/site-policy/fixtures/url-policy-cases.json)
cover narrow item paths and rejection of malformed or unsafe URLs.

The bundled catalog lists twelve sites. The adapter admits their narrow item
shapes, but **admission is not successful acquisition evidence**. Only YouTube has
current end-to-end provider evidence. Historical extractor metadata is retained
as historical evidence only; new entries have null evidence rather than invented
results. Provider-managed HLS/DASH audio and AAC-HE are eligible, not muxed video.
New native catalog entries require rebuilding/releasing Android and iOS; server
deployment alone cannot update already installed client allowlists.

Client admission is a UX check, not authorization or server-side URL validation.
Private destinations, playlists, unsupported shapes and unsafe URLs must still
be rejected server-side. Live job/import updates use existing authenticated
WebSocket snapshots, not timer-driven HTTP polling.

## Qualification and maintenance

The [2026-09-26 report](qualification-2026-09-26.json) is historical metadata-only
evidence from the removed implementation, not current provider support.

The owner authorized enabling these sites for per-link evaluation before live
qualification on 2026-09-28. To qualify them through the chosen SaaS adapter, verify actual
audio-only acquisition, transport safety, media validation, bounded size/duration,
failure behavior and cleanup. Keep the shared catalog and accepted/rejected
fixtures aligned, run the three clients' policy tests, and rebuild the clients.
Do not describe upstream advertised support as successful MusicMute E2E proof.

Save only sanitized qualification fields. Never retain credentials, temporary
media URLs or raw provider payloads. See [deployment evidence](../../video_providers/videoscale/docs/DEPLOYMENT.md)
for the last verified import, R2, worker and cleanup result and its limitations.
