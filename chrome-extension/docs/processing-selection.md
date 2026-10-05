# Saved processing selection

Home and Preferences share the existing `desktop.processingMode` setting. The
default is **On this Mac**. Changing the selector saves the preference immediately;
confirming a Chrome-to-app cloud handoff also saves the cloud choice. Changing a
preference does not start processing or move an active request to another provider.

Chrome resolves the current choice from the native app for every new request.
Cloud requests require a manual Start and a signed-in app account. Start proceeds
directly using the saved processing choice and that account's monthly allowance,
without a per-video Chrome confirmation. Automatic preparation never submits cloud
work. A mode or account change before submission stops it and requires a fresh
Start.

For cloud processing, the native companion submits the canonical YouTube URL to
`POST /imports/youtube` with `trim_enabled: false`, exactly as native URL intake.
No local YouTube acquisition, original validation, AAC conversion, source upload
or local model readiness gates this path. Existing server admission and processing
allowance rules apply. An ambiguous intake is never automatically repeated, and
failures never change providers. Raw WebSocket snapshots drive completion. The
returned full-timeline recipe and duration are checked, and vocals are hashed while
downloading against the authenticated server declaration. The server validates
media; Chrome performs playback decoding. Chrome receives only the protected
loopback media grant. Account and cancellation fences remain in place.

Local mode requires no account, email verification, account configuration or
cloud quota. It checks the owned cache, pending durable result, and optional shared
catalog before engine readiness. Missing shared configuration, guest credentials
or an unavailable service falls back to local acquisition and separation. Native
URL intake obtains metadata locally in that case. Cancellation and invalid shared
artifacts/timelines remain errors, and an already-started local pipeline is never
repeated. A request without shared access is not marked as a community result or
pending community upload. Uncached YouTube audio still needs internet access;
local files and retained vocals do not depend on the shared backend.

When sharing is available, a cache miss reserves a producer; a trusted original
already in private R2 can be downloaded and processed without consulting YouTube.
Otherwise local acquisition runs once. Its preflight probes metadata but does not
perform a throwaway decode before the engine's required decode. An app-owned
private socket service reuses RuntimePipeline and its MPS model across requests,
serializes local work, unloads after two idle minutes, and retires on cancellation,
error or identity change. It does not change worker fleet runtime or credentials.
Checksum receipts are process-private, bounded to 60 seconds and invalidated by
file identity changes. Shared vocals are hashed during download without a second
FFmpeg decode. Durable community upload remains after playback acknowledgement.
Diagnostics include cold/warm engine state, cache/download/staging stages and
extension Start-to-first-playing time; ready timing includes cache admission.

The packaged companion invokes the signed app executable's headless native
bridge. Settings reads need no account configuration, Keychain access or network.
Session reads reuse the app's Keychain vault and Firebase refresh logic without
rotating or publishing its account scope. Bounded pipe replies carry the ephemeral
session only to the native companion. Tokens never enter Chrome messages, stored
preferences, account-state files or diagnostics. The authoritative native scope
is checked before/after refresh, acquisition, transfer and result publication.
Cancellation requests cancellation of a known remote job with a bounded command;
revoked accounts cannot authorize further commands.

Native protocol v1 retains the three-field START payload. Additive HELLO
`processing_provider`/`processing_scope` and negotiated `processing_selection_v1`
support the saved choice and token-free account/session fence. Older helpers
continue to use local processing; older browser clients do not receive an unknown
capability until they negotiate it.

The official [Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were reviewed on 2026-10-04. Portable rules #100 (contract first), #106
(compatibility), #167 (JSON), #118 (snake_case), #177 (safe errors) and #200
(private event data) shape this native IPC change. REST resource/status/OpenAPI
rules do not apply to the private pipe, and no backend route is added.

Validation uses isolated native, companion and browser-handler fixtures. Those
checks alone do not establish installed-package behavior, real account Keychain
access, live cloud admission/processing, YouTube source availability or listening
quality. The dated sections below record the narrower installed/reloaded evidence
separately.

## Current c141 visible local-mode warm-cache evidence — 2026-10-05

Current candidate `c14116b8` is installed. Chrome Secure Preferences confirmed
the final unpacked repository `dist` under ID
`dclpfemnpknfdlpcbfcjkmdbnociippd`; that reload preceded the app installation.
A later refresh of a real Stromae YouTube tab reached visible **MusicMute · On
this Mac** and **Voice-only playback**. The current c141 companion identity
matched `0.1.0` and its package inventory, then logged `cache_hit=true` and
`playback_started`.

This is installed visible local-mode routing and one warm-cache playback start.
It does not prove the uncached provider/downloader/MPS path, listening,
source-track identity, lip-sync, sustained controls or any cloud/account/R2
behavior. A direct c141 settings-bridge readback and registered-manifest HELLO
were not rerun; the 58d observations below retain that separate historical scope.

## Historical 58d55f40 installed local-mode evidence — 2026-10-05

Build `58d55f40-6789-42fb-9e02-5f3e43f5cc3f` (`CFBundleVersion`
`1791171228`) was installed at `/Applications/MusicMute Local.app`. Existing
unpacked extension `dclpfemnpknfdlpcbfcjkmdbnociippd` remained loaded from
repository `dist`; its core files matched the extension embedded in the installed
package, and the registered native manifest and launcher were exact. The direct
installed browser-processing bridge returned `processing_mode: local`. An exact
native-messaging HELLO through the registered manifest and extension origin
returned `ready: true`, `darwin`, `arm64`, version `0.1.0`, 1,200 seconds and
provider `LOCAL_MACOS`, and negotiated `processing_selection_v1`. The host exited
afterward and the GUI remained closed. This is protocol-level handshake and
on-disk loaded-bundle alignment, not a final popup UI observation.

Signed-out Library correctly omitted connected copy. The final readiness fix also
requires a valid first jobs snapshot for the current account and stream before
Home/Library can report connected; socket readiness alone is insufficient, and
disconnect/reconnect/account changes reset or fence stale readiness. No signed-in
session, cloud choice/job, quota, live WebSocket Library sync or R2 transfer was
exercised. This unpacked-profile check proves neither final popup behavior, fresh
Chrome/YouTube nor Web Store delivery.

Build `2ed7711e-7cd6-4b37-992f-c6fb02782812` (`1791168902`) is older history. Its
installed local-mode/popup evidence remains valid in its recorded scope, but it
predates the first-jobs-snapshot Library-readiness correction; 58d55f40
superseded it for that historical local-mode checkpoint, while c141 is the
current package/install candidate.

## Interim e2aa installed local-mode evidence — 2026-10-05

Build `e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6` (`CFBundleVersion` `1791167264`)
was installed at `/Applications/MusicMute Local.app`, and the preserved-profile
unpacked extension `dclpfemnpknfdlpcbfcjkmdbnociippd` was reloaded from that
bundle. The corrected popup displayed **Up to 20 min**, **Your Mac is ready** and
**Ready · processing stays on this Mac**. Local tools displayed **On this Mac —
Apple Silicon**. A direct installed bridge settings request returned
`processing_mode: local`; with the GUI quit, **Check again** launched the installed
native host and returned Ready. This establishes installed local-mode selection
and GUI-closed helper startup for that interim build. Later build `58d55f40`
above supersedes it for the historical source-final local acceptance.

The app remained signed out. No cloud selection, account session, quota,
WebSocket Library sync, R2 transfer or cloud job was exercised. The eight saved
local errors visible through the preserved Chrome profile are dated 2026-10-04
history, not fresh failures from this install. The unpacked-profile check also
does not establish a fresh Chrome install, YouTube acquisition/playback or Chrome
Web Store delivery. Earlier fixture-only limitations remain in force for those
separate scopes.

### Reload continuity (2026-10-06)

A local READY reload can reuse the existing grant for five seconds after immediate
offscreen silence. Native STATUS rechecks the saved processing choice and account
scope before rebinding the grant to the new document/generation. Cloud READY
results, changed source/duration, expired grants and superseded documents cannot
reuse it. Ordinary launch/separation trusts prepared contents; full installation
checks run only at setup/update or explicit popup Check again.
