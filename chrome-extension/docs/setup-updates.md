# Setup, acquisition guidance, cloud handoff and updates

Implementation scope requested 2026-10-04: bundle Deno and the approved PO-token
provider, prepare tools during Mac setup, explain failures safely, preserve
app-closed extension processing, add explicit account cloud handoff and Sparkle
updates. Apple account/certificate/notarization work and Chrome Web Store
packaging/publication/deployment are deferred by the owner.

## Staged GitHub downloads — 2026-10-06

The owner authorized hosting runtime downloads in
<https://github.com/ahmed-dev-1/musicmute-downloads> and explicitly requested
Safari for release management. Runtime download assets are published under the
versioned `macos-runtime-2026-10-06` release, not a mutable `latest` download URL.
The seven ZIPs contain Python/ML dependencies, Node, FFmpeg/FFprobe and notices,
the downloader, Deno and shared YouTube notices, the token provider, and the
MusicMute engine. These assets contain no user media, credentials, account state
or model weights. Kim Vocal 2 keeps its approved upstream download; the owner
confirmed that its existing no-mirroring condition remains in force.

`runtime-bootstrap.json` accepts the existing single `zip` representation and
the new `zip-components` representation. The latter carries bounded `components`
with `id`, `url`, `archive_bytes`, `archive_sha256` and disjoint `file_paths`.
Component inventories must cover the full runtime inventory exactly once. The
total archive byte count is the sum of component ZIP sizes; the aggregate digest
is SHA-256 of the ordered lowercase component digest strings, each followed by
one newline. Every component URL and GitHub CDN redirect is allowlisted.

Prepare downloads, checks the ZIP digest/listing, extracts, verifies every file
and marked code signature, and moves the verified component into private staging.
It deletes that exact ZIP and its partial/resume files before the next stage.
Only a complete second inventory/signature verification permits atomic runtime
activation. A later-stage failure discards incomplete staging and preserves the
previous active runtime; only the interrupted current ZIP is eligible for resume.
The model downloads afterward and retains its existing exact-byte/hash checks and
temporary-file cleanup. Successful setup leaves the runtime downloads directory
empty. English and Arabic stage labels share the same progress sequence.

Generate components from an independently verified prior package result:

```sh
node scripts/macos-runtime-components.mjs /absolute/build-UUID.noindex/package-result.json /absolute/new-components.noindex https://github.com/ahmed-dev-1/musicmute-downloads/releases/download/macos-runtime-2026-10-06/
MUSICMUTE_RUNTIME_COMPONENTS_DIRECTORY=/absolute/new-components.noindex npm run package:macos
```

The current component import path is for explicitly labelled ad-hoc development
packages. It does not bypass Developer ID, notarization or the public-release
pipeline; the latter still requires its own segmented-artifact support and Apple
acceptance. Hosting and local/fixture validation do not prove Gatekeeper acceptance
on a fresh Mac. Required third-party licenses, media sources and the reproducible
FFmpeg/LAME build script accompany the development release.

The contract review used the current
[Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/) on
2026-10-06: compatible extensions (106/107), conservative validation (109),
snake_case JSON (118), and safe error reporting (177). This file-based installer
contract does not add REST routes or require HTTP method/OpenAPI changes.

Published development checkpoint (2026-10-06 UTC):
[release macos-runtime-2026-10-06](https://github.com/ahmed-dev-1/musicmute-downloads/releases/tag/macos-runtime-2026-10-06)
contains 15 uploaded assets totaling 447,344,271 bytes, including seven runtime
ZIPs (410,586,412 bytes), the development DMG (15,971,296 bytes), checksums,
manifest, notices and matching media sources. Public unauthenticated readback
matched every asset's exact size, digest and pinned URL. The actual downloaded
DMG passed checksum, mounted inventory/link and strict signature checks.
Installed build `1791319952` matched all 160 final inventory leaves and its
strict deep signature; its explicit Prepare reused existing tools/model and
showed all six Setup checks Ready.

`npm run verify` passed 2,125 tests (four skipped), type checking, lint, formatting
and the browser/companion build. Native `NativeTests` and `DesktopTests` passed,
including real staged ZIP installation, monotonic progress, cleanup and failure
atomicity. Packaged qualification passed all 16 offline/native/worker checks in
disposable state without real account, Chrome profile or Keychain access. An
initial 20-second token-provider probe timeout passed a focused rerun and the
fresh full qualification. These checks do not establish live YouTube acquisition,
cloud processing, a clean OS user, Developer ID signing or notarization.

The isolated real-network Prepare check then passed from empty app data, with no
preseeded archives or model and no access to existing user state/Keychain. It
downloaded all seven ZIPs from the published GitHub release and Kim Vocal 2 from
upstream, verified the model hash, reached Ready, confirmed each ZIP was removed
before the next stage, and left `runtime/downloads` empty. Its evidence is saved
locally in `output/github-network-proof.noindex/fresh-release-download-second.noindex/result.json`.
The first harness run completed setup but could not save its atomic report inside
the sandbox; the final rerun used a sandbox-compatible report writer. No product
security protections were relaxed.

## Readable Mac typography

The Mac app bundles the exact Noto Sans Arabic variable font and SIL OFL license
used by Android. Human-readable text uses its native regular, medium, semibold
and bold instances; technical paths and identifiers retain a readable monospace
font. One shared type scale covers Home, Library, Account, Worker, Setup,
Diagnostics, Settings and the player: 17-point body, 14–15-point secondary text,
21–34-point headings and a 13-point minimum even with Compact selected.

The saved text-size preference applies throughout these screens. Navigation rows
have more space, secondary labels use theme-aware contrast, controls have larger
targets and the player source selector uses its natural text size. Ordinary app
replacement preserves settings, prepared tools and the model. Font registration,
Android file/license parity, English/Arabic glyph coverage and preference scaling
are covered by `npm run test:native -- SettingsTests`.

The local 2026-10-06 typography checkpoint is installed build `1791313330`: all
157 installed inventory leaves and the strict deep signature match its package,
including byte-identical Android font/license resources. `npm run verify` passed
2,099 tests (four skipped); all six native suites passed, followed by a final
Settings suite rerun. English/Arabic native previews and 14 isolated Settings
renders checked both themes and accessibility sizing. Arabic content direction
is scoped inside stable native navigation/scroll geometry to avoid clipping
behind the sidebar. The Library sort selection and wrapping sidebar text were
also verified visually. Installed startup accessibility readback confirmed the
new controls; the native UI connection closed before a final installed screenshot.
This remains an ad-hoc local build, without notarization or public-release proof.

## Installed-content trust and explicit checks (2026-10-06)

After successful Prepare/update, ordinary native startup, cached playback and new
local separation trust installed executable and model contents. They do not scan
inventories, verify signatures or hash models/tools before processing. Cheap
active-runtime/path/version checks, update leases, source identity, media
validation and account/processing-choice fences remain in force. Missing files
and real execution failures still stop the request; there is no download fallback.

Opening the Chrome popup requests a lightweight HELLO/status. **Connected** means
the helper answered; it does not mean a new installation audit passed. **Check
again** explicitly runs a bounded runtime/app integrity audit, model readiness
check and YouTube tools check. The popup shows component progress, elapsed time,
safe failure codes and the last completed check for the current app identity.
Concurrent checks coalesce; active playback/processing refuses the check as busy.
Disconnect/timeout ends a running check with retryable failure. Checks never repair
or acquire media automatically. Installation failures direct the user here first,
then to the Mac app for repair; network/source refusal keeps its specific guidance.

Completed checks also refresh the Mac app's saved component readiness for that
installation. Passing components clear older setup failures; pending components,
cancelled checks and installation changes preserve the previous evidence. Normal
GUI status reads this record and installed metadata without rerunning probes.

Replacing the app invalidates the old bundle's saved tool checks even when the
same prepared runtime is reused. Installed downloader, Deno and token-provider
files then show **Not checked**, with **Check YouTube tools** as the next action.
Missing or unsafe files still show **Needs setup** with their specific component
error. Run that explicit check to bind readiness to the current app; existing
runtime/model files are verified and reused rather than downloaded again. Local
files and cached vocals remain available while these tool checks are stale.

The 2026-10-06 installed check reproduced the stale bundle receipt with all five
previous component checks passing. **Check YouTube tools** restored all six Setup
rows without reinstalling the tools. Build `1791311248` then verified the corrected
update state (**Not checked**) followed by all six rows **Ready** after its explicit
check. All 155 installed inventory leaves and strict deep signature verification
match the package. `npm run verify` passed 2,099 tests (four skipped), and native
`NativeTests`/`DesktopTests` passed. This is prepared-Mac tool-readiness evidence;
it does not establish a fresh YouTube acquisition or public fresh-Mac release.

An idle status connection stays available briefly for a following START or CHECK.
After MusicMute closes its own idle helper, a fixed one-second window permits
HELLO-only recovery while the old helper releases its lock. START and processing
commands are never replayed; unrelated or persistent contention remains busy.

The app now carries its Python engine adapters and downloader launcher in signed
Resources. Compatible updates can reuse the large installed interpreter/tool
runtime while adopting current app code. Model integrity remains verified during
Prepare and explicit checks. Fleet engine callers retain full verification by
default. This is an intentional trust policy: changed installed contents may be
used until the next explicit check or installation/update validation.

Native IPC adds `CHECK {}` and bounded `CHECK` progress/final replies, discovered
through optional HELLO fields `installation_check_supported` and `installation_id`.
Old helpers receive update guidance without unsupported CHECK commands. No REST
route or backend schema changes are involved. The portable compatibility, strict
schema and sensitive-data rules were reviewed against the current
[Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/).

Local READY grants survive at most five seconds during a same-tab reload or SPA
handoff. Offscreen audio stops immediately. A successor must match the active
Chrome document, generation, video, local provider and duration (within two
seconds), and native STATUS must confirm the existing grant and current account/
processing choice. Successful reuse sends no new START, CANCEL or HELLO. Other
videos, expired grants and interrupted preparation cancel through the existing
path; cloud results are not retained. In-flight cancellation and acknowledgement
keep the port alive until settled, and extension updates wait for safe release.
This is ephemeral memory, never persistent media-capability storage.

## Behavior and validation contract

| Requirement                                               | Authoritative acceptance evidence                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Bundled tools with no end-user package managers           | Package inventory, hashes, offline Deno/EJS/provider/native binding execution       |
| Single first-run setup with progress and cancellation     | Setup fixtures, per-component readiness, signed model verification, native suite    |
| Local files/cache survive YouTube tool/access failure     | Partial readiness and cache/file path regression checks                             |
| JS, token and bot/rate refusal are separate               | Error classifier, native message validation and rendered browser fixtures           |
| Cooldown persists and countdown does not retry            | Gate persistence/cancel/restart fixtures and browser fake-clock coverage            |
| Safe local diagnostics                                    | Strict field projection, bounded rotation/export and malicious-field tests          |
| Explicit cloud handoff and monthly allowance confirmation | Native deep-link/parser/account/source fences and current allowance UI              |
| Extension works while GUI is closed after setup           | Helper launcher/native protocol integration; no automatic GUI launch for processing |
| Verified automatic/manual update checks and idle install  | Sparkle configuration/compile, framework inventory and process lease fixtures       |
| Compatibility across helpers and upgrades                 | Capability negotiation and native/browser regression suite                          |

The cloud handoff is `musicmute-local://cloud?video_id=<canonical-video-id>`.
It optionally carries `duration_seconds`, an integer from 1 to 1,200, for an
advisory usage estimate. The Mac rejects unknown/duplicate parameters, paths,
credentials, ports and fragments. It constructs the canonical YouTube URL itself.
Opening the link only fills Home and selects cloud for that form; it starts no
work. Rights and cloud confirmation are separate. Confirmation is bound to the
chosen source and account session, and is invalidated by changes. The live account
allowance must be available before the user can submit. The server remains
authoritative for eligibility, reuse, duration and charging. No account/cloud
credentials are passed in the browser URL.

The Mac app owns imports started through this handoff and plays their results.
New Chrome requests also follow the app's saved local/cloud processing choice
and can return cloud vocals to the synchronized player; see
[processing selection](processing-selection.md). Users may review or switch their
Mac account before confirming. Opening Chrome's cloud action leaves the saved
preference unchanged; confirming cloud processing in Home saves the cloud choice.

Setup reports offline tool preparation separately from live YouTube access.
Deno solves supported JavaScript challenges; a PO-token provider addresses
supported token requirements. Neither guarantees that YouTube accepts a guest
request. A browser sign-in does not authenticate the isolated guest downloader.

After setup, Chrome starts a separate native helper while the Mac GUI is closed.
Idle commands and Stop release the helper's update lease; active and paused
playback keep it. A configured Sparkle build checks for updates while the Mac app
is running. A Chrome-installed extension may receive `onUpdateAvailable`; reload
waits for idle work. An unpacked extension requires manual Reload in Chrome.

Runtime versions and build preparation are documented in
[bundled YouTube setup](youtube-runtime.md); feed/key configuration and update
installation safety are documented in [Mac application updates](macos-updates.md).

## Cross-product Home, login and synchronization

The account/discovery card belongs on native Home so a signed-out user can begin
Google or email sign-in in the same place that explains cross-device Library
benefits. Google controls use localized accessible text together with the
recognizable multicolor Google G. A generic system person icon must not be used as
Google branding. The English and Arabic versions retain the same actions and
usable RTL order.

Signing in authenticates the Mac and publishes an owner-scoped account session.
It does not by itself prove that the Library's realtime subscription is online or
that another device has received an item. Home and Library report the connection
state separately, permit reconnection, and preserve local playback while the
account connection is unavailable. A ready socket still reports connecting until
a structurally valid jobs snapshot arrives for the current account and stream.
Disconnect, reconnect, account change and stale async completions reset or fence
that readiness; same-stream pagination does not erase an accepted first snapshot.
Likewise, opening a public product link does not transfer credentials or
authenticate the destination browser.

`MusicMuteProductLinks` is the single native allowlist for public destinations:

| Destination                     | Canonical URL                                                       | Claim boundary                                                                                             |
| ------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Web app                         | `https://app.music-mute.com`                                        | Opens the browser app; does not transfer the native account session or prove an authenticated browser flow |
| Reviewed Android listing        | `https://play.google.com/store/apps/details?id=com.hatem.musicmute` | Discovery only until a current store lookup proves the listing/download is live                            |
| Future public Downloads section | `https://music-mute.com/#downloads`                                 | Discovery/update destination only; it is not a direct DMG or evidence that a public Mac release exists     |

The allowlist requires the exact HTTPS host, path, query and fragment for each
destination and refuses credentials, ports, tracking parameters and unexpected
routes. Views call this source instead of repeating URL strings and use the
system's external-navigation API. Do not substitute a guessed direct DMG,
Firebase App Distribution, App Store, Play artifact or tracking URL. Public
availability requires a fresh network or release-registry check with dated
evidence; source constants and successful navigation are not publication proof.

## Thin app and automatic runtime preparation

Current packages no longer seal the Python/ML, Node, FFmpeg, downloader or
YouTube runtime tree inside `MusicMute Local.app`. The signed app contains a
bounded `runtime-bootstrap.json` that pins one HTTPS URL, archive byte count and
SHA-256, compatible API version, allowed redirect hosts, signing team and exact
leaf inventory. **Prepare my Mac** downloads that archive directly in the native
app, checks its digest before extraction, validates every extracted type, byte
count, hash, executable bit, symlink and code signature, then atomically selects
the verified release with a private `runtime/active.json` descriptor. Failed or
cancelled setup restores the previous active descriptor.

The runtime, model and user data remain under
`~/Library/Application Support/MusicMuteLocal/`, outside the replaceable app.
Updates with the same runtime identity reuse the verified release. A changed
runtime identity requires Prepare to download the new release, while an already
verified model remains reusable. Setup needs no administrator or privacy-sensitive
macOS permission. Allow at least 2.5 GB free during first preparation; the exact
archive and installed sizes are recorded in `package-result.json`.

The current 2026-10-05 candidate, build ID
`c14116b8-cf2c-4865-8a24-f9f1dce2a119` / `CFBundleVersion` `1791212763`, measures
17,663,025 bytes for the thin app, 410,586,280 bytes for the runtime archive,
1,297,496,698 declared bytes for the installed runtime and 66,759,214 bytes for
the model. Its exact one-app/one-runtime/one-model base footprint is
1,381,918,937 bytes. The runtime contains 18,031 leaves; allocated storage can
appear as 1,309,552 KiB under `du -sk`. The package is ARM64, ad hoc signed,
unnotarized, updater-unconfigured, `public_ready=false` and
`relocated_runtime_tested=false`. Its reserved `downloads.example.invalid` URL
is not hosted-download proof. The package record is
`output/macos/build-c14116b8-cf2c-4865-8a24-f9f1dce2a119.noindex/package-result.json`;
external inventory SHA-256 is
`3e5d49e98f7147ac049224d36a1227b3ad46cb48f08711ff2f79f8762e00a276`,
and the embedded `bundle-audit.json` file SHA-256 is
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`.

The runtime identity is `macos-arm64-v1-c923b1be1f135d8c48ef81c9`; its archive
SHA-256 is
`9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`.
The model SHA-256 is
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.

The Setup page shows the shared per-user location before preparation. The complete
layout is:

| Item                         | Per-user location                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Processing runtime           | `~/Library/Application Support/MusicMuteLocal/runtime/releases/<verified-runtime-id>/`         |
| Runtime verification receipt | `~/Library/Application Support/MusicMuteLocal/runtime/verification-receipt-v1.json`            |
| Voice model                  | `~/Library/Application Support/MusicMuteLocal/models/<verified-model-sha256>/Kim_Vocal_2.onnx` |
| Cache, logs and app state    | Separate folders under `~/Library/Application Support/MusicMuteLocal/`                         |
| Chrome launcher              | `~/Library/Application Support/MusicMuteLocal/native-launcher.sh`                              |
| Chrome registration          | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json`    |

The `.app` remains in the Applications folder selected during installation. A
packaged launch never discovers Python, Node, FFmpeg, Deno or yt-dlp through
`PATH`, Homebrew or another system installation. Versions installed elsewhere
are left unchanged and ignored. The signed app manifest selects one exact
content-addressed runtime. A complete leaf/hash/signature verification creates a
private mode-0400 receipt authenticated by a non-synchronizing, device-only
Keychain key. The receipt binds the signed app build/CDHash, verification policy,
bootstrap and active identities, runtime/release/payload identities, and the
exact inventory metadata. A later app or native-host process may use it only
after validating the outer app and obtaining two identical metadata fingerprints
under the shared setup/update leases. Missing, corrupt, unauthenticated or
mismatched receipts, unavailable Keychain access, or any policy/identity/metadata
change fall back to full verification and a best-effort replacement receipt. A
modified managed release is never substituted or run; Prepare repairs it from
the pinned archive. This fast path narrows cooperative-update and in-scan TOCTOU
windows, but cannot stop a hostile same-UID writer after the final check. A
conflicting file at the exact managed model path is preserved and reported for
the user to move aside rather than being silently overwritten.

### Current c141 ordinary update and runtime-reuse checkpoint

Build `c14116b8` was installed as an ordinary compatible app update. Its package
and installed 139-leaf inventories, ARM64 build identity and deep strict
signature matched. The external runtime and model were reused, and installed
full verification created the private runtime receipt. The separate disposable
15-check proof is
`output/packaged-tools-proof/e9fb0a01-33a0-44b9-b18a-391fe2130002.noindex/result.json`.
It opened no GUI or browser and used no account, Keychain helper, runtime/model
network transfer or inference. Separately, the already-final unpacked `dist` was
loaded before the c141 app install; a post-install refreshed real YouTube tab
reached **MusicMute · On this Mac** and **Voice-only playback** through the c141
companion. Logs identify a warm cache hit and `playback_started`, so this is not
fresh acquisition, downloader/MPS separation or listening/long-run proof. The
checkpoint is not clean app-data Prepare, fresh-user or runtime-network
acceptance.

The supported updater keeps one visible current MusicMute app. If somebody
manually opens a different MusicMute build whose pinned runtime does not match
the active release, that build fails closed and asks for Prepare; it does not use
the active incompatible release or a system tool. Preparing that build installs
and atomically selects its exact runtime. The last copy successfully prepared
also owns the per-user Chrome launcher, so switching between manually retained
copies may require Prepare again. Running old and new app copies side by side is
therefore unsupported, while ordinary compatible updates reuse the existing
verified files.

Runtime downloads are maintained under the same exclusive preparation lock.
MusicMute keeps only the exact current resumable partial while preparation is
incomplete. Its private bounded sidecar binds the runtime ID, URL, expected hash,
expected bytes and a strong ETag. Resume uses `Range` with `If-Range` and accepts
only an exact identity-encoded `206` response with matching ETag, range and
length. A missing, weak or changed validator, a replacement `200`, invalid range,
or final digest mismatch discards incompatible state and permits only one bounded
clean restart. Cancellation retains a partial only when its durable sidecar is
safe. MusicMute prunes stale recognized archives safely and requires the
downloads directory to be empty before activating a verified release. Unknown,
linked or otherwise unsafe entries are left untouched and make preparation fail
closed.

The supported recovery entrypoint runs the same native installer and companion
setup as the GUI:

```sh
APP="$HOME/Applications/MusicMute Local.app"
# Use APP="/Applications/MusicMute Local.app" if that was the chosen install folder.
"$APP/Contents/MacOS/MusicMuteLocal" --prepare
```

It is intended for support and recovery only. Users normally prepare entirely
inside the app.

### Complete-partial validation boundary

The development candidate may seal a reserved, non-resolving runtime host so it
can prove packaging without implying public hosting. For a fresh app-data
qualification of that exact package, a harness may place the package's own
byte-identical runtime ZIP at the exact expected `.zip.partial` path in a new,
private `runtime/downloads` directory. It must not create an active release,
model, launcher or registration first.

Native Prepare then independently checks the partial's owner, type, permissions,
declared byte count and SHA-256 before promoting it. Continuing through extraction
can prove the full leaf inventory and code signatures, atomic activation, model
preparation, launcher creation and Chrome registration when each of those stages
is separately observed. This is an exact package-bound **complete-partial seed**,
not a runtime network download. It does not exercise the sealed URL, DNS, TLS,
redirect allowlist, CDN availability, HTTP range/ETag resume or zero-byte transfer.
Only a run that begins without an archive or partial and retrieves the immutable
artifact from its sealed HTTPS URL may claim fresh runtime download proof. Any
model network download, app installation, Chrome handshake or processing result
also keeps its own explicit evidence boundary.

Deleting or replacing the `.app` alone cannot establish fresh app data because
the runtime, model, account state, cache, logs, native launcher and Chrome
registration are external. A destructive reset is a separately authorized test
step scoped to the exact MusicMute Local paths. It must not remove MusicMuteWorker,
browser profiles, repository packages or unrelated application data.

### Historical 58d55f40 authorized app-data reset and Prepare checkpoint

The prior app, support root, native manifest, preferences and backups were first
isolated at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-063747-final-58d55f40`;
auth/guest Keychain items were absent with delete status 44. Worker state, Chrome
profile and repository artifacts were preserved. Build `58d55f40` was installed
in `/Applications`; all 139 package/installed file/link leaves, build, ARM64
architecture and deep strict signature matched. There were no byte/link
differences; installation normalized only the group ID, and no bundle node is
group/world writable.

After proof, the `063747` archive was permanently purged and is absent and
unrecoverable. Earlier `053140` and `055936` reset archives are also absent. The
empty installer-created `/Applications/.musicmute-backups.noindex` and old
auxiliary paths were removed/verified absent. At that checkpoint,
`/Applications/MusicMute Local.app` was build `1791171228`.

Only the exact package runtime `.zip.partial` was preseeded mode 0600. Prepare
validated it in 19,736.927 ms, downloaded/verified the model in 13,417.891 ms,
passed all six checks and showed **Ready** / **Mac ready**. Support/runtime/downloads were
0700, downloads empty, `active.json` 0400 with the exact runtime/archive, launcher
0700, and model/native manifest 0600. This is not runtime URL/DNS/TLS/CDN/Range
proof or fresh-machine acceptance. Package proof
`output/packaged-tools-proof/5d721f3c-235d-4577-9da2-33c35c756e3a.noindex/result.json`
passed all 15 checks. External `final_inventory_sha256` is
`2fda53d1b4216db660fc11777e817527b282cfd25439423a8a7de48dc4a91a03`;
embedded bundle-audit/package identity is
`9606d131c65fe59910dd77e5c82f6eac1b5dc09e465878fe0e45eecfb5f755b5`.

The superseded build `2ed7711e` retains historical package and Prepare evidence,
but final audit found that its Home/Library connected copy could follow socket
readiness before the current account/stream's first valid jobs snapshot. Final
build `58d55f40` scopes snapshot acceptance to the account and stream, resets and
fences stale connections, and makes connected copy wait for real snapshot
readiness. Native regressions cover wrong account/stream, reconnect, pagination,
teardown and malformed snapshots.

### Interim e2aa authorized app-data reset and Prepare checkpoint

On 2026-10-05 the previous MusicMute Local app, support root, native-messaging
manifest, preferences and app backups were initially isolated at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-053140-final-e2aa`.
Account-auth and guest-capability Keychain items were absent; the delete commands
returned status 44. The exact e2aa package was installed in `/Applications`, its
ARM64 build and strict signature were verified, and its package checksum tree
matched before the absent support root was allowed to initialize.

The run deliberately preseeded only the package's exact 410,586,280-byte runtime
archive at the expected downloads `.zip.partial` location with mode 0600. This
saved a repeated development transfer and exercised the safe complete-partial
path described above. Prepare consumed the partial, verified and activated runtime
`macos-arm64-v1-c923b1be1f135d8c48ef81c9`, downloaded and verified the
66,759,214-byte model with SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`,
and passed all six component checks. The UI showed **Ready** / **Mac ready**.

Readback found the support root, runtime and downloads directories at mode 0700;
downloads was empty after success. `active.json` was mode 0400 and pinned the
runtime plus archive SHA-256
`9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`;
the launcher was mode 0700 and native manifest mode 0600. The installed app still
passed strict signature and ARM64 checks. This proves clean app/support-data
initialization and actual model download, but not runtime URL/DNS/TLS/CDN/
redirect/range behavior or fresh-user/quarantined-machine acceptance.

The package record is
`output/macos/build-e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6.noindex/package-result.json`.
Its `final_inventory_sha256` is
`b182774d45d2cb24b5d6c529e596b2a2160d9403a2a1bfd2553c62f19f77b4d7`;
the distinct companion `package_inventory_sha256`
`a0f4091d4d96e9bc734287ae1ede7ddb422ee5b776844c8dc335610e04fc9e53`
is the hash of `Contents/Resources/bundle-audit.json`. The disposable packaged
qualification at
`output/packaged-tools-proof/25f5be61-a442-436b-bc26-b1c987c7f24b.noindex/result.json`
passed all 15 checks; it did not use the installed GUI, real browser profile,
account, Keychain, model download or inference.

## Contract guideline preflight

Read the current [Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-04 before native-message changes. Portable rules applied: 106
(backward compatibility), 109 (conservative schemas), 177 (no stack traces),
200 (avoid sensitive event data), and 214 (duplicate-safe event consumption).
New fields are bounded and optional, with negotiation where old strict consumers
require it. Existing request/generation/account fences remain in use. Native
messaging and app links are not REST endpoints; HTTP method/status, URL resource
naming and OpenAPI deployment requirements do not apply to those transports.

## Historical pre-thin verification status

The package sizes and installed-app checkpoints below predate the external-runtime
thin package. They remain useful historical behavior evidence, but they do not
prove the current thin app, fresh runtime download or runtime reuse contract.

### Reinstall repair on 2026-10-04

An actual reinstall retained Chrome's exact `com.musicmute.local` manifest while
the per-user `native-launcher.sh` was absent. Model and runtime checks passed,
then registration raised `ENOENT`, which the app displayed as
`APP_COMMAND_FAILED`; Chrome subsequently reported `COMPANION_DISCONNECTED`.
Setup now recreates a missing launcher after checking the host name, `stdio`
transport, exact extension origin and approved launcher path. Existing foreign,
symlinked and unsafe files remain protected. The 19 setup tests include this
reinstall case and foreign-registration/launcher preservation.

`npm run verify` passed 1,587 tests in 54 files, typechecking, 151-file lint with
zero warnings/errors, build and formatting. The packaged-tools qualification now
removes only its disposable launcher, retains its manifest and runs actual setup
again. All 13 checks passed offline, including repaired registration, all six
ready components and GUI-closed native HELLO. Its report is
`output/packaged-tools-proof/48b90df7-7f83-485e-a8d0-628fe1117309.noindex/result.json`.

The corrected historical package is
`output/macos/build-44ea0e61-6b54-4df0-ab87-c3fd7d7f551b.noindex/` and was installed
at `/Applications/MusicMute Local.app` at that checkpoint. Only `companion/app-control.js`, the
bundle audit and outer signing records changed; 18,161 other file/link entries
were preserved. All 18,165 installed entries matched the candidate and deep,
strict signature checks passed. The existing model remained verified. The native
Setup screen showed all six components Ready and the actual Chrome popup showed
Your Mac is ready. The previous app is retained in the installer's private
backup. Safe installed evidence is in
`output/reinstall-repair.noindex/installed-proof.json`.

Future local reinstalls can use
`output/reinstall-repair.noindex/MusicMuteLocal-0.1.0-setup-repair.dmg` instead of
the old installer. The 506,355,686-byte image passed `hdiutil verify`; its copied
app passed deep, strict signature verification before image creation. Its SHA-256
is `a9d8173c412a856d9cac55d28c12b1edb494f2cc423c8fbcd4a44c23de8f8da2`.
It is a local development installer, not a notarized public release.

A separate fresh-video attempt exposed `COMMUNITY_SESSION_UNAVAILABLE` after the
Chrome connection was repaired. A bounded invalid-body probe of the public API's
`POST /youtube-guest-sessions` returned 404 `RESOURCE_NOT_FOUND`, while health
returned 200. The installed client requires the matching community backend
release described in [the contribution contract](../../docs/url-imports/youtube-community.md).
This repair did not deploy the backend or establish fresh-video processing.
The local app remains ad hoc signed and not notarized.

The final 2026-10-04 source gate passed `npm run verify`: 1,562 tests in 53 files,
149-file lint with zero warnings/errors, TypeScript checking, build and formatting.
`npm run test:native` passed the native, desktop and updater suites. All 69 Python
tests passed using the packaged Python with `-I -B -S` and the qualified downloader
target, covering downloader/source isolation, local pipeline boundaries, native
locks and orphaned update leases. An earlier default-Python run skipped 28 cases
without those prerequisites; the final isolated run had no skips.

That historical local package is
`output/macos/build-6b22ab33-5a3b-42c4-a42f-f2e71a52d029.noindex/`, version 0.1.0,
build 1791115941. It contains 343 ARM64 native binaries and 1,317,199,844 inventoried
bytes. It is ad hoc signed, has no updater feed/key configured, and is not
notarized or installed by this task.

Its isolated packaged setup qualification passed all 12 checks. Actual bundled
Python/Node executed offline Prepare and status with all six components ready;
actual Deno ran the synthetic EJS signature/n challenge and token-provider/canvas
health. The generated native launcher exchanged a ready HELLO and shut down
cleanly with the GUI closed. Bundle signatures remained intact. Bundle permission
and simulated differing-UID checks passed. The cached model was privately cloned;
networking, real browser/account/Keychain work and user-state changes were denied.
The proof is
`output/packaged-tools-proof/369128d7-0c49-4f8f-8608-f5ca128b9355.noindex/result.json`.
See [repeatable packaged qualification](packaged-tools-qualification.md).
All 23 final companion/extension distribution files match the packaged bytes.

The compiled Chrome content UI fixture passed 10 checks across eight error cases,
including cooldown countdown, safe copy and explicit cloud/old-app guidance, with
zero browser errors. Its report is
`output/error-ui-1791114682934.noindex/report.json`. This HTTP fixture does not load
the extension or contact YouTube. The real pinned Sparkle signer verified a
synthetic archive and feed and rejected a changed archive, using a temporary
fixture key without Keychain access.

These checks do not establish future YouTube availability, paid cloud success,
fresh-user Gatekeeper acceptance, real Chrome playback, Apple acceptance or public
update/relaunch. Public redistribution still needs the native dependency notice
and corresponding-source review documented in [bundled YouTube setup](youtube-runtime.md).

### Playback performance update (2026-10-05)

Cloud YouTube requests now submit URLs without local original acquisition or model
readiness. Local/shared cache checks precede engine startup; trusted shared originals
can skip YouTube acquisition. The packaged private local engine remains warm for
two idle minutes and retires on cancellation/update identity changes. See
[processing selection](processing-selection.md) for validation boundaries and diagnostics.
Local ad-hoc DMGs remain for prepared Macs; a placeholder runtime download URL is
not a fresh-user distribution or notarization proof.
