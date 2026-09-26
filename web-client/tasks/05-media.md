# Imports, jobs, library and playback

## Shared HTTP behavior

Use HTTPS API origin plus root routes, Firebase bearer tokens, snake_case wire
JSON, documented installation headers and cursor pagination. Implement bounded
401 refresh/retry, stable UUID request IDs and reconciliation after ambiguous
writes. Respect 429 `Retry-After`; do not retry validation/quota errors blindly.
Never forward a Firebase token to S3. Do not log tokens, private URLs, audio data,
or private account data. Cancel stale requests and clear UID-scoped query/player
state on account change or logout.

## URL import

Use existing `POST /media-imports` and owner-scoped import reads. Submit the URL,
request ID, and supported options exactly as OpenAPI requires; poll until a job
is assigned or failure is final, then follow that job. Do not download provider
media in the browser or add third-party downloader services. Handle disabled
imports, unsupported/single-item sources, invalid/private URLs, capacity and
size/duration failures. Preserve source title and attribution.

## Local audio

Study the actual policy and Android preparation before picking libraries. The
current profile is `audio-cap-aac-lc-160-v1`: preserve compatible audio where
permitted and convert only when required. The current standard ceiling is 20
minutes/50,000,000 prepared bytes, with separate source/preparation bounds;
server policy can lower limits, so do not use these numbers as unconditional
admission promises. Local video is explicitly excluded.

Implement audio selection/drag-drop, metadata and size/duration inspection,
review/rights confirmation, trim choice, preparation as needed, exact prepared
byte SHA-256, reservation, signed upload with progress, upload confirmation,
and authoritative job progress. Read upload-grant headers and methods from the
API; do not infer them from `S3FormUploader`'s historical name (grants use PUT).
Use the same request ID for a retry of the same logical submission.

Do a focused feasibility check for browser audio preparation early. Native
browser codec support varies. Prefer a small proven parsing/preparation path;
use lazy-loaded worker-based conversion only if required for meaningful format
coverage, with cancellation, time/memory bounds and an explicit dependency
justification. Do not blindly upload unsupported/high-bitrate audio, lie about
the preparation profile, relax backend validation, or silently narrow the
feature to one format. Document supported formats and actionable rejections.
If WASM needs special response headers, validate Firebase popup/auth and asset
loading compatibility before choosing them. Avoid eager transcoder downloads.

No background upload survival promise after the tab closes. Preserve lightweight
operation IDs for reconciliation where safe, explain interrupted preparation,
and prevent duplicate submissions on reload or repeated clicks.

## Jobs and library

Map all server statuses and errors from current source/OpenAPI; show real phase
progress or indeterminate progress rather than fabricated percentages. Use
visibility-aware bounded polling with cleanup, backoff and rate-limit handling.
Do not introduce a new client WebSocket endpoint: the existing worker hint socket
is not an end-user job channel. Implement supported cancel/retry/rename/delete
operations and their confirmation/reconciliation semantics.

Use server-backed history/results across the same account. Favorites and hidden
tracks may use UID-scoped lightweight local preferences to match Android's
current semantics. Exclude downloaded/offline-only library filters. Distinguish
hiding an item from deleting server data. Include pagination, search/sort,
expired/deleted results and empty/error/loading states.

## Playback and export

One shared HTML audio engine persists across navigation; components subscribe
to its state. Map Android queue, play/pause, seek, next/previous and any existing
speed/repeat/shuffle behavior through the parity inventory. Respect autoplay
restrictions and handle buffering, media errors and interrupted playback.
Request private download grants on demand, refresh expired grants with bounded
recovery and preserve position when feasible. Avoid a grant request per render.
Support browser downloads and Web Share where supported, with a download
fallback. Do not store signed URLs in localStorage, URLs, analytics or logs.
Media Session support may be added progressively; native background guarantees
must not be claimed. Release object URLs/resources and stop playback on logout.
