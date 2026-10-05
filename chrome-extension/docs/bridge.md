# Local bridge contract

Preflight: the official [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read again on 2026-10-02. Portable rules shaping this private bridge: #100
contract-first review, #106 compatibility, #167 JSON interchange, #118 snake_case
properties, #177 no public stack traces and #200 private event data. No Zalando registry, OAuth
server or production backend endpoint is added. Native Messaging is framed JSON,
not REST; its commands use protocol_version and bounded request IDs rather than
REST resource mutations.
The policy-7 acquisition/cache changes preserve the native v1 schema and exact
three-field START contract. They add no REST endpoint, route, auth scope or media
transport change.

Diagnostic timing labels use a fixed allowlist of qualified engine stage names;
arbitrary prefixes and private labels are not exported. Cache replay records the
current lookup, validation and media-grant durations. Historical inference
timings remain in retained result metadata and are not emitted as work performed
by the new job. Setup reports retain bounded errors/warnings separately from the
recent event tail; absent older fields remain compatible with the app decoder.

New native diagnostic reports and records carry an additive `identity` object:
`software_version` is the component's version, `runtime_scope` is `PACKAGED_APP`
or `DEVELOPMENT`, and `expected_model_sha256` is the pinned model expected by
that component. Packaged processes can also include `package_inventory_sha256`,
the SHA-256 of the bounded, owned `bundle-audit.json` read once per process.
Only approved scalar fields leave that inventory. The fingerprint identifies
the package inventory; it does not claim fresh signature verification, complete
installed-byte verification or the build loaded into Chrome. Missing, unsafe or
unreadable inventory leaves the fingerprint absent without failing processing.
The inventory limit is 8 MiB. The Swift app journal uses the same object.

Identity is recorder-owned, never accepted from a browser event. Hydration keeps
each historical record's validated identity; legacy absent/null identity remains
unknown and is never replaced with the current recorder's identity. Successful
pipeline/cache records separately include top-level `verified_model_sha256` only
after existing result/model validation, through a trusted native recorder method.
Generic browser events cannot supply that verification field. Cache replay emits
verification only when the retained result contains provenance written by the
trusted native pipeline after validation. Legacy and unverified caches remain
usable without gaining a verification claim, and provider result fields cannot
create that provenance. A cache hit does not claim new inference; fixture
preparation does not claim model verification. The expected model is not proof
that inference ran. Legacy schema-version-1 consumers may ignore these optional
fields.

Mac app `snapshot`/`export` responses also bound the combined processing, setup
and app-journal summary to the complete 64 KiB control envelope. Older detail is
trimmed with explicit coverage markers; the separately saved full export is not
rewritten by summary compaction.

Native executable com.musicmute.local accepts only its registered exact extension
origin. Native messages are little-endian 4-byte lengths with maximum 64 KiB JSON.
Known commands: HELLO, START, STATUS, CANCEL, CLEAR_CACHE, EVENT, DIAGNOSTICS,
and negotiated PLAYBACK_STARTED. START accepts only
video_id, duration_seconds and provider. It never accepts arbitrary source URLs,
file paths, model names or command arguments. Runtime types are in
src/shared/protocol.ts; FrameDecoder/validateCommand enforce the host boundary.

The native provider chooses best audio within supported HTTPS/materialized DASH
transfers and accepts one exposed language/preference profile. Ambiguous language
profiles, described audio or unverified/mismatched selected metadata are refused
with safe `SOURCE_AUDIO_TRACK_*` errors. Only the accepted format's projected
transfer metadata reaches the guarded downloader through bounded stdin
(`--load-info-json -`). Webpage/original/additional URLs, entries and private
extractor fields are omitted, preventing automatic fresh webpage extraction at
download time. Googlevideo HTTPS URLs and materialized DASH fragments/base URLs
are validated; returned identity is checked before inference. This internal
profile fence does not prove full original/default track ID or player-selected
audio matching. No transfer metadata is added to START, page DOM or exports.

Cache recipe 7 retains `source:"default"` as the processing policy label, rejects
wrong-model cache metadata and prevents recipe-6 cache reuse. That label is not
evidence of the player's selected track or current upstream audio identity.

HELLO reports transport readiness/version/platform/limit. Local inference readiness is deferred until cache misses need it. JOB reports full job
snapshots; every job has a UUID and requested video identity. ERROR uses a typed
safe error_code. REPORT returns a compact sanitized report and local export path.
No stdout logging or binary audio is mixed into this control pipe.

The saved desktop choice is exposed through additive HELLO `processing_provider`.
New browsers negotiate `processing_selection_v1`; older clients receive the
legacy capability list. For cloud, a token-free `processing_scope` binds the manual
Start to the native account/session without a per-video Chrome confirmation.
A new HELLO and START recheck the
saved choice and owner; changes stop submission. START keeps its exact three
fields, with `ONLINE_MUSICMUTE` now routed through native-authorized backend YouTube URL import; no local original transfer is required.
Cloud readiness does not load or require the local separation model.
Account credentials stay in the same signed app executable's headless IPC;
none are returned over Native Messaging. Cloud output passes full-timeline recipe/duration checks and transfer checksum validation before loopback delivery. See
[processing selection](processing-selection.md) for the complete flow and limits.

`background_publication_v1` is an additive HELLO capability. Chrome first sends
the legacy empty HELLO. New companions add the optional boolean
`background_publication_supported:true` while preserving the legacy capability
list; legacy Chrome can ignore this field. New Chrome requests the capability
in a second HELLO only after that support flag, and the companion includes it
in its capability list only after that request. Old companions never receive
the new command. After the trusted
extension offscreen player reports `playing:true` for the active generation,
Chrome sends `PLAYBACK_STARTED` with exactly `job_id` and `video_id`. The
companion validates the current READY local job and requested video before
releasing its durable shared contribution for background publication. Page
diagnostics cannot release publication. Successful acknowledgement is latched
for that session; a failed acknowledgement leaves playback running and makes
at most six command attempts, with exponential delays capped at five seconds.
Retries require the same READY local job and the last trusted playing state.
Pause, Stop, navigation and native-port loss cancel them. These are bounded
mutation retries, with no status polling or repeated page playback signals.

READY snapshots may add `save_state:"pending"|"saving"|"saved"`. These saving
updates use the existing job subscription and do not reload the same media
grant or restart audio. The page receives the safe save state, with no paths,
grants or publication capabilities. While vocals play, pending/saving shows
**Playing vocals · Saving in background**; saved restores the normal playback
guidance. After a pause, the panel shows **Vocals ready · Saving in background**
until the receipt arrives, then restores the ready guidance. Ad guidance retains
priority. Source fixtures prove these bridge fences, not installed or live speed.

The companion serves GET/HEAD /media/{job_id} on an ephemeral 127.0.0.1 port only. A
per-session unpredictable capability authenticates read-only media. Because an
HTML media element cannot set Authorization, this private media transport uses
a capability query rather than REST Bearer headers. This is an intentional
scoped deviation: the URL stays exclusively in extension-owned contexts, is
never logged/exported/inserted into YouTube, expires and is revoked on teardown.
Exact extension-origin CORS and Host validation supplement the capability. A
privileged extension media request in tested Chrome 154 omits Origin; it is allowed
only with valid capability and exact loopback Host. Explicit foreign origins are
rejected and OPTIONS requires the registered extension origin. This
exception does not apply to MusicMute backend bearer tokens, WebSocket tickets
or other application credentials.

200 full media, 206 single range, 416 unsatisfiable range, 403 failed origin/auth,
405 unsupported method; HEAD has headers only. Content-Type, Content-Length,
Content-Range, Accept-Ranges, no-store and no-referrer are explicit. Media maps
internally to known output files; no path traversal or arbitrary file endpoint.

Output preserves time: trim_enabled=false, duration/checksum/model identity and
no removed samples. Encoder delay and timing metadata required by future providers must be qualified
during actual audiovisual testing. Browser media-clock agreement alone
does not measure speaker/display latency or confirm an alternate-language track.

## Browser ownership hardening — 2026-10-04

The private JSON bridge keeps protocol v1 and the exact native START payload.
Renderer messages now validate booleans, bounded timing/volume/rate values,
generations, error categories and job/media shape at runtime. Page job output
uses an explicit public-field projection; future native properties cannot leak
into page messages. Audio notifications are accepted only from the extension's
exact offscreen document, and the offscreen document accepts commands only from
its exact background worker. Page ownership includes Chrome's document ID when
available, so a reused tab cannot impersonate a retired document.

Failure cleanup uses the same stop path as explicit cancellation: silence audio,
retire page ownership and cancel the captured native job/grant. Failed manual
jobs no longer block a later automatic start. A command timeout disconnects its
native port, preventing a late START from retaining orphaned work. Failed message
delivery or a 90-second missing-page lease retires ownership; the lease tolerates
minute-batched clocks from paused hidden tabs. Fresh clocks update the lease.
Offscreen stale-clock silence remains a separate five-second audio safety
boundary measured from the sample timestamp, not delayed receipt. Pending play
requests also expire; their later completion cannot restart audio. Fresh pause,
seek, buffering and ad clocks still suspend replacement audio immediately.
Timing correction uses bounded pitch-preserving rate adjustment for small drift
and guarded hard realignment for initial playback, source seeks or sustained
large drift. These are playback changes with no message schema changes.

Manual and automatic starts share route/media freshness validation. The muted
original video's flag is distinct from the user's vocal-mute preference; the
panel mute action and the actual YouTube mute button/M shortcut control that
preference, while ad audio retains YouTube's native behavior. Idle pages have no
periodic clock timer and unrelated comment/recommendation DOM changes do not
rescan the player.

The [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reviewed on 2026-10-04 for contract-first compatibility, bounded JSON,
non-sensitive errors and private event data (#100, #106, #167, #177, #200).
This is internal Native Messaging, not a new REST API.
