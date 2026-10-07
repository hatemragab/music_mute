# MusicMute Local — macOS app and Chrome extension

GitHub download distribution now uses separate runtime component ZIPs from
`ahmed-dev-1/musicmute-downloads`, with pinned release URLs and hashes. Each
successful setup stage removes its downloaded ZIP. Kim Vocal 2 stays at its
approved upstream source. See [staged downloads](docs/setup-updates.md#staged-github-downloads--2026-10-06)
for the contract and development-release limits.

The 2026-10-04 setup and update work adds bundled Deno, matching yt-dlp/EJS and
the PO-token provider, offline component health checks, clear extension errors,
safe diagnostic copy/export, and an explicit cloud handoff to the Mac app. Home
shows the selected account's monthly allowance and reset date before cloud
confirmation. The Home **Process using** selection is saved on this Mac and also
controls new Chrome extension requests. **On this Mac** uses local separation
without an account, email verification or cloud allowance. Missing account
configuration or unavailable guest/shared services never authorize or block local
compute: fresh local acquisition and separation remain available. YouTube still
requires internet access to acquire uncached audio. **MusicMute cloud** submits
the YouTube URL through the signed-in account's import flow and uses its monthly
allowance. Both paths synchronize validated full-timeline vocals with YouTube.
Automatic starts require a manual start when cloud is selected. The separate
browser cloud handoff still prefills the Mac form for account review.
See [saved processing selection](docs/processing-selection.md) for the native
authorization boundary and verification limits.

Audio processing now accepts up to **20 minutes (1,200 seconds)** in Chrome and
the Mac app, matching Android. Chrome defaults to a 20-minute automatic limit;
saved shorter automatic limits are preserved. This update is checked by
TypeScript and native Swift compilation only; tests and E2E were not run.

Chrome auto-start is on by default for eligible playing YouTube videos, including
page refreshes and videos you choose next. A saved off setting is respected.
Refreshing waits for the previous page's playback to stop before starting the new
page; reselecting the same video begins a fresh visit. Paused videos wait for Play,
and the saved duration limit still applies.

Same-video player replacements preserve the current session and panel. Hidden
pages receive a bounded liveness check before their lease expires, and recovery
reattaches only a still-valid local playback grant without submitting new work.
See [playback interruption recovery](docs/playback-recovery.md) for the source,
diagnostic and qualification boundaries.

Chrome's popup, video controls, settings, error guidance and privacy page support
**English and Arabic**, including Arabic right-to-left layout. The **Language**
selector is available in the popup and the video's extension settings. Its default,
**Automatic (Chrome language)**, follows Chrome's UI language: Arabic regional
variants use Arabic and other languages fall back to English. Explicit English or
Arabic choices are saved in this Chrome profile and update open extension views
without restarting playback. Selecting Automatic restores Chrome detection.
The Mac app keeps its own language preference. Diagnostic codes and exported
technical reports retain their original identifiers.

Chrome starts the native helper after setup even when the Mac window is closed.
Idle Chrome connections release the helper so they do not block an app update;
active or paused playback retains its native grant until stopped. Sparkle provides
automatic and manual Mac update checks once a release feed and public key are
configured. Local builds show that updates are unconfigured. Chrome update reloads
wait for work to stop; unpacked extensions still need manual Reload. Apple signing,
notarization, public feed hosting and Chrome Web Store delivery remain deferred.
See [setup and verification](docs/setup-updates.md),
[bundled YouTube tools](docs/youtube-runtime.md) and
[Mac updates](docs/macos-updates.md). Deno and token support do not guarantee
YouTube guest acceptance.

YouTube requests now consult the permanent shared original/vocal catalog before
metadata acquisition or local separation. Chrome and native YouTube intake use a
Keychain-backed guest capability even when logged out. A cache miss reserves one
producer before download when the optional shared service is available; other
requests wait on native WebSocket snapshots. If its configuration, guest vault or
service is unavailable, local requests proceed independently without publication.
The
prepared pair is captured in a durable outbox and resumes publication without
another download or model run. Signed-in Library sync attaches a shared reference
instead of uploading a private duplicate. Personal file processing keeps its
account-private path. See [the backend contribution contract](../docs/url-imports/youtube-community.md)
for provenance, byte limits, recovery and release boundaries; this source change
requires the matching backend and companion release.

The 2026-10-05 Chrome local flow starts vocals after local validation and durable
retention, without waiting for shared audio uploads or backend publication. The
first successful extension-owned playback acknowledgement releases the exact
job/video/vocal pair for background saving. During playback, the panel shows **Playing vocals ·
Saving in background** while that save is pending. Shared-cache hits download
and validate the vocals only; they do not first download the original.

A detached native publisher keeps released bytes recoverable after Stop,
navigation or Chrome exit, including logged-out guests. Metadata declarations
can be admitted before playback to release acquisition capacity, but held pairs
do not upload media until playback starts. Upload attempts share one cross-process
lease, use bounded retry backoff, and resume on helper/app startup. The publisher
ends after 45 minutes if a network failure persists; the next startup resumes
the durable queue within the existing reservation expiry. Pending bytes retain
the existing storage limits. Cloud input upload remains before cloud processing.
This source is included in the c141 companion candidate and the final repository
`dist` was reloaded, but the matching backend admission change is still required
for end-to-end contribution behavior. The later c141 live checkpoint is a local
warm-cache playback start, not backend-publication or uncached-performance proof.

For direct DMG distribution, see the [macOS release guide](docs/macos-release.md).
Release signing and Apple acceptance are separate from the local checkpoints below.

## Home, account and product discovery

Native Home owns the cross-device account prompt. A signed-out user can start
Google sign-in there or open the email flow without navigating through Settings.
Every Google action must pair localized accessible text with the recognizable
multicolor Google G; a generic person or system-provider symbol is not the Google
mark. English and Arabic layouts must keep the same actions, reading order and
external-link meaning.

Authentication and synchronization are separate states. Successful Google or
email sign-in establishes the Mac's owner-scoped account session. The account
Library's realtime connection may still be connecting, offline or recovering;
local playback remains available in those states. Product links only open public
destinations. They do not transfer the Mac session, sign the browser in or prove
that Library synchronization completed.

Public destinations are centralized in the native `MusicMuteProductLinks`
allowlist:

- web app: `https://app.music-mute.com`;
- reviewed Android listing: `https://play.google.com/store/apps/details?id=com.hatem.musicmute`;
- future public Downloads section: `https://music-mute.com/#downloads`.

The allowlist accepts only those exact HTTPS destinations, with no credentials,
unexpected ports, tracking parameters or alternate routes, and opens them through
the system's external-navigation API. The Downloads section and Google Play URL
are discovery destinations, not evidence that a public macOS or Android download
currently exists. Do not invent a direct DMG, Firebase App Distribution, App Store
or other artifact URL. A public-download claim requires a current network or
release-registry check and must retain its own dated evidence.

## Current c14116b8 package/install checkpoint — 2026-10-05

The current local candidate is build ID
`c14116b8-cf2c-4865-8a24-f9f1dce2a119`, `CFBundleVersion` `1791212763`. Its
17,663,025-byte ARM64 app is ad hoc signed and installed at
`/Applications/MusicMute Local.app`. Package-to-installed readback matched all
139 file/link leaves, the build and architecture, and the app passed deep strict
signature verification. The external inventory SHA-256 is
`3e5d49e98f7147ac049224d36a1227b3ad46cb48f08711ff2f79f8762e00a276`;
the embedded `bundle-audit.json` file SHA-256 is
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`.

This compatible update reuses runtime
`macos-arm64-v1-c923b1be1f135d8c48ef81c9`, its 410,586,280-byte archive and the
existing verified model. The one-app/one-runtime/one-model base footprint is
1,381,918,937 bytes. The package remains unnotarized, `public_ready=false`,
`relocated_runtime_tested=false`, and Sparkle-unconfigured. Its package record is
`output/macos/build-c14116b8-cf2c-4865-8a24-f9f1dce2a119.noindex/package-result.json`.
The disposable package-only proof at
`output/packaged-tools-proof/e9fb0a01-33a0-44b9-b18a-391fe2130002.noindex/result.json`
passed all 15 checks, including offline staged-runtime validation, Setup/Status,
launcher repair, isolated Chrome registration and GUI-closed native HELLO. That
proof opened no installed GUI or browser, used no real profile, account or
Keychain helper, and performed no network transfer, model download or inference.

Installed full runtime verification created the private mode-0400
`runtime/verification-receipt-v1.json` below the MusicMute Local support root.
The authenticated receipt is a performance optimization, not a new readiness
authority: it is bound to the signed app build/CDHash, verification policy,
bootstrap and active identities, runtime/release/payload identities, and exact
inventory metadata. A later app or native-host process may skip repeated leaf
hashing and runtime signature checks only after outer-app validation and two
identical metadata fingerprints under the shared setup/update leases. A missing,
corrupt, unauthenticated or mismatched receipt, unavailable Keychain key, or any
bound identity/policy/metadata change falls back to full verification and then a
best-effort replacement receipt. This narrows cooperative update and in-scan
TOCTOU windows; it does not protect against a hostile same-UID writer after the
last check.

Chrome Secure Preferences confirmed unpacked extension ID
`dclpfemnpknfdlpcbfcjkmdbnociippd` at the exact repository `dist/extension`
path, with `last_update_time` `2026-10-05T15:19:15.409Z`. That reload preceded
the c141 app installation at 15:20Z, but `dist` was already final. After the
canonical c141 app launched and refreshed its receipt at 15:20:33Z, a refreshed
real Stromae YouTube tab reached visible **MusicMute · On this Mac** and
**Voice-only playback**. The c141 companion (`0.1.0`, package inventory
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`) logged
`job_started` at 15:27:46.294Z, `job_ready` at 15:27:46.366Z with
`cache_hit=true` and 66.157 ms elapsed, a 5.961 ms cache hit, and
`playback_started` at 15:27:46.902Z. The current session had none of the checked
native error codes, and the page log had no MusicMute warnings/errors. The page
advanced after proof and was paused. The captured state is
`/Users/hatemragap/.codex/visualizations/2026/10/04/01a107ce-edf1-74c2-bb3a-42e0d04cdb74/musicmute-c141-live.png`.

This was a warm-cache real-YouTube playback start, not fresh acquisition,
download or separation. It proves neither uncached provider/downloader/MPS work,
physical listening, selected-source identity, lip-sync, sustained playback nor
the wider controls/restart matrix. The installation was an ordinary update over
existing app data, not a clean reset or fresh Prepare. It does not relabel the
58d clean-Prepare, synthetic GUI/relaunch or direct local-mode HELLO evidence
below as c141 evidence, and adds no runtime-network, fresh-user, account/R2,
notarization, public-release or Web Store proof.

## Historical 58d55f40 clean-reset, Prepare and synthetic UI checkpoint — 2026-10-05

The then-source-final local package was build ID
`58d55f40-6789-42fb-9e02-5f3e43f5cc3f`, `CFBundleVersion` `1791171228`. Its
ARM64 app is **17,547,290 bytes**, ad hoc signed, installed at
`/Applications/MusicMute Local.app`, and exact across all 139 package/installed
file and link leaves, with no byte/link differences. Installation normalized only
the group ID; no bundle node is group/world writable. Deep strict signature
verification passed. The
external `final_inventory_sha256` is
`2fda53d1b4216db660fc11777e817527b282cfd25439423a8a7de48dc4a91a03`;
the embedded `bundle-audit.json` identity is
`9606d131c65fe59910dd77e5c82f6eac1b5dc09e465878fe0e45eecfb5f755b5`.

The exact runtime was `macos-arm64-v1-c923b1be1f135d8c48ef81c9`: a
**410,586,280-byte** ZIP with SHA-256
`9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`,
installing **1,297,496,698 declared bytes** across 18,031 leaves. The
**66,759,214-byte** model has SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
The base one-app/one-runtime/one-model footprint is **1,381,803,202 bytes**.
That package is unnotarized,
`public_ready=false`, `relocated_runtime_tested=false`, and Sparkle is
unconfigured. The final package and 15-check disposable proof are
`output/macos/build-58d55f40-6789-42fb-9e02-5f3e43f5cc3f.noindex/package-result.json`
and
`output/packaged-tools-proof/5d721f3c-235d-4577-9da2-33c35c756e3a.noindex/result.json`.

This build fixes the final audit gap in Library connection reporting. A socket
being ready no longer makes Home or Library say connected. The first accepted
jobs snapshot must be structurally valid and belong to the current account and
stream. Disconnect, reconnect, account change and stale completion paths reset or
fence readiness; pagination on the same ready stream preserves it. Native tests
cover wrong-account/wrong-stream snapshots, reconnects, pagination, teardown and
malformed pages.

For the 58d authorized clean reset, the previous app, support root, native
manifest, preferences and backups were first isolated at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-063747-final-58d55f40`.
The exact account-auth and guest-capability Keychain items were absent; delete
commands returned status 44. Worker state, the Chrome profile and repository
artifacts were preserved. The exact final app was installed into `/Applications`
and passed build, ARM64, inventory and strict-signature readback. After proof, the
`063747` archive was permanently purged; it is absent and unrecoverable. Earlier
`053140` and `055936` reset archives are also absent. The empty installer-created
`/Applications/.musicmute-backups.noindex` and old auxiliary paths were absent;
at completion the installed app was build `1791171228`.

Only the exact package runtime archive was preseeded at the expected
`.zip.partial` path with mode 0600 to avoid repeating its transfer. Prepare
validated it in 19,736.927 ms, downloaded and verified the model in 13,417.891 ms,
passed all six checks and showed **Ready** / **Mac ready**. Afterward the private
support/runtime/downloads directories were mode 0700, downloads was empty,
`active.json` was 0400 with the exact runtime/archive, the launcher was 0700,
and model/native manifest files were 0600. This does not prove the runtime URL,
DNS, TLS, CDN, redirects or HTTP Range/ETag path.

Signed-out Home showed Google/email actions plus web and Google Play links with
no stale media error. The GUI processed the exact 264,678-byte synthetic WAV in
`output/desktop-smoke/8eae9504-066c-424b-8935-00ed135f9e9e/` (SHA-256
`001d9f51f6ab3149daea19ac4188cbcfe3faf4cfe6e1b789e3c958cc15ba6703`).
It reported **Voice ready** in 58,356 ms, auto-played to 3.017 s and saved a
3.0-second, 62 KB offline Library entry. Quit/relaunch preserved it; replay loaded
with **Pause** at 0:00. The signed-out Library correctly omitted connected copy.

The existing unpacked Chrome ID `dclpfemnpknfdlpcbfcjkmdbnociippd` remained
loaded from repository `dist`; its core bundle files matched the installed
package, and the registered manifest and launcher were exact. The installed
settings bridge returned `processing_mode: local`. An exact native-messaging
HELLO through the registered manifest and extension origin returned `ready: true`,
`darwin`, `arm64`, version `0.1.0`, 1,200 seconds and `LOCAL_MACOS`, and negotiated
`processing_selection_v1`. The host exited afterward and the GUI stayed closed.
This is protocol-level handshake and on-disk bundle-alignment evidence, not a
final-build popup observation.

This is an existing development Mac, not a fresh OS user/machine. It adds no
runtime-network, real YouTube, listening, source-track, lip-sync, long-run,
signed-in account, cloud Library/R2, cloud-processing, notarization, public
release or Chrome Web Store proof. The Downloads landing destination and Google
Play destination were unavailable when checked and remain discovery-only. The
earlier checkpoints below remain useful history. At the conclusion of this 58d
run the GUI was closed; c141 above is now the current package/install checkpoint.

### Superseded 2ed7711e checkpoint — 2026-10-05

Build `2ed7711e-7cd6-4b37-992f-c6fb02782812` / `1791168902` retains its recorded
package, Prepare, synthetic playback and preserved-profile Chrome evidence, but
is not source-final. Final audit found that it could present Library connected
copy after socket readiness but before the first valid jobs snapshot. Build
`58d55f40` adds the account/stream-scoped snapshot-readiness fence and supersedes
2ed for current package and installed evidence. Its `055936` reset archive was
already permanently purged and is unrecoverable.

### Interim e2aa thin package and installed checkpoint — 2026-10-05

The interim local package is build ID
`e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6`, `CFBundleVersion` `1791167264`. The
ARM64 app is **17,524,330 bytes**, ad hoc signed and installed at
`/Applications/MusicMute Local.app`; the installed tree matched that package's
inventory and passes deep strict signature verification. The external
`final_inventory_sha256` is
`b182774d45d2cb24b5d6c529e596b2a2160d9403a2a1bfd2553c62f19f77b4d7`.
The companion's separate `package_inventory_sha256` is
`a0f4091d4d96e9bc734287ae1ede7ddb422ee5b776844c8dc335610e04fc9e53`,
the hash of the embedded `bundle-audit.json`; the two fields have different
scopes.

Its runtime is `macos-arm64-v1-c923b1be1f135d8c48ef81c9`. The exact runtime ZIP
is **410,586,280 bytes**, SHA-256
`9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`;
the installed release is **1,297,496,698 declared bytes** across 18,031 entries
(`du -sk` can show 1,309,552 KiB because it measures allocation). With the
**66,759,214-byte** verified model, one app, one runtime and one model total
**1,381,780,242 bytes**. Keep at least 2.5 GB free during the initial archive,
extraction and activation cycle.

The e2aa package record is
`output/macos/build-e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6.noindex/package-result.json`.
Its flags remain `notarized=false`, `public_ready=false` and
`relocated_runtime_tested=false`; Sparkle is present but unconfigured. The
disposable proof at
`output/packaged-tools-proof/25f5be61-a442-436b-bc26-b1c987c7f24b.noindex/result.json`
passed all 15 offline packaged-tool checks.

For the authorized e2aa clean app-data run, the previous app, support root,
native manifest, preferences and backups were initially isolated at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-053140-final-e2aa`.
Account-auth and guest-capability Keychain items were absent; their delete
commands returned status 44. The support root was absent before Prepare. To avoid
repeating a 410 MB development-machine transfer, only the exact package runtime
ZIP was preseeded, mode 0600, at the expected `.zip.partial` download path.
Prepare verified, extracted and activated it, downloaded and verified the model
(SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`),
passed all six readiness checks and showed **Ready** / **Mac ready**. This is clean
app/support-data proof, not runtime URL, DNS, TLS, CDN or HTTP Range/ETag proof.

Post-Prepare readback found private 0700 support/runtime/downloads directories,
an empty downloads directory, 0400 `active.json` selecting the exact runtime and
archive, a 0700 native launcher and 0600 native manifest. Signed-out Home showed
Google/email actions and product discovery with no stale media error. The GUI
processed the exact 264,678-byte synthetic WAV in
`output/desktop-smoke/8eae9504-066c-424b-8935-00ed135f9e9e/`, reported **Voice
ready**, advanced to 3.017 s and added a 3.0-second **Saved offline** / 62 KB
Library entry. After Quit/relaunch the entry persisted and replay advanced from
0.250 s to 3.017 s.

The existing unpacked Chrome extension
`dclpfemnpknfdlpcbfcjkmdbnociippd` was reloaded from the e2aa app. Its popup
showed **Up to 20 min**, **Your Mac is ready** and **Ready · processing stays on
this Mac**; Local tools showed **On this Mac — Apple Silicon**. The installed
settings bridge returned `processing_mode: local`. With the GUI quit, **Check
again** launched the native host and returned Ready. Eight saved local errors are
preserved Chrome-profile history from 2026-10-04, not new e2aa failures.

This remains an existing development Mac, not a fresh OS user or machine. The
synthetic run proves no listening quality, real source identity, long-duration
stability, account, cloud Library, R2 or cloud processing. The preserved-profile
unpacked extension proves no fresh YouTube acquisition/playback or Chrome Web
Store delivery. Earlier `1791161573`/`1791161574`, `67960e3f`, `cb26daf3` and
other candidate/build records below remain historical. E2aa superseded those
artifact checkpoints, then 2ed superseded e2aa, and 58d55f40 superseded 2ed for
the clean-reset/Prepare/UI checkpoint; c141 above is the current package/install
and warm-cache browser checkpoint. See
[the validation ledger](docs/validation.md#interim-e2aa-package-reset-prepare-and-ui-checkpoint--2026-10-05).

For the hardened browser ZIP, production-manifest Chrome tests, listing assets,
privacy disclosures and remaining store gates, see
[Chrome Web Store preparation](docs/chrome-web-store.md).

The account-connected desktop milestone is implemented in source and tracked in
[the desktop task ledger](docs/desktop-tasks.md). **On this Mac** remains the
default. Native Home offers an explicit **MusicMute cloud** choice using the
account's existing processing access and quota rules. Newly processed signed-in
local results are staged for background account saving; playback does not wait
for that save.

The historical 2026-10-03 local-lock and failure-diagnostics update was installed
as build `6d9cc6ac-c6d9-4501-ab9d-38dd9dbe86d1`. Its behavior and retained
diagnostics remain useful evidence, but current build `c14116b8` now owns
`/Applications/MusicMute Local.app`.
Activated Chrome attempts exposed `ENOENT` and `OUTBOX_BUSY` before downloading
or inference, while desktop account-cache restore was finishing. Source review
and temporary-filesystem regressions reproduced normal lock-release handoffs.
Short outbox contention now waits at most two seconds; cache acquisition retries
only disappearing locks and still refuses a verified live processing holder.
Ownership, inode, pin and storage admission protections remain intact.

Terminal logs now identify the fixed local job phase and exact allowlisted
filesystem errno. Downloader diagnostics separately distinguish bot/refusal,
incomplete or empty transfer, TLS, storage, postprocessing and bootstrap errors.
Raw tool text, file paths, account data and credentials remain excluded. The
extension gives clear local-save and missing-file guidance. Earlier generic
errors cannot be retroactively refined; see
[the acquisition observation and privacy guide](docs/downloader-privacy.md).

Fresh guest acquisitions remain serialized and spaced by five seconds, with a
15-minute hold after explicit bot/rate-limit responses. A durable pending marker
protects interrupted attempts and failed cooldown writes across helper restarts;
known refusals remain protected when cancellation races with them. Chrome cookies
are not imported. Verified cache/local-file playback remains available. Automatic
refused starts restore original playback under video/user-pause ownership checks.
One bounded native guest retry of the earlier 364-second source succeeded in
42.641 seconds without a cache hit, preserving its full timeline. That attempt
is separate from browser playback and future guest availability.

`npm run verify` passed all 1,376 tests in 46 files, 122-file zero-warning lint,
typecheck, build and formatting. Five companion JavaScript bundles and the
extension content bundle changed; 11,317 other file/link entries, native code,
extension permissions and the guest downloader runtime were preserved. All
11,326 installed file/link entries matched the package, including alignment of
all six companion bundles and content with current dist; deep strict signing
verification passed. The app remains ad hoc signed and not notarized, and the
preceding app is preserved in the hidden `.noindex` backup. Chrome started a new
helper with the installed package fingerprint after ordinary YouTube refresh.
The previously failing six-minute source then reached vocals in 48.285 seconds
from start without a cache hit, and actual Chrome playback resumed. A later
playlist source also completed fresh acquisition and inference. A controlled
next-video cache hit reached vocals while YouTube stayed out of focus; Pause,
original sound, Stop and saved settings were verified in current Chrome. Both
test players were left paused with original sound restored. These checks do not
establish future guest availability or listening quality.

The preceding acquisition-diagnostics update classified explicit bot/CAPTCHA, age/private/
member restrictions, missing/rejected playback PO tokens and HTTP 401/403/429
separately. Terminal errors take precedence over warnings and generic cookie
advice. Local terminal logs retain only the acquisition stage, process exit code
and explicit HTTP error status; raw tool output and account data stay excluded.
`npm run verify` passed all 1,057 tests in 42 files, 113-file zero-warning lint,
typecheck, build and formatting. Five companion JavaScript bundles changed;
11,318 other file/link entries, the native code, extension and guest downloader
were preserved. Installed file/link checks and companion dist alignment passed;
the package is still ad hoc signed and not notarized. See
[failure diagnostic details](docs/downloader-privacy.md#acquisition-failure-diagnostics).
No live YouTube request was made while installing that preceding logging update.
The later bounded run documented above supplies the new bot-refusal evidence;
historical generic failures still cannot be retroactively refined.

Earlier checkpoints confirmed actual Google/Firebase/backend sign-in and one
synthetic local-file owner original/vocals save with receipt cleanup in private
R2, using deployed API version 105. Saved sign-in access has now recovered in the
previous installed `82bd3515` app. Actual signed-in Library inspection confirmed the corrected
YouTube title and cached native playback, including Stop releasing its pin.
Chrome still needs extension Reload for the updated Stop and account-change
cleanup. Reconnecting native computer use to the newest app failed after its
restart, so its visual acceptance remains separate from the previous build's
verified title/playback. Mobile UI sync and listening quality remain pending.

## Current account-connected source

- Native Home accepts a public YouTube link or a selected audio file.
  Single-video watch URLs may retain playlist/radio/tracking parameters, and
  shortened `youtu.be` links use the same case-sensitive video ID. Playlist-only,
  ambiguous ID, credential-bearing or unexpected-host URLs are rejected.
  Local inference uses the packaged Kim Vocal 2/MPS engine with the complete timeline;
  it consumes no cloud processing minutes. Cloud processing requires an explicit
  selection and confirmation. Admission, storage and transfer allowances still
  apply, and a failure never silently switches providers.
- Home, Library and Settings source includes Google/email account flows, Keychain
  sessions, email verification, linked methods, device history, logout and account
  deletion/recovery. Google uses a registered Desktop OAuth client with
  state/PKCE and a bounded loopback callback. Public Firebase settings are
  packaged separately; credentials remain in Keychain. **MusicMute macOS
  Desktop** is now registered and its public client configuration is installed,
  with no client secret persisted. The real Google flow reached the correct
  chooser/passkey handoff but timed out after 180 seconds; its UI incorrectly
  labelled that timeout as cancellation. Native source now distinguishes timeout
  from cancellation and permits a bounded ten-minute wait; its two suites and
  loopback deadline/cancel fixtures pass; installed c482315f includes that timeout
  correction. A later user-approved Google flow returned to the loopback callback
  but failed at token exchange before Firebase/backend sign-in. A bounded
  dummy-code probe of the official token endpoint identified that this registered
  Desktop client requires its client secret. No user credential was used in that
  probe. The native source now calls the fixed-client backend
  `POST /auth/desktop-google-token-exchanges`; the client secret remains backend-only.
  Only a Google ID token returns to the existing Firebase sign-in flow. Both native
  suites, full Swift 6 typechecking and formatting/localization checks pass for
  the adapter. The additive backend route has strict loopback/PKCE validation,
  atomic pre-login budgets and bounded, redacted Google exchange behavior.
  It was absent from API 104 and is now configured/deployed in API 105 after
  specific human approval. One synthetic invalid-code probe returned safe
  `GOOGLE_TOKEN_INVALID_GRANT`, proving the backend reached Google's fixed-client
  exchange. Installed 86ee4723 includes the later cancellation/streaming-bounds
  fixes: staged credentials are accepted only after backend confirmation, Cancel
  promptly fences Firebase/bootstrap/reauthentication, and streamed responses are
  bounded to 32 KiB for the exchange and 2 MiB globally. Both native suites,
  production Swift 6 typecheck and formatting/localization checks pass.
  Human consent then completed. The authoritative token-free `account-state.json`
  now contains an owner UID and session generation; native source publishes these
  only after Firebase sign-in and backend bootstrap acceptance. This proves actual
  account sign-in without exposing tokens or owner identifiers in this report.
  Signed-in UI verification hit computer-use pipe failures in three attempts;
  visual acceptance and refresh/account-management remain open. The later live
  owner-pair checkpoint below establishes one synthetic local-file save.
  The local browser callback now shows a responsive English/Arabic return page
  with an **Open MusicMute** button that brings the app's Account screen forward.
  It acknowledges the browser step while account verification finishes in the
  app, clears callback parameters from the address bar, and shows a separate
  cancellation message when Google sign-in is declined. The page loads no
  external assets and receives no account credentials.
- Library combines local results and the signed-in owner's raw WebSocket job
  snapshots. Socket readiness alone is not Library readiness: connected copy
  waits for a structurally valid jobs snapshot matching the current account and
  stream. Disconnect/reconnect/account changes and stale callbacks reset or fence
  that state, while same-stream pagination preserves it. Library supports
  search/filter/sort, stars, local hiding/restoration,
  account rename/delete, offline downloads and voice export/sharing. The native
  player source includes queue, rate/seek, original/voice comparison, repeat,
  shuffle, sleep timer, loops, bookmarks and silence skipping. These are source
  implementations, not completed Android parity or listening acceptance.
- The shared offline vocals cache defaults to **2 GB (2,000,000,000 bytes)**.
  Settings → Storage lets you save a custom limit in whole decimal GB (1 or more)
  or restore the default. The limit persists on this Mac and is shared with the
  Chrome extension; existing helpers read it at each cache admission. Saving a
  smaller limit does not immediately delete downloads. The next admission uses
  least-recently-used eviction and active
  playback/pending-save pins. Owner/job/recipe/hash/timeline validation fences
  account downloads. Compatible full-timeline account YouTube results can be
  reused by the native processing path before new inference; trimmed account
  results are available for standalone playback, never synchronized YouTube use.
  After an owner Library miss, signed-in native and Chrome preparation also
  request a cache-only delivery from the global URL catalog using the canonical
  YouTube video ID and the full-timeline recipe. A completed result from another
  account creates an owned ready Library job without acquiring audio or running
  separation. A cache miss leaves normal local preparation available without
  submitting a cloud processing request. Account, source, recipe and measured
  timeline checks still apply before using the delivered vocals. This source
  change requires the matching backend cache-delivery route; local fixtures do
  not establish installed or deployed reuse.
- A durable owner-bound outbox retains at most **256 MiB of pending originals**,
  separately from vocals/runtime/model/active scratch. Originals are removed
  only after a durable committed server receipt. Interrupted saves retain their
  pair for recovery; account switching, revocation and quotas fence upload work
  without removing a successful local result or the user's selected source file.
- Backend source adds private local-pair admission, immutable upload grants,
  grant renewal, explicit recovery and validated completion. Actual original and
  vocals bytes, hashes, media types, durations and full decode must pass before
  one normal ready owner Library job is published. WAV/FLAC originals retain
  their real format. No separation job, cloud compute reservation or queue slot
  is created for local inference. Both artifacts count toward transfer/storage
  limits and remain in private R2; untrusted local YouTube declarations are not
  promoted to the global shared-media catalog.
- Cloud imports/jobs and Library updates use raw WebSocket full snapshots with
  account/generation/reconnect fences. HTTP handles commands, grants, transfers
  and explicit recovery. There is no status polling or automatic cloud fallback.
  Chrome follows the app's saved processing choice; local requests stage signed-in
  owner saves, while manually started cloud requests submit canonical YouTube URLs
  and return synchronized vocals. Legacy guest/public warm
  vocals without a retained original declaration can play after sign-in, but
  cannot be silently paired with a fresh download for account saving.

The warm-save path uses `LocalMacProvider.acquireYouTube()`: it reuses the
qualified acquisition/identity flow, probes and fully decodes the actual original,
and returns bounded bytes/checksum/type/duration/source evidence without loading
the model or running separation. New vocals manifests retain a validated,
path-free `original_declaration` for later exact-byte pairing. Cold preparation
reuses that acquisition method. Legacy manifests remain playable without being
upgraded to an original-byte claim. Owner-bound durable capture tickets now run
background recovery after warm guest/public YouTube playback, and compare the
original bytes/hash/type/timeline and conservative source profile before staging
an account pair. Playback stays immediate, inference is not repeated, and transient
failures are deferred without automatic retry. Legacy entries without original
identity show saving unavailable. The foundation's **112 focused tests in two
files** include actual synthetic FFprobe/FFmpeg validation; the final capture/pair/
service regression run passed **32 tests in four files**.

An earlier complete `npm run verify` passed typecheck,
**100-file zero-warning lint**, **690 tests in 35 files**, build and
`format:check` in one invocation. The preceding 669-test combined invocation
passed its typecheck/lint/test/build stages; formatting initially failed while
capture files were being written, then `npm run format:check` passed after those
writes. Its four-file/32-test capture/pair/service run also passed. The later
same-owner local-file warm save/recovery correction passed 96 focused tests;
guest-to-owner file cache keys intentionally remain separate for privacy. Earlier
account and acquisition checkpoints passed 622 and 651 tests respectively, each
in 33 files. Backend
`pnpm run verify` passed **1,247 unit tests in 148 files** and **160 HTTP fixture
tests in 28 files**, alongside lint/typecheck/build, secret scanning and transfer
benchmark checks. The isolated local-pair integration test also passed against a
local MongoDB replica set and synthetic FFmpeg media; it used no live R2.

The later Desktop Google exchange backend source passed a fresh
`pnpm run verify`: **1,329 unit tests in 149 files**, **181 HTTP fixtures in
29 files**, formatting/lint/typecheck/secret scanning/benchmarks/build.
The new route's 21 HTTP fixtures are included, with strict trailing-line-terminator
validation regressions. Its compiled shared admission
integration passed **12 tests** with isolated real Redis and absent Google
configuration; no real token exchange occurred in those tests. The earlier API
104 checkpoint below predates the exchange; API 105 activation follows it.

On 2026-10-02, the user authorized production backend deployment. An allowlisted
archive from the uncommitted checkout was deployed to CapRover `musicmute` / `api`
as `img-captain-api:104`; readback showed version 104, one instance and no build
in progress. `/health/live`, `/health/ready` and `/app-policy` returned HTTP 200;
unauthenticated local-sync recovery/creation and realtime-ticket requests returned
HTTP 401. This proves deployment and route protection, not authenticated local
pair saving, R2 transfers or mobile Library appearance. The archive digest and
validation boundaries are recorded in the ledger; no commit or push was made.

After specific human approval, the fixed Desktop client pair was stored only in
private backend configuration. Other environment values were preserved, but the
CapRover CLI 2.3.1 update unexpectedly cleared `websocketSupport` and
`serviceUpdateOverride`; that regression was subsequently detected and repaired.
The tested allowlisted archive SHA-256
`4e1af692844b0e71558f2c82317fc8f65d61a9b7847e35c13ed9bb40fda65d02`
was deployed as `img-captain-api:105`; protected readback confirmed the actual
deployed image, `deployedVersion: 105`, one instance and `isAppBuilding: false`.
Health/live/ready and app policy returned HTTP 200. Empty exchange
POST returned 400 `INVALID_INPUT`; a single synthetic invalid code with valid
PKCE returned 400 `GOOGLE_TOKEN_INVALID_GRANT`, both with `no-store`. This proves
configured server-to-Google exchange reachability, not a successful real token,
Firebase/backend session or R2 transfer. No secret value entered the app or docs.

The deployment initially passed HTTP checks while correct WebSocket handshakes
returned Nest JSON 404 on both realtime and worker-hint sockets. The operator restored
the two cleared settings from the owned before-snapshot using a direct API update
with all 13 fields and deep-compared every other application field for preservation.
After repair, the correct unauthenticated `/realtime/socket` upgrade returned
401, reaching the upgrade rejection path again. API 105 remained the actual image,
with one instance, no build in progress, health HTTP 200 and the safe synthetic
exchange rejection unchanged. This is repaired routing/configuration proof;
authenticated snapshot and owner-media acceptance remain separate.

Installed 86ee4723 then processed an owned synthetic three-second WAV through
the real `LOCAL_START` desktop bridge using the current accepted owner session
and installation. The native watcher acquired authorization internally; no
Keychain or bearer token was extracted. Automatic `SYNC` obtained a ready,
committed server receipt, and the matching outbox became committed with no error.
Its staged original was absent after receipt cleanup, vocals remained at
**61,170 bytes**, and the selected WAV stayed intact at **264,678 bytes**.
Repeating the same file for the same owner returned **183 ms**, `cache_hit: true`,
`sync_state: ready` and the same server job. Progress contained only file
preparation/cache checking, with no model-load, processing, separation or encoding
stages: the warm run reused vocals and the committed pair without new inference.
The [local](output/oauth-review/owner-local-smoke.json),
[committed save](output/oauth-review/owner-sync-smoke.json) and
[warm reuse](output/oauth-review/owner-warm-smoke.json) proofs contain safe fixture
evidence. This is synthetic local processing plus a live owner/private-R2 pair
acceptance, not mobile Library UI, authenticated WebSocket snapshots, Chrome
Reload/end-to-end acceptance or listening quality.

Final operator readback still confirms API 105, one instance, no build in
progress, WebSocket support enabled and the configured Desktop pair matching
the installed public client ID. The app has exactly four public config keys and
no secret; only one visible MusicMute app remains. Owned temporary credential/
configuration snapshots and their private staging directory were removed once
rollback staging was no longer needed. Current retained vocals MP3 occupancy is
**44,319,869 bytes across 12 files**, within the global 1 GB budget. That is a
bounded occupancy observation; eviction under pressure is covered by fixtures,
not a live stress test.

Native validation passed both `NativeTests` and `DesktopTests` via
`node scripts/test-native.mjs` with Swift 6 warnings as errors, complete ARM64
SwiftUI/AppKit source typechecking, strict formatting and plist/localization
checks, including dual capture/outbox watchers. A real MPS/native IPC test using
the installed runtime/current `dist` and a synthetic three-second file took
**9,460 ms cold**, **155 ms warm** and **79 ms for the local Library read**, with
zero stderr, no repeated inference on the warm run, the selected original
preserved and empty job scratch. Its
[proof](output/desktop-smoke/8eae9504-066c-424b-8935-00ed135f9e9e/proof.json)
is local-only and does not measure listening, sustained resources or account
transfers. The earlier 9,613/119/64 ms checkpoint remains in the ledger. See it for
commands and remaining acceptance work.

The earlier actual native UI prepared the synthetic three-second file and showed
it in Library as saved offline, then failed initial/Library playback because an
already-existing owned pin directory was treated as a creation failure. The safe
pin reuse/race checks and redacted diagnostics passed native regression suites.
Installed build c482315f now passes the real UI replay: the AVPlayer bar appeared
and its clock advanced from zero through three seconds; Repeat Track looped,
pause and an accessibility seek increment worked, and Stop/replay reused pins
without repeating inference. The [visual proof](output/oauth-review/native-playback-fixed.png)
establishes native playback behavior with synthetic media, not listening quality.
The same installed UI shows separate desktop diagnostic evidence (three-second
local-MPS preparation about 9.5 s, child RSS 388 MB, MPS driver 548 MB) and bounded
local history. A clean menu Quit removed the app process; reopening restored Mac
readiness, the persisted Library entry and successful playback. The selected
fixture original remains. These are one synthetic run and restart observations,
not sustained performance or account/R2 proof.
The later cancellation/response-buffering fix passed native suites and is now
installed in 86ee4723. The c482315f playback/diagnostic observations remain dated
evidence for that prior build; new-build account and playback acceptance are
recorded separately as they occur.

## Existing YouTube extension behavior and earlier installation evidence

This isolated component prepares a complete untrimmed vocals track locally, then
plays it alongside the muted original YouTube video. The first implementation
supports **macOS ARM64 / Apple Silicon only**, one job and one audible tab, public
non-live `/watch` videos up to **20 minutes** with one exposed audio language/
preference profile. Multiple language or described tracks are refused. The limit is provisional until
memory and sustained playback are qualified.

The playback panel has a sound toggle: **Show original sound** switches from
vocals to YouTube's original audio, and **Remove background music** switches back
using retained vocals when available. The original audio stays muted until the
vocals player acknowledges Stop, and another start is blocked during that handoff.
The same button shows **Cancel** while preparing. YouTube still controls playback
and volume; the original mute preference is preserved. Closing the panel only
hides its controls.
The separate red **Stop** button stops MusicMute, restores original sound and
hides the panel. During preparation it cancels the job; after selecting original
sound it simply hides the panel. Stop also dismisses an in-progress sound switch
without duplicating the stop request. Use the waveform icon to start again.

The playback panel also shows a waveform labelled **Voice-only** or **Original sound**.
It animates only while the vocals player acknowledges audible playback, and freezes
when YouTube is paused, seeking, buffering, playing an ad, muted, or using original
sound. Its played portion and elapsed/total time follow the full video's clock,
including seeks and speed changes; ads retain the main video's last position.
Reduced-motion preferences keep the bars still while the timeline continues.

The gear beside Close opens saved extension settings: **Dialog transparency**
(0–80%), **Auto-start videos** (on by default), and **Only videos shorter
than** (1–20 minutes, default 20). Preferences stay in `chrome.storage.local`
across Chrome restarts and synchronize between tabs. A strict 10-minute limit
skips a video lasting exactly 10 minutes. Editing automatic playback applies
from the next video; restored preferences also cover an eligible playing video
when Chrome opens or the page refreshes. Eligible playing videos, including
background tabs, pause while vocals are prepared and
resume their prior playback intent when ready. Stop or original-sound selection
suppresses another automatic attempt on the same visit.

Eligibility reads the loaded video's duration and matching YouTube watch-page
identity, with captured metadata/navigation/ad boundaries to reject stale media.
It makes **no extra yt-dlp or HTTP duration request**. Automatic admission also
rechecks saved preferences and that the originating tab still exists, preserves another
tab's session, and forwards the unchanged three-field native START payload.
See [settings behavior and validation](docs/extension-settings.md).

The 2026-10-02 settings update is an extension-only local package based on native
checkpoint `c482315f`, with no native/account/downloader source rebuilt. The
package records unchanged native executable code and 11,312 unchanged resource
files; only `background.js`, `content.js` and `content.css`, the audit record and
app signature seal change. Chrome still needs **Reload** for MusicMute, followed
by refreshing YouTube. The ordinary HTTP fixture proved saved-setting reload,
strict-limit skip, short-video pause/resume and Stop; real YouTube/Chrome extension
acceptance remains separate. `npm run verify` passed 777 tests in 38 files,
typecheck, zero-warning lint, build and formatting for this settings checkpoint.

The 2026-10-03 background-tab fix removes document-visibility and active-tab
requirements from automatic admission. Playing eligible next videos can prepare
and resume while YouTube is unfocused; paused videos still wait for playback.
The duration, ad/freshness, tab-existence and single-session checks remain.
`npm run verify` passed 892 tests in 40 files, typecheck, zero-warning lint, build
and formatting. The extension-only update is installed from build `0a6df9fc`,
preserving native checkpoint `86ee4723` and the downloader. Reload MusicMute in
Chrome and refresh YouTube to activate it; see the settings guide for dated proof.

The earlier installed downloader privacy package was `33f410d6` at
`/Applications/MusicMute Local.app`. It retained the earlier native app/runtime and
playback controls while updating only the guest downloader guard/pin, acquisition
flags and background Start boundary. Chrome/account cookie imports and credential
overrides are rejected; every downloader launch uses a fresh private HOME with zero
network/extractor retries and bounded request spacing. See
[downloader account isolation](docs/downloader-privacy.md).
That update passed 110 focused tests in five files, 22 offline Python tests
(46 adversarial CLI cases), typecheck, zero-warning lint, build and formatting.
At that privacy checkpoint, the broader run passed 632 of 633 tests; a separately edited native-file
symlink test expected a `cache/jobs` fixture directory that was absent. The installed
package passed strict signatures, bootstrap/wheel integrity and offline
version/help/EJS checks. No real browser cookies, account sessions or YouTube
downloads were used for these checks. Reload the existing Chrome extension and
refresh YouTube to reconnect the installed helper. That earlier package did not
include the account-connected milestone now installed as `2673319c`; its scoped
632/633 result is superseded by the final source checks above.

An earlier controls checkpoint passed **572 tests in 29 files**, typecheck and
build. At that checkpoint changed-file lint/formatting passed, while full lint
reported an unused import in the concurrently edited desktop service and full
formatting reported two native scripts. Those findings are superseded by the
passing full source verification above. The earlier extension-only `74b8e8c9`
package was installed at `/Applications/MusicMute Local.app` with strict
signature checks; it does not contain the account-connected source milestone.
At that earlier controls checkpoint, an ordinary HTTP fixture with compiled
script and CSS confirmed active
animation, an unchanged paused frame, resumed animation, and static original-sound
bars with advancing seek progress. It uses fake Chrome/video state and no media.
The live YouTube observations below describe the earlier `67960e3f` panel;
the audio handoff, red Stop and playback waveform have source regression coverage, with new live acceptance
still pending.

The earlier native SwiftUI app was built and installed locally at
`/Applications/MusicMute Local.app`. First setup downloads and verifies its own
voice model, checks the packaged runtime and registers the Chrome native helper.
The earlier panel source passed 448 tests in 21 files, typecheck, 67-file zero-warning lint,
build and formatting. The prior `67960e3f` package contains compact, movable controls
and safe handling of reloaded extension contexts. Its canonical installation
passed 21 alignment checks and strict signatures; reopened Overview showed
Mac ready. After manual Reload and ordinary YouTube refresh, its compact
panel was hidden during continuing playback, reopened, moved with keyboard arrows
and reset with Home; Escape returned focus to the waveform. These are narrow
live UI checks. Actual context revocation while active then safely paused the
video, restored original mute and showed Refresh YouTube with a disabled icon.
Refreshing and retrying resumed cached Voice-only playback; final Pause/Stop
restored original audio. Pointer dragging and the complete offscreen/restart/
sleep matrix remain separate. Earlier installed build `cb26daf3` passed 21 alignment/signature checks
and showed Mac ready. The user manually reloaded that extension, then actual
YouTube cached playback, pause, seek, 1.5× resume and Stop were observed. This is
partial prior-build control evidence, not acceptance of the new panel or a
measured offscreen-closure/restart test. Prior `cb7dec7c` supplied the native
19.021-second run and 15 UI/export checks. Earlier cold sources prepared in
23.270s and 22.229s; pre-fix long-pause/retry failures remain recorded under their
original build scope. Physical listening, selected-track matching and lip-sync
remain open. Some earlier ignored artifacts are unavailable.
See the current
[delivery ledger](docs/DELIVERY.md) and [validation evidence](docs/validation.md).

The extension, playback clock and provider contracts are shared. Windows offline
remains a later platform adapter. Current native source adds the explicit account
cloud provider described above; the earlier installed app lacked it. The preceding
extension plan is preserved in [the task plan](docs/tasks.md). No automatic
paid/cloud fallback is performed.
Local processing needs internet to acquire YouTube audio; separation
and diagnostic storage stay on the Mac.

## Local build and installation

The generated macOS package is thin. It carries the signed native app, extension
and an exact runtime bootstrap manifest; **Prepare my Mac** installs the separately
delivered, verified Node, Python, FFmpeg, downloader and MPS runtime. Users still
do not need a fleet worker, Homebrew or separately installed Node/Python. Source
packaging on this development machine requires:

Packaging does not replace an app that is already installed. An existing
pre-thin app remains unchanged until a separately authorized `install:macos`
run installs a generated thin candidate.

- Node 24 and npm for this component's build.
- Xcode command-line tools for the SwiftUI app and local code signing.
- The qualified MusicMute macOS runtime as a **read-only build source**. Packaging
  copies only allowlisted runtime/engine files into the external runtime artifact,
  with no fleet credentials, configuration, enrollment, services or model weights.
- The pinned official Python wheels installed with
  `npm run setup:downloader-wheels`, including verified EJS support. The external
  runtime's interpreter reads the wheel archives directly; end users do not install pip.
- Installed desktop Google Chrome. Browser fixtures use a separate temporary
  profile rather than the everyday browsing profile.

The following large-package records are historical **pre-thin** evidence; they
do not describe the current external-runtime package contract. The last recorded
pre-thin generated build was
`output/macos/build-86ee4723-8133-476a-9cf6-769588384605.noindex/`:
**1,116,892,697 bytes**, 303 ARM64 native files, ad hoc signed and not notarized.
At that validation checkpoint it was installed at the canonical
`/Applications/MusicMute Local.app`; installed
native binary and all three packaged controls match their SHA-256 hashes,
deep strict code signing passes and only one visible app remains. Previous
bundles stay in the owned hidden `.musicmute-backups.noindex` folder. This does
not prove fresh-Mac Gatekeeper acceptance, a reloaded Chrome build, real account
transfers or completed Google sign-in. It includes the ten-minute timeout,
backend token-exchange adapter, prompt cancellation fences and streamed response
bounds. Its exact four public config keys contain the matching registered Desktop
client ID and no secret. The prior c482315f build contained **1,116,763,048 bytes**
and 303 ARM64 files, with the synthetic native playback/restart proof above.
Prior account build `2673319c-8489-4082-8d80-3117c50e396a` contained
1,116,575,503 bytes and 303 ARM64 native files with verified host/control alignment.

Prior generated build `67960e3f` contains 1,113,057,345 bytes and 303 ARM64 native files.
It is ad hoc signed and not notarized, with no model weights or worker state.
Its 21 canonical installation/alignment checks and strict signature pass;
inventory prefix is `1a3f1f61a192`. Prior installed `cb26daf3`
contained 1,113,043,305 bytes; its 21 alignment checks and strict signature passed.
Runtime/downloader files are reused read-only from the verified previous package.
The earlier `cb7dec7c` native acquisition/MPS/Range passed in
19.021 seconds, followed by 15 cache checks across two fresh hosts
and 47 native fault/recovery checks. These native results have browser playback
false; cache/fault fixtures bypass acquisition and inference. Prior cb7 UI/private
export also passed 15 checks, including visible recorder identity and preserved
legacy unknown identity. See [validation.md](docs/validation.md) for exact scopes. Local
signature verification and execution do not establish notarization, Gatekeeper acceptance on a fresh Mac or public
distribution.

```sh
cd chrome-extension
npm ci --ignore-scripts
npm run verify
npm run setup:downloader-wheels
MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL="https://downloads.your-domain.example/musicmute/macos-runtime/" \
  npm run package:macos
npm run install:macos -- --applications-dir /Applications
open "/Applications/MusicMute Local.app"
```

For an app-only update whose processing runtime has not changed, opt in to the
exact artifact from a prior package instead of producing newly timestamped
runtime signatures:

```sh
MUSICMUTE_RUNTIME_REUSE_PACKAGE_RESULT="/absolute/output/macos/build-PRIOR-UUID.noindex/package-result.json" \
  npm run package:macos
```

The prior result must come from the same packaging contract and remain beside
its canonical thin app, runtime ZIP and bootstrap manifest. Packaging requires
owned, non-linked, non-group/world-writable files inside that build root; it
rechecks the embedded and sidecar manifest bytes, archive/manifest hashes,
extracted inventory, content-derived runtime ID and every Mach-O signature. The
runtime API, worker source version, signing mode and Developer ID Team ID must
match the new build. The exact ZIP and manifest are copied into the new build
root, so the result is self-contained even if the prior build is later archived.
The new `package-result.json` records `runtime.reused`, `runtime.source_version`
and exact `runtime.reuse_source` provenance.

Reuse keeps the prior manifest's immutable download URL and redirect allowlist.
Both runtime download settings may be omitted for this opt-in path. When either
`MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL` or `MUSICMUTE_RUNTIME_REDIRECT_HOSTS` is
provided, that value must exactly match the sealed value. Do not select reuse
after changing runtime, engine, downloader or YouTube tool inputs; publish a
fresh runtime and advance its worker source version.

`package:macos` writes the app and inventory under ignored `output/macos/` in a
`build-<id>.noindex` folder, keeping the generated app out of app search. The
package result points to both the thin app and its content-addressed runtime ZIP
and bootstrap manifest. `MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL` is required and
must be the immutable HTTPS directory where the exact generated ZIP will be
hosted (replace the reserved example host above); optional comma-separated redirect hosts use
`MUSICMUTE_RUNTIME_REDIRECT_HOSTS`. The explicit prior-package reuse path above
is the only exception because it preserves the already sealed URL. Packaging
does not upload either artifact.
Do not distribute the app until the recorded ZIP is present at the sealed URL.

The runtime is intentionally outside the app. With the current dependency mix,
the thin app is expected to be tens of megabytes, while first preparation still
downloads roughly 500–600 MB and installs roughly 1.3 GB of processing tools.
The generated `package-result.json` is authoritative for exact
`runtime.archive_bytes`, `runtime.installed_bytes` and app bytes. Keep at least
2.5 GB free for the archive, extracted runtime, setup headroom and the separate
voice model. Moving the runtime reduces app/DMG update size; it does not reduce
the total first-setup download by itself.

The same result records `steady_state_bytes` for one signed thin app, one
installed runtime release and the fixed approved 66,759,214-byte model. Its
`total` is the exact sum of those three fields for that package. This is the base
processing footprint, not a quota or hard cap; it excludes the downloadable ZIP,
temporary setup headroom, retained runtime releases, cache, logs, diagnostics,
pending uploads and user results.

`install:macos` validates and installs the latest local bundle into the user's
Applications directory, preserving an existing owned app in its private hidden
`.musicmute-backups.noindex` child. Previous apps and rollback-failed candidates
remain preserved there rather than appearing as additional apps. The backup
folder is created exclusively with mode 0700; existing foreign, linked, group/world-writable
or different-filesystem folders are refused. It uses an APFS clone and exclusive
promotion, and a concurrently occupied destination is not overwritten.
It does not register Chrome on its own. In the app, choose **Prepare my Mac**.
The app downloads its pinned runtime, verifies the complete inventory and code
signatures, activates it atomically under
`~/Library/Application Support/MusicMuteLocal/runtime/`, then downloads and
verifies the model and creates the per-user native registration. Setup has
progress, cancellation and retry; foreign registrations are refused. It uses
ordinary per-user files and network access and does not request administrator,
Full Disk Access, Accessibility or screen-recording permission.

Runtime releases, models, cache, logs and account state live outside the `.app`.
Replacing the app therefore preserves them. An app update that references the
same runtime ID revalidates and reuses the installed runtime without downloading
it again; a genuinely changed runtime gets a new content-addressed ID and is
installed during Prepare. Model files remain independent and are not downloaded
again when their verified version is already present. The first upgrade from a
legacy app that kept its runtime inside the bundle still needs one Prepare run to
create the external runtime installation; later same-runtime updates reuse it.
The supported updater replaces the visible app instead of keeping side-by-side
copies. If different copies are opened manually, each copy accepts only its own
pinned runtime, and the last copy successfully prepared owns the per-user Chrome
launcher. Switching back may therefore require Prepare again; activation is
atomic and never mixes files from two runtime versions.

Replacing or deleting only the `.app` is not a clean-first-run test and is not a
full uninstall: the external runtime, model, account state, cache, logs, launcher
and Chrome registration may remain. A full MusicMute Local data reset is a
separate destructive operation that needs explicit authorization. It must remain
scoped to the MusicMute Local app and its exact per-user paths; it must not remove
MusicMuteWorker, browser profiles, source/package artifacts or unrelated apps.

The Setup page identifies the per-user base folder as
`~/Library/Application Support/MusicMuteLocal/`: processing tools live below
`runtime/releases`, the model below `models`, and the Chrome launcher, cache,
logs and app state remain in separate owned paths. The Chrome registration itself
is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json`.
Packaged execution never searches Homebrew or `PATH` for Python, Node, FFmpeg,
Deno or yt-dlp, so separately installed versions are untouched and ignored. A
full leaf/hash/signature verification establishes an authenticated private
receipt for the exact signed app and runtime identities. Later native app/helper
processes may use that receipt only after outer-app validation and two identical
inventory-metadata fingerprints; any missing, invalid or mismatched receipt, key,
policy or identity falls back to full verification. Modified managed files fail
closed and Prepare repairs the pinned release. The receipt fast path narrows
cooperative-update and in-scan mutation windows but cannot stop a hostile
same-UID writer after the final check. A conflicting model file is preserved for
explicit user review instead of being overwritten. A manually opened different
MusicMute build must Prepare its own pinned runtime if the active ID is
incompatible. The supported updater keeps one visible current app, so side-by-side
old/new app copies are not a supported mode.

The GUI is the normal setup path. Support can invoke the same guarded flow from
Terminal without exposing alternate installers or paths:

```sh
APP="$HOME/Applications/MusicMute Local.app"
# Use APP="/Applications/MusicMute Local.app" if that was the chosen install folder.
"$APP/Contents/MacOS/MusicMuteLocal" --prepare
```

This is an advanced recovery command, not a required installation step.

The canonical app is current candidate build `c14116b8` at
`/Applications/MusicMute Local.app`. The following paths describe preserved
historical package/install checkpoints, not the current app-data state. At those
earlier checkpoints, former home-directory apps were moved, without copying or
deleting them, to the owned `MusicMuteLocal/retired-apps.noindex` directory. The earlier generated
package remains `output/macos/build-cb7dec7c-5edf-48cd-91ad-4cf275b599e5.noindex/`.
The earlier panel package is
`output/macos/build-67960e3f-97ec-44bf-a29b-662357b28677.noindex/`.
An earlier extension-only package, with the sound toggle and red Stop button, is
`output/macos/build-9c1d6c15-8aae-49f9-a690-f2dfcc5ef5dc.noindex/`.
It reuses the verified prior native app/runtime and replaces only the extension's
`content.js` and `content.css`, then updates the inventory and verifies the new
app signature. Separate native app source work is not included in this package.
Prior `cb26daf3` remains at
`output/macos/build-cb26daf3-9230-4fa3-8afa-35c0dfb0c28b.noindex/`;
its earlier installer preserved the previous canonical app under
`/Applications/.musicmute-backups.noindex/` with private mode 0700. Model, cache
and logs were preserved, and the installed alignment proof records only the
canonical app in Spotlight.

The default remains `~/Applications`. To install into the standard system
Applications folder explicitly, use:

```sh
npm run install:macos -- --applications-dir /Applications
```

Only this exact target is supported. The installer requires an existing root-owned
system directory without symlinks or world write permission; group write is allowed
only for macOS's admin group. It runs as the current user and requires ordinary
write access. It does not use sudo, create/chmod `/Applications`, replace foreign
apps or change Chrome registration. After relocating, open the new app and use
**Repair Chrome connection**. The unpacked extension stays at the same per-user
Application Support path when the app moves or is replaced.

Prepare copies the built Chrome extension into
`~/Library/Application Support/MusicMuteLocal/extension`. The folder includes the
manifest, compiled scripts, icons and English/Arabic translations, with the public
key preserved so Native Messaging uses the same extension ID. Prepare replaces
only an app-owned copy; runtime, model, media and account state remain separate.
After an app update, Prepare refreshes this copy even if the extension version
number is unchanged. Ordinary status checks inspect metadata without hashing the
scripts. Chrome still requires manual Reload followed by a YouTube page refresh.

Once the app reports that the Mac is ready, add this unpacked extension:

1. Open `chrome://extensions` in Google Chrome and enable **Developer mode**.
2. On MusicMute's Setup page, choose **Reveal folder**, then click **Load unpacked**
   and select `~/Library/Application Support/MusicMuteLocal/extension`.
   **Copy path** provides the exact location for your user. If Chrome currently
   loads the older folder inside the app bundle, remove that unpacked entry and
   load this folder once; subsequent app moves preserve the new path.

Refresh a standard YouTube watch page. Auto-start prepares eligible playing videos
shorter than the saved limit (20 minutes by default); the MusicMute waveform beside
the player controls also starts videos up to 20 minutes manually. It pauses the
video, prepares the complete
vocals track and resumes synchronized playback. While MusicMute is active, the
waveform shows or hides its controls. The compact 304px panel starts at the
player's top right. Its close button or Escape hides it without cancelling the
job or changing playback, generation, mute or clocks; progress and playback
updates keep it hidden until you reopen it. Drag the header, or focus it and use
arrow keys (Shift for larger steps); Home resets its position. Movement stays
within the player and is reclamped after resizing. Use **Cancel** during preparation
or **Show original sound** during playback to restore original audio. The same
button then offers **Remove background music** to return to vocals.
The red **Stop** button restores original sound and hides the dialog; start again
from the waveform icon. Prior-build YouTube verified
close/reopen, keyboard movement, Escape and Home; drag has unit coverage only.
The popup's **Open MusicMute app** link opens local setup;
**Check again** checks the helper connection and obtains a handshake when needed.
An existing ready connection reuses its handshake; this does not revalidate model
or runtime files. Use **Check readiness** in the Mac app for those checks. The Mac
app verifies runtime, model and native registration; the popup requires the native
helper handshake before reporting ready. After moving the app, repair the Chrome
connection in Setup. The app-data extension folder does not move. After updating
the extension files through Prepare, click Reload in Chrome and refresh YouTube.

The earlier user-completed Chrome checks covered initial loading, `cb26daf3`
Reload and `67960e3f` Reload. The canonical folder is unchanged; an update does not require
another extension entry. Refresh the YouTube page after Reload: already injected
content scripts are not patched by reloading the extension.
The extension source safely retires an invalidated script, restores original mute,
pauses active ownership, releases timers/listeners and shows a Refresh YouTube
instruction. The user refreshed YouTube after the new Reload and verified the
new panel's hide/reopen and keyboard behavior. Actual context revocation during
playback showed the safe refresh notice and restored original audio; refresh and
retry reconnected successfully. This does not establish the full browser restart,
offscreen closure or sleep/wake matrix.
Earlier pre-load YouTube observations had no MusicMute control. Automatic approval review
rejected browser navigation to `chrome://extensions`
because the browser surface permits HTTP/HTTPS pages only. Loading through another
browser, CDP, shell or indirect UI is not an allowed workaround. The earlier
ordinary HTTPS observation found zero MusicMute controls and one existing HaramMute
control before loading. This observation does not describe Chrome after the manual
load. Subsequent actual Chrome observations show the MusicMute control,
preparation and voice-only state, followed by a recovery failure. They are recorded
as pre-fix evidence; listening and selected-track matching remain unverified.

The native host is registered per user as `com.musicmute.local`; the public
manifest key fixes the unpacked extension ID. No private signing key is included.
Its per-user lock prevents multiple helpers from admitting parallel work.

## Local data and diagnostics

Packaged app data is separate from the fleet worker:
`~/Library/Application Support/MusicMuteLocal/`. Its `models/` contains the
upstream-verified model downloaded during setup. Its `cache/` holds owned attempts
and retained vocals; `logs/` holds bounded structured diagnostics, app-shell
journal records, setup evidence and private exports. Current source replaces
the earlier 512 MiB/seven-day vocals policy with the shared 1 GB LRU budget.
Account catalogs and pending saves are owner-bound; account-job cache files do
not become visible to another owner. Pending originals have the separate
256 MiB bound and remain until committed account-save recovery completes.
The popup's cache control stops playback and clears only eligible owned vocals
entries; pending-save pins, diagnostics and unrelated files are preserved.

The app's Diagnostics page displays local event/timing/resource summaries and
exports a private report. App-shell events and setup diagnostics are included
through safe projections; existing native host reports remain compatible.
Reports identify the current recorder/package inventory/expected model, while
historical records keep their own identity and legacy records remain unknown.
Verified-model fields require trusted native pipeline provenance; a cache hit does
not claim new inference. The package fingerprint is not full installed-byte or
Chrome-loaded-build verification. Diagnostics remain local, with no Sentry initialization or automatic reporting.
Reports exclude audio, cookies, credentials, source URLs, private filenames,
environment values and arbitrary exception messages. See
[diagnostic behaviour](docs/diagnostics.md).

The earlier source development adapter remains available through
`npm run doctor`, `npm run install:dev` and `npm run diagnostics`. It uses the
separate `MusicMuteLocalMvp` data directory and can read the qualified worker
model/runtime for development. The packaged app uses its own runtime/model paths.
App setup recognizes an owned development registration and refuses unrelated
registrations.

The existing browser harness uses a fixture-only manifest, a synthetic watch page
and local audio. It loads an unpacked extension and is **not authorized to run in
this session**, because automatic extension loading was rejected. Its historical
19-check report is currently unavailable and has not been rerun. It never proved
YouTube acquisition, Arabic/English listening quality, fresh-user installation or
long-duration resource safety. An ordinary HTTP fixture using compiled
content.js/CSS and a fake Chrome runtime now exercises panel
hide/progress/READY/playback/reopen, keyboard movement, resize and icon centering
without loading an extension or playing replacement audio. While hidden, its
clock count advanced from 9 to 2,394 with one Start and zero Stop/Cancel; explicit
Stop then restored mute. Its pointer UI
attempts missed the handle, so drag behavior has unit coverage only. These checks
remain separate from installed Chrome acceptance. Repackage after source changes so the installed
app and bundled extension include those changes.

## Architecture and boundaries

```text
SwiftUI app -> bundled Node setup/status/diagnostics -> app-owned model + registration
YouTube content script -> background/provider controller -> native companion
                                                               |
                                             yt-dlp -> Kim/MPS -> MP3
                                                               |
Extension-owned audio player <- protected loopback Range delivery
```

The original video clock controls the extension player. Native messages carry
commands and progress; audio bytes stream from disk. Local capabilities stay in
extension-owned contexts and never enter YouTube DOM. Native host stdout contains
only little-endian framed JSON. Python output uses separate JSONL; library stdout
is redirected away from its control channel.

Playback synchronization uses a 40 ms deadband and pitch-preserving speed
correction bounded to 3% of the selected YouTube speed. Initial alignment and
user seeks can reposition vocals; normal playback only jumps for at least
750 ms of drift sustained for one second, with seek settling and cooldown.
Network `stalled` events leave vocals playing when video data remains playable;
real buffering suspends vocals and recovers on readiness or forward progress.
Clock samples expire after five seconds, including pending play requests, and
old samples cannot renew that deadline. Pause, ads, Stop and navigation keep
their immediate suspension behavior.

These synchronization changes have local source regression coverage. They do
not establish actual YouTube listening quality or physical lip-sync; browser
and E2E playback checks were intentionally omitted for this change.

Ads, seeking, buffering and navigation suspend/stop replacement audio. During ads,
the original audio follows the user's mute preference; returning to the main video
reclaims MusicMute's mute before vocals resume. This ad transition has source unit
coverage; actual Chrome/YouTube ad acceptance remains pending. Decoder or helper
failure must not leave vocals playing against a different video. Stopping MusicMute
restores only the mute state owned by that session.

Current source also fences late ready messages after Stop or video replacement,
cancels pending audio loads before a successor takes over, restores original mute
after ownership loss and preserves mute changes during preparation. These paths
have actual-handler regression coverage; the Chrome fixtures have not been rerun.

Acquisition now uses best audio within the supported HTTPS/materialized DASH
transfers and qualifies the exposed language/preference profile. It downloads the
one accepted format from bounded, ephemeral metadata supplied through stdin,
then checks the returned identity before inference. It cannot silently extract
the webpage again during that download. Cache recipe 8 prevents reuse of recipe 7
and older results while preserving their files, and rejects cached results with the wrong pinned model. Native model
verification is replayed only from provenance written by the trusted pipeline;
unverified/legacy cache entries cannot acquire a verified-model claim.

The guarded downloader now preserves a full upstream audio-track ID and raw
default boolean when an unambiguous match exists in the already returned player
response. Unknown evidence remains unknown; multiple distinct known IDs are
refused. This does not prove an original track or match YouTube's selected audio.
Diagnostics export only `source_audio_track_id_known` and an optional
`source_audio_is_default`, never raw IDs. The downloader bootstrap is pinned to
SHA-256 `986f9b401a3f0d9598551ec2bdecc326859e55053333dc1059c2decb45c66aa2`.
The guest downloader now rejects account/cookie/config overrides and uses a fresh
private HOME for every launch, with zero extraction/download retries and bounded
request spacing. See [downloader account isolation](docs/downloader-privacy.md)
for the credential boundaries, offline proof and remaining IP-rate-limit scope.

Known limits: the earlier long-pause/retry test found `AUDIO_CONTEXT_LOST` and a
generic `UNCAUGHT_ERROR` during navigation. Prior `cb26daf3` later demonstrated
cached playback, pause/seek/rate and Stop after the user's Reload; this does not
close the measured >30-second offscreen/restart matrix. The new panel passed
refreshed-page live hide/reopen, keyboard, Escape/Home and centered-icon checks.
The bounded console summary has zero errors/warnings after the installation
cutoff; older retained records remain. Actual context loss and refresh/retry
reconnection passed the observed safety cycle. Successful pointer dragging and
the wider offscreen/restart/sleep playback matrix remain open.
YouTube DOM/downloader behaviour can change, and public acquisition
is not guaranteed. Real-player track matching, listening and lip-sync remain MVP
acceptance gaps. Equal duration and successful separation do not close them. A vocal
model can retain background singing. Whole-file separation allocates full-length
arrays; preflight/sampling is not a hard memory sandbox. Browser clock skew does
not measure speaker-to-screen latency. Native app relocation/registration repair
and interrupted model download/retry were recorded in earlier isolated checks;
those historical artifacts are currently unavailable.
The canonical global app's connection was repaired and the user manually loaded
its extension. Clean-user installation, further app moves/updates, sleep/wake,
long playback and public signing/store acceptance remain open.

Read [the bridge contract](docs/bridge.md), [delivery plan](docs/DELIVERY.md),
[account-connected ledger](docs/desktop-tasks.md) and
[validation evidence](docs/validation.md) before release claims. The account
milestone includes the API 105 deployment and the dated authenticated local-file
pair save in the account-connected ledger. Those checks do not establish all
account, cloud, mobile or browser journeys. Native mobile code remains separate.
This branch adds a native Worker screen and an independently running macOS worker
service; see [worker integration](docs/macos-worker-integration.md) for the complete
operator inventory, installation/adoption contract and current acceptance evidence.
The app carries compressed worker code while reusing the prepared external runtime
and model. Paired workers start at login and process backend jobs independently of
the GUI; personal imports retain their current cancel-on-Quit behavior. Windows installation,
public signing/notarization and store distribution remain separate work.

### Playback performance update (2026-10-05)

Cloud YouTube requests now submit URLs without local original acquisition or model
readiness. Local/shared cache checks precede engine startup; trusted shared originals
can skip YouTube acquisition. The packaged private local engine remains warm for
two idle minutes and retires on cancellation/update identity changes. See
[processing selection](docs/processing-selection.md) for validation boundaries and diagnostics.
Local ad-hoc DMGs remain for prepared Macs; a placeholder runtime download URL is
not a fresh-user distribution or notarization proof.

## Manual installation verification

Normal playback and separation trust the prepared installation. Open the extension
and select **Check again** for full runtime/model/tool verification, progress and
last-check results. Popup connection status alone is not a fresh integrity check.
Same-video local READY playback can reuse its native grant across a five-second
reload handoff. See [setup and updates](docs/setup-updates.md#installed-content-trust-and-explicit-checks-2026-10-06)
for the trust policy, compatibility and handoff fences.
