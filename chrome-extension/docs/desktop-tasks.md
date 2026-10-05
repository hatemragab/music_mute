# Account-connected desktop delivery

Owner: this MusicMute desktop task. Started 2026-10-02. This is the follow-up
ledger for the existing Mac app and Chrome extension, not a new installed app.
Unchecked items remain work; source tests do not establish real account, private
R2, Google sign-in or YouTube acceptance. The current single canonical
`/Applications/MusicMute Local.app` is candidate build
`c14116b8-cf2c-4865-8a24-f9f1dce2a119` / `CFBundleVersion` `1791212763`. Its
17,663,025-byte ARM64 tree matches all 139 package/installed leaves and passes
deep strict signing. It was an ordinary compatible update that reused the
existing runtime/model/data; full installed verification created its private
authenticated runtime receipt. Historical build `58d55f40` retains the separate
clean-support Prepare, signed-out Home, synthetic local GUI processing, Library
persistence/replay, connected-copy omission, loaded-extension bundle alignment
and registered-manifest HELLO/local-mode evidence accepted on 2026-10-05. Build
`2ed7711e` is older history because it predates the first-jobs-snapshot
Library-readiness fence; e2aa is older interim history. The final clean run
remained signed out, so previous real
Google/Firebase/backend and owner/private-R2 evidence keeps its earlier-build
scope and is not relabelled as final-build acceptance. Mobile UI sync, uncached
YouTube acquisition/separation, listening quality, sustained duration and public
release remain open. All prior
installed builds, including e2aa, `05a05b5c`, `82bd3515`, 679 and cb candidates, are
historical and retain only their recorded scope.

## Accepted behavior

- Apple Silicon macOS first. Shared TypeScript processing, storage and transport
  boundaries must permit a later Windows client. Worker CLI integration is deferred.
- **On this Mac** is the default. **Cloud** is an explicit selection using the
  existing Android processing access, admission and quota rules. Never switch
  silently or bill cloud processing for local inference.
- Local playback becomes available before account saving completes. Automatically
  upload the original and vocals to the signed-in owner's account; account upload,
  download and retained-storage allowances still apply. Cloud results already
  belong to the account and must not be uploaded a second time.
- Preserve the full timeline for synchronized YouTube playback. A saved local
  result is a normal owner Library result. Client-supplied media must not silently
  become globally trusted shared YouTube media.
  The approved 2026-10-04 guest contribution path publishes only YouTube pairs with
  explicit community provenance. It reserves one producer before acquisition,
  captures durable paired bytes, and lets all account clients reference approved
  shared objects. Personal file uploads retain the private account path. Guest
  capabilities live in Keychain; native full snapshots wake waiting producers.
- Default to **2 GB (2,000,000,000 bytes)** of offline vocals in one shared cache.
  Settings → Storage accepts a custom whole-GB limit starting at 1 and a reset
  to 2 GB. Saved limits apply to desktop and already-running Chrome helpers.
  Lowering the limit does not remove voices until the next cache admission.
  Reuse matching verified vocals before inference. Evict least recently used
  unpinned vocals when necessary; try the account copy before processing again.
- Originals are temporary locally. Keep an original until separation and durable
  account upload confirmation are complete, then remove the owned local copy.
  Pending upload originals have a **256 MiB (268,435,456-byte)** aggregate bound,
  with active scratch admitted separately. Pending originals are protected until
  committed receipt; quota/network failure must not silently discard the pair.
  The configurable vocals limit excludes the installed runtime/model and active scratch.
  Never silently discard an unsaved pair or evict active/pending vocals.
- Account changes invalidate in-flight credentials and callbacks. Account A's
  files and pending saves can never be submitted under account B. Network failure
  or quota rejection does not undo a successful local result.
- Native Home owns the signed-out account prompt and links to the web app and
  reviewed Android listing through one strict public-destination allowlist.
  Google actions pair localized accessible text with the multicolor Google G.
  Login establishes the account session; Library realtime connection and actual
  cross-device synchronization remain separate observable states. Public links
  neither transfer credentials nor establish store/release availability.
- A ready WebSocket is not a connected Library. Home and Library show connected
  copy only after a structurally valid jobs snapshot for the current account and
  stream. Reconnect, disconnect, account changes and stale completions reset or
  fence readiness; pagination on the same ready stream preserves it.
- Match Android's Home, Library, Settings, account and player journeys, using its
  dark palette, configurable accent and English/Arabic behavior.
- Diagnostics stay local, bounded and redacted. Tokens, private grants, cookies,
  source filenames/URLs and audio do not enter reports.

## Execution order and acceptance

| ID  | Task                                                                           | Source status                                                                                                                                               | Remaining acceptance                                                                                                                                 |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Configurable vocals cache (2 GB default), recency, pins and verified reuse     | Implemented; native pin/recency race fixtures and installed 36-check cache, pressure, pins and ten-cycle replay pass                                        | Sustained resources, live account-copy downloads and broader installed playback; public YouTube source identity still open                           |
| D2  | Durable owner-bound original/vocals staging and upload outbox                  | Implemented; live ready receipt removed staged original and preserved selected WAV                                                                          | Installed restart/account-switch/revocation/disk-pressure/ambiguous-response matrix                                                                  |
| D3  | Backend local pair admission, grants, validation and ready Library publication | API105; live authenticated local-file private-R2 original/vocals pair committed                                                                             | Owner downloads, mobile Library UI and broader source/limit/error matrix                                                                             |
| D4  | Native Google/email account session, Keychain and Mac platform contract        | Actual Google/Firebase/backend sign-in and replacement 82bd3515 saved-session restoration confirmed                                                         | Email/link/refresh/logout/deletion recovery and minimum-build behavior                                                                               |
| D5  | Desktop processing bridge and file/YouTube local entry                         | Current c141 warm-cache real-YouTube playback start; historical 58d synthetic GUI/playback/relaunch and earlier owner-save proof retain scope               | Uncached acquisition/separation, cancellation/long-duration resources/listening/source-track matching                                                |
| D6  | Explicit cloud provider and quota/access UI                                    | Implemented in native Home; fixtures pass                                                                                                                   | Real admission/quota rejection, imports/jobs/reconnect/cancel/download; Chrome explicit Cloud choice is separate                                     |
| D7  | Automatic background account save and recovery                                 | Native watcher automatic live SYNC committed; same-owner warm replay reused same job                                                                        | Ambiguous-response recovery, restart/revocation/quota fences and cross-device Library UI                                                             |
| D8  | Android-style Home/Library/Settings and account operations                     | Native source present; parity incomplete                                                                                                                    | Installed visual/English-Arabic RTL/accessibility review and authenticated search/sort/filter/rename/delete/devices/linked-methods/recovery journeys |
| D9  | Desktop player, originals/vocals, downloads/export and listening tools         | Native source present; parity incomplete                                                                                                                    | Installed queue/resume/rate/seek/original-voice alignment, sleep/loop/bookmarks/silence skip, export/share and safe teardown/listening               |
| D10 | Extension account/provider integration and source ownership                    | Current final `dist` path plus c141 **On this Mac**/playback logs; historical 58d direct local-mode bridge/HELLO; owner/cloud contracts implemented         | Owner-save/account-restore, explicit Cloud live path, uncached source/audio identity and broader popup/controls matrix                               |
| D11 | Local bug/performance views and regression coverage                            | Implemented; local source checks pass                                                                                                                       | Correlated installed sync/inference timing, repeated-run memory/disk baselines and long-run reports; no remote telemetry                             |
| D12 | Package canonical app and real Mac/Chrome acceptance                           | Current c141 installed/aligned/strict-signed with receipt and warm-cache YouTube start; historical 58d clean Prepare/synthetic GUI/protocol remain separate | Fresh OS user/machine, runtime network path, uncached/listening/long-run, notarization/updater/public release                                        |
| D13 | Cross-product Home sign-in and public discovery                                | Historical 58d signed-out Home showed Google/email actions and product discovery without stale media error; offline Library omitted connected copy          | Current full RTL/accessibility, destination availability and real login/sync                                                                         |

Complete milestones one by one while independent implementation proceeds in
parallel. Record actual commands and limitations below. Do not commit, publish,
deploy the backend, change real account data, or create OAuth/cloud resources
without a direct request. Production activation is separate from local completion.

## Current c14116b8 package/install and receipt checkpoint — 2026-10-05

Build `c14116b8-cf2c-4865-8a24-f9f1dce2a119` / `1791212763` is the current
17,663,025-byte ARM64 ad-hoc candidate. All 139 package/installed file/link
leaves, build and architecture matched, and deep strict signing passed. External
inventory SHA-256 is
`3e5d49e98f7147ac049224d36a1227b3ad46cb48f08711ff2f79f8762e00a276`;
the embedded bundle-audit file SHA-256 is
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`.
The package record is
`output/macos/build-c14116b8-cf2c-4865-8a24-f9f1dce2a119.noindex/package-result.json`;
its 15-check disposable qualification passed at
`output/packaged-tools-proof/e9fb0a01-33a0-44b9-b18a-391fe2130002.noindex/result.json`.

This ordinary compatible update reused the exact 58d external runtime and model.
Installed full runtime verification created the private mode-0400 authenticated
receipt. It permits the bounded cross-process fast path only after outer-app
validation and two identical metadata passes; missing, invalid or mismatched
receipt state falls back to full verification. The disposable proof opened no
GUI/browser and used no real profile, account, Keychain helper, network transfer,
model download or inference.

Chrome Secure Preferences confirmed the final unpacked `dist` for ID
`dclpfemnpknfdlpcbfcjkmdbnociippd`; its reload preceded the c141 app install.
After installation, one refreshed real Stromae YouTube tab reached visible
**MusicMute · On this Mac** and **Voice-only playback**. The c141 companion
identity matched `0.1.0` plus package inventory
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`, and logs
recorded `cache_hit=true`, 66.157 ms to ready and `playback_started`. This is a
warm-cache start, not uncached acquisition/downloader/MPS separation, listening,
source-identity/lip-sync, sustained playback or a broad controls/restart run. No
c141 clean reset, fresh Prepare, runtime-network, fresh-user, account/R2/cloud,
notarization, public-release or Web Store acceptance is inferred here.

## Historical 58d55f40 clean app-data installed checkpoint — 2026-10-05

Build `58d55f40-6789-42fb-9e02-5f3e43f5cc3f` / `1791171228` was the then-canonical
17,547,290-byte ARM64 ad-hoc app. The external inventory SHA-256 is
`2fda53d1b4216db660fc11777e817527b282cfd25439423a8a7de48dc4a91a03`;
the embedded bundle-audit identity is
`9606d131c65fe59910dd77e5c82f6eac1b5dc09e465878fe0e45eecfb5f755b5`.
The exact runtime remains `macos-arm64-v1-c923b1be1f135d8c48ef81c9`:
410,586,280 archive bytes, SHA-256
`9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`,
1,297,496,698 installed bytes and 18,031 leaves. With the 66,759,214-byte model,
the base footprint is 1,381,803,202 bytes. The package result is
`output/macos/build-58d55f40-6789-42fb-9e02-5f3e43f5cc3f.noindex/package-result.json`;
the disposable packaged proof passed all 15 checks at
`output/packaged-tools-proof/5d721f3c-235d-4577-9da2-33c35c756e3a.noindex/result.json`.

The final reset first isolated the prior app, support root, native manifest,
preferences and backups at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-063747-final-58d55f40`.
Auth and guest Keychain items were absent with delete status 44; Worker state,
Chrome profile and repository artifacts were preserved. The exact final app was
installed into `/Applications`; all 139 package/installed leaves, ARM64 and deep
strict signature matched with no byte/link differences. Installation normalized
only GID and left no group/world-writable bundle node. Only the exact package
runtime was preseeded as the mode-0600 expected `.zip.partial`. Prepare validated
it in 19,736.927 ms, downloaded/verified the model in 13,417.891 ms, passed all
six checks and reached **Ready** / **Mac ready**.
Post-Prepare support/runtime/downloads directories were 0700, downloads empty,
`active.json` 0400 with the exact runtime/archive, launcher 0700, and model/native
manifest 0600.

After proof, the `063747` reset archive was permanently purged and is absent and
unrecoverable. Earlier `053140` and `055936` archives are also absent. The empty
installer-created `/Applications/.musicmute-backups.noindex` was removed and old
auxiliary paths were verified absent. At that checkpoint the installed app was
build `1791171228`.

Signed-out Home showed Google/email plus web/Google Play links with no stale media
error. The exact 264,678-byte synthetic WAV reached **Voice ready** in 58,356 ms,
auto-played to 3.017 seconds and saved a 3.0-second, 62 KB offline Library entry.
Quit/relaunch preserved it and replay loaded with **Pause** at 0:00. Signed-out
Library correctly omitted connected copy.

Existing unpacked Chrome ID `dclpfemnpknfdlpcbfcjkmdbnociippd` remained loaded
from repository `dist`; its core files matched the installed package, and the
registered native manifest/launcher were exact. The installed bridge returned
`processing_mode: local`. An exact native-messaging HELLO through that manifest
and origin returned `ready: true`, darwin/arm64, v0.1.0, 1,200 seconds and
`LOCAL_MACOS`, negotiating `processing_selection_v1`. The host exited afterward
and GUI remained closed. This is protocol-level handshake and on-disk loaded
bundle alignment, not a final popup observation.

The readiness correction accepts a Library jobs snapshot only when it is
structurally valid and matches the current account and stream. Reconnect,
disconnect, account changes and stale callbacks reset or fence readiness;
same-stream pagination preserves it. Home/Library connected copy consumes that
state rather than raw socket readiness. Native regressions cover wrong account/
stream, reconnect, pagination, teardown and malformed pages.

This is an existing development Mac with a preseeded runtime, synthetic audio and
a preserved Chrome profile. It is not fresh OS user/machine, runtime-network,
real YouTube/listening/lip-sync, signed-in account/cloud Library/R2, cloud job,
long-run, notarization/public-release or Web Store proof. The app remains ad hoc,
unnotarized, updater-unconfigured, `public_ready=false` and
`relocated_runtime_tested=false`. The future Downloads and Google Play
destinations were unavailable when checked and remain discovery-only.

## Superseded 2ed7711e installed checkpoint — 2026-10-05

Build `2ed7711e-7cd6-4b37-992f-c6fb02782812` / `1791168902` retains its dated
package, clean Prepare, synthetic playback/relaunch and preserved-profile Chrome
evidence. It is not source-final because final audit found the Library
socket-ready-before-first-jobs-snapshot gap. The historical `58d55f40` section
above adds the account/stream snapshot fence and supersedes it. Its `055936` reset archive
was permanently purged and is unrecoverable.

## Interim e2aa clean app-data installed checkpoint — 2026-10-05

This checkpoint remains dated evidence, but it is not source-final because later
audits required Google-mark, account-online copy and snapshot-readiness fixes. The e2aa
package record is
`output/macos/build-e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6.noindex/package-result.json`.
Build ID `e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6`, `CFBundleVersion` `1791167264`,
contains a 17,524,330-byte ARM64 thin app. Its external runtime is
`macos-arm64-v1-c923b1be1f135d8c48ef81c9`: 410,586,280 archive bytes with
SHA-256 `9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`,
1,297,496,698 installed bytes and 18,031 entries. App + one runtime + the
66,759,214-byte model total 1,381,780,242 bytes. The final external inventory SHA
is `b182774d45d2cb24b5d6c529e596b2a2160d9403a2a1bfd2553c62f19f77b4d7`;
the companion's distinct `package_inventory_sha256`
`a0f4091d4d96e9bc734287ae1ede7ddb422ee5b776844c8dc335610e04fc9e53`
hashes `Contents/Resources/bundle-audit.json`. The app is ad hoc signed and
strict-signature verified, but `notarized=false`, `public_ready=false`,
`relocated_runtime_tested=false` and its Sparkle updater is unconfigured.

The disposable packaged-tools report at
`output/packaged-tools-proof/25f5be61-a442-436b-bc26-b1c987c7f24b.noindex/result.json`
passed all 15 offline checks. Separately, the authorized installed reset initially
isolated the old app, support root, native manifest, preferences and backups at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-053140-final-e2aa`.
Account-auth and guest-capability Keychain entries were absent; their deletion
commands exited 44. The exact e2aa package was installed in `/Applications`,
with strict signature/build/ARM64 and package/installed checksum-tree agreement.
The MusicMute Local support root was absent before Prepare.

Only the exact sealed runtime archive was preseeded at the expected
`runtime/downloads/*.zip.partial` path with mode 0600 to avoid repeating a
410 MB transfer. Prepare consumed it through the normal verification/extraction/
activation path, downloaded the model, verified its SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`,
passed all six component checks and showed **Ready** / **Mac ready**. Readback
found 0700 support/runtime/downloads directories, empty downloads, 0400
`active.json` selecting the exact runtime/archive, a 0700 launcher and 0600 native
manifest. This is a clean app/support-data run on an existing development Mac,
not a fresh OS user/machine or runtime URL/DNS/TLS/CDN/range test.

Signed-out Home displayed Google/email actions and product discovery without a
stale media error. The installed GUI processed
`output/desktop-smoke/8eae9504-066c-424b-8935-00ed135f9e9e/synthetic.wav`
(264,678 bytes, SHA-256
`001d9f51f6ab3149daea19ac4188cbcfe3faf4cfe6e1b789e3c958cc15ba6703`),
reported **Voice ready**, advanced the player to 3.017 s and showed a 3.0-second
**Saved offline** / 62 KB Library result. After clean Quit/relaunch, Library
persisted and replay advanced from 0.250 s to 3.017 s.

The existing unpacked extension `dclpfemnpknfdlpcbfcjkmdbnociippd` was reloaded
from the installed e2aa app. Popup copy was corrected to **Up to 20 min**,
**Your Mac is ready** and **Ready · processing stays on this Mac**. Local tools
showed **On this Mac — Apple Silicon**; a direct settings request returned
`processing_mode: local`. With the GUI quit, **Check again** launched the installed
native host and returned Ready. The profile's eight saved local errors date to
2026-10-04 and are retained history, not fresh e2aa failures.

This interim run used synthetic audio only and did not establish listening quality,
real source identity, lip-sync or sustained-duration behavior. It stayed signed
out, so it adds no account, cloud Library, R2 or cloud-processing proof. Chrome
was an existing unpacked profile; no new YouTube source/acquisition/playback or
Chrome Web Store proof was produced.

## API preflight

The current official [Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were opened on 2026-10-02, including the table of contents and relevant security,
OpenAPI, JSON, compatibility and idempotency text. Apply portable requirements:
authenticated owner authorization, snake_case new JSON, additive native platform
support, resource-based pair/grant/completion routes, durable idempotency and
documented success/errors. Existing auth/device JSON already uses snake_case through
the global wire adapter; internal DTOs remain camelCase. Keep those contracts
compatible. The existing raw WebSocket transport remains responsible for
live snapshots; HTTP handles commands, grants, transfers and explicit recovery.
Applicable current rules include 101 (OpenAPI), 104 (endpoint security), 118
(snake_case JSON), 106 (backward compatibility), 229 (idempotent mutations) and 231
(durable secondary keys). Link identifiers in browser output are not rule IDs.

## Validation log

- 2026-10-02: read current component, backend, storage and realtime instructions.
  Confirmed the existing native shell has Setup/Overview/Diagnostics and that
  cache behavior at that initial study was 512 MiB plus seven-day expiry. Existing source/package
  evidence in other ledgers predates this desktop change and is not new acceptance.
- Initial read-only code study was complete at this checkpoint, before the later
  production deployment. No account upload had occurred.

## Implemented contracts and boundaries

The native default Local path prepares a full-length result with the same pinned
Kim Vocal 2 engine and stages newly processed original/vocals for the current owner. Playback can
succeed while saving is pending or blocked. There is no cloud-compute reservation
or billing for that local inference. Local originals, WAV/FLAC included, keep
their declared/probe-verified format; selected user files are not deleted.

Backend `POST /local-media-syncs` creates a private idempotent pair with immutable
signed grants; `GET /local-media-syncs/:id` is explicit recovery,
`POST /:id/upload-grants` renews grants, and `POST /:id/completions` validates
actual bytes/checksums/type/probe/full decode/timeline before producing one
ordinary ready owner Library job. A committed receipt releases the owned pending
original. The durable resource handles duplicate completion, ambiguous PUT,
expiry, revocation and account deletion. Both artifacts consume applicable
transfer/storage allowances. Objects remain private R2; client YouTube metadata
is not promoted into the global shared-media catalog. See the
[client contract](../../docs/api/client-contract.md) and
[OpenAPI](../../backend/openapi.yaml) for wire details.

Cloud is an explicit native Home selection with confirmation and the Android
account processing access/quota rules. It uses existing imports/jobs and raw
WebSocket full snapshots, not HTTP status polling. Fresh tickets, stream/sequence
and owner/session-generation fences protect reconnect. A lost upload response is
reconciled through completion rather than creating another paid intake. Cloud
results already belong to the owner and are not pair-uploaded again. The existing
API cannot cancel an accepted URL acquisition before it produces a job; stopping
waiting at that stage does not undo acquisition.

Account offline downloads use scoped HTTPS R2 grants without bearer headers or
redirects, bounded streamed bytes, actual checksum and cold full decode, then an
owner/job/recipe-bound private cache. Warm reuse verifies retained hash/manifest
without another transfer or GPU pass. Native account Library supports trimmed
results up to the existing 30-minute/60 MiB output limits, including bounded
encoder padding; synchronized YouTube requires the compatible recipe,
`trim_enabled:false` and full timeline. The local YouTube inference limit remains
15 minutes. Cached vocals do not establish player-selected audio or a future
upstream source replacement.

One global configurable decimal-GB vocals LRU (2 GB by default) is shared by
extension and desktop, with no age-based expiry. Playback and pending-save pins prevent eviction. Pending
originals have the separate 256 MiB aggregate limit; installed runtime/model,
active scratch and bounded diagnostics are outside the vocals budget. Owner
changes fence credentials, callbacks, cache visibility and outbox submission.
Unsafe linked/foreign files are refused, and interrupted staging recovery only
cleans proven owned work. Worker CLI integration and Windows packaging remain
follow-ups; no fleet service or credentials were copied into this milestone.

## Warm-cache account-save implementation

The acquisition and identity foundation is implemented in source:
`LocalMacProvider.acquireYouTube(request, workRoot, hooks)` returns the actual
original artifact, conservative source provenance and acquisition timings after
qualified metadata/download replay, probe/full decode, private-file identity and
SHA-256 checks. It never runs model separation or grants verified-model provenance.
Cold preparation uses the same method. New retained vocals include a strict
path-free original declaration (extension, content type, bytes, duration and hash),
derived from the validated original; warm cache reads reject malformed declared
evidence. The focused local-provider/jobs run passes **112 tests in two files**.
Legacy absence still permits playback without creating a new byte-identity claim.

- [x] Durable owner-bound capture tickets are integrated in native/extension
      source and the current installed bundle. Warm guest/public YouTube playback
      becomes ready immediately, while the native background path reacquires only
      the original and checks exact bytes/hash/type plus full timeline and source
      provenance before owner-pair staging. It runs no model inference. Local
      account generation, revoked/deleted owners, duplicate receipts, bounded
      workspaces and pending/playback pins remain fenced. Transient failure is
      deferred without automatic retry; legacy entries lacking a trustworthy
      declaration remain playable with saving unavailable.
- [ ] Prove the new installed capture path against real YouTube, authenticated
      owner admission, private R2 two-artifact completion and mobile Library.
      Matching video/duration alone cannot establish original-byte identity or
      close real-player selected-track/source-version acceptance.

## 2026-10-02 source and local validation checkpoint

- From `chrome-extension/`, `npm run verify` passed TypeScript typecheck,
  zero-warning lint, **33 Vitest files / 622 tests**, build and full formatting.
  These are source/synthetic/fixture checks. Further tests added after this
  checkpoint are not included in that count without a new full run.
- From `backend/`, `pnpm run verify` passed formatting, zero-warning lint,
  typecheck, tracked-secret scanning, transfer benchmark checks,
  **148 unit files / 1,247 tests**, **28 HTTP fixture files / 160 tests** and build.
  `node --test test/local-media-sync.integration.mjs` also passed its isolated
  local MongoDB replica-set test with synthetic FFmpeg media. It covers missing
  and tampered uploads, ownership/revocation/expiry/deletion, replay/idempotency,
  two-artifact limits and exact WAV/FLAC original preservation. It performs no
  production or live R2 calls.
- Native teammate validation passed `node scripts/test-native.mjs`: two
  Swift 6 `-warnings-as-errors` suites, `NativeTests` and `DesktopTests`. It covers
  setup/diagnostics/path/journal regressions plus auth/refresh/logout/session
  fencing, optional offline scope tokens, project/PKCE identity, secure markers
  and pins, filesystem-driven sync without a retry loop, synthetic PCM silence
  boundaries and bounded IPC/cancel/SIGPIPE behavior.
- Native teammate also passed complete shell typechecking with
  `xcrun swiftc -swift-version 6 -warnings-as-errors -target arm64-apple-macos14.0 -parse-as-library -typecheck -framework SwiftUI -framework AppKit macos/*.swift`,
  `xcrun swift-format lint --strict` on changed Swift/native test sources,
  `plutil -lint` on `Info.plist` and English/Arabic strings, and
  Prettier/oxlint on the three packaging/test/fixture scripts. Those checks did
  not launch a new native UI or test real sign-in.
- Root ran a real Kim/MPS pipeline through the new native IPC using a synthetic
  three-second file: **9,613 ms cold**, **119 ms warm** and **64 ms Library read**,
  all with zero stderr. The selected original remained, job scratch was empty and
  the cache reported the 1,000,000,000-byte budget. The
  [proof](../output/desktop-smoke/30e2c1c6-4617-4a8c-8638-0117e30f632e/proof.json)
  explicitly records that listening quality was not measured. It used no cloud,
  account upload or real YouTube acquisition.

- Later acquisition-foundation checkpoint: `npm run verify` passed typecheck,
  **98-file zero-warning lint**, **33 files / 651 tests**, build and full
  formatting. The focused acquisition/cache run remained **112 tests in two
  files**, including real synthetic probe/full decode, successful-probe decoder
  rejection, no inference/model claim, guest-to-owner declaration survival,
  legacy playback and malformed declaration rejection. These later counts do
  not erase the preceding 622-test checkpoint.
- Native teammate reran both Swift 6 warnings-as-errors suites after adding
  filesystem watcher coverage for outbox and capture tickets. Fixtures prove
  another UID is ignored, new/restarted pending work wakes, capturing/deferred/
  rejected records do not create retry loops, teardown stops observation and
  bounded backlog drains. Receipt fixtures match cache keys before claiming a
  result is saved, distinguish pending/unavailable/authoritative ready and avoid
  unrelated-save claims. Strict Swift formatting and both localization plist
  checks passed. These are native source/fixture checks, without new package,
  live identity/media or R2 proof.

The preceding 622/651-test and first synthetic MPS checkpoints were source/local
proof before the account milestone replaced the canonical app. Their Google
registration and installation gaps were still open at that time. Their earlier
Chrome observations retain their original build scope.

## Earlier account install checkpoint — 2026-10-02

- Final combined `npm run verify` passed typecheck, **100-file zero-warning
  lint**, **35 files / 669 tests** and build. Its formatting step initially failed
  only while capture files were being written; a subsequent final
  `npm run format:check` passed after those writes. The updated capture/pair/
  desktop-service focused run passed **four files / 32 tests**. This records the
  separate successful checks rather than claiming that combined invocation
  exited successfully. Backend full verification and isolated real-FFmpeg/local
  Mongo pair integration retain the 1,247-unit/160-HTTP-fixture counts above.
- `npm run package:macos` and canonical installation produced
  `output/macos/build-2673319c-8489-4082-8d80-3117c50e396a.noindex/`, with
  **1,116,575,503 bytes** and 303 ARM64 native files. It is ad hoc signed and not
  notarized. Installed `dist/companion/host.js` and `desktop-control.js` match
  source-built hashes, deep strict code signing passes, and only the canonical
  `/Applications/MusicMute Local.app` is visible. Previous bundles are preserved
  in the private hidden `.musicmute-backups.noindex` folder. This is local
  package/installation proof, not fresh-Mac Gatekeeper or public distribution.
- The current installed-runtime/current-`dist` real Kim/MPS native IPC fixture
  used a synthetic three-second file: **9,460 ms cold**, **155 ms warm**,
  **79 ms Library read**, zero stderr and no repeated inference on the warm run.
  The selected user original remained and job scratch was empty. The
  [proof](../output/desktop-smoke/8eae9504-066c-424b-8935-00ed135f9e9e/proof.json)
  explicitly leaves listening quality unmeasured; it used no real YouTube,
  account upload, cloud inference or live R2.
- Desktop Google OAuth client **MusicMute macOS Desktop** is created and its
  public configuration is in the installed app; no client secret was persisted.
  The real OAuth flow reached the correct Google chooser/passkey handoff, then
  timed out after the existing 180-second wait while the UI incorrectly reported
  cancellation. Native source now uses a typed `GOOGLE_SIGN_IN_TIMEOUT`
  distinction with English/Arabic Start again guidance and a bounded ten-minute
  wait; explicit cancellation remains `SIGN_IN_CANCELLED`. Both native suites,
  strict Swift formatting and localization plist checks pass after that change.
  A loopback fixture with a no-op browser opener proves deadline/cancel handling
  without a credential exchange or duplicate completion; it uses no Google/user
  credentials. A later user-approved Google flow returned to the loopback callback
  but failed at token exchange before Firebase/backend sign-in. Source now
  classifies the seven approved token errors using known enum values or an exact
  missing-secret phrase, without exposing raw provider descriptions or bodies.
  Both native suites, strict Swift formatting and localization checks pass after
  this correction. A subsequent one-shot official token-endpoint probe with a
  dummy code and no user credential returned HTTP 400 and identified that this
  registered Desktop client requires its client secret. A fixed-client backend
  `POST /auth/desktop-google-token-exchanges` and native caller are now implemented
  to keep that secret off the Mac. The route is public before Firebase sign-in,
  validates the code/PKCE/exact dynamic 127.0.0.1 callback, reserves atomic Redis
  IP/service budgets and makes one fixed HTTPS Google exchange with no redirect
  or retry, a five-second deadline and a 32-KiB response cap. It returns only a
  bounded Google ID token. Standard sanitized 400/429/503 problems and fixed
  operator reasons expose no credentials or raw provider messages. Native adapter
  checks passed both suites, full Swift 6 typecheck, strict formatting and
  localization validation. Backend-only credentials, new exchange deployment
  and installed native/login acceptance remain pending; API 104 predates this route.
  Google's [installed-app documentation](https://developers.google.com/identity/protocols/oauth2/native-app)
  describes the field as optional generally; the observed response establishes
  the requirement for this particular client, not every desktop registration.
  Replacement-package proof is pending. This is not a completed Firebase/backend
  account session, credential exchange or refresh proof.
- Actual native UI selected the generated three-second fixture, completed local
  MPS preparation and displayed it in Library as saved offline. Initial and
  Library playback both reported that playback could not start, with no AVPlayer
  bar. The confirmed cause was `FileManager.createDirectory` rejecting the
  existing private owned pin directory with Cocoa error 516. Safe existing-pin
  reuse is now implemented with descriptor-relative no-follow creation and
  fsync, including verified `EEXIST` races. Both native suites passed fixtures
  for consecutive pins, unsafe directories and safe/unsafe races. The shared
  journal records fixed redacted failure codes; bounded desktop diagnostics
  expose safe counts, peaks, alerts and activity. These are source/fixture checks;
  replacement installation and native replay acceptance remain pending. This
  result is preparation/Library UI proof, not successful playback
  or listening proof.

## Prior installed playback checkpoint — 2026-10-02

`output/macos/build-c482315f-a482-47b8-ba83-3ec40ca3960f.noindex/` is installed
at the same canonical `/Applications/MusicMute Local.app`: **1,116,763,048 bytes**,
303 ARM64 native binaries, ad hoc signed and not notarized. Deep strict code
signing passes; installed native binary, `desktop-control.js` and `app-control.js`
SHA-256 hashes match the package. The exact four public config keys include the
registered Desktop client ID; no secret is persisted. Only one app is visible,
and the prior bundle is preserved in a hidden `.noindex` backup. It contains the
ten-minute Google callback timeout and fixed-backend exchange adapter.

Real computer-use UI testing replayed the synthetic three-second Library entry.
The AVPlayer bar appeared and its clock advanced from zero through three seconds.
Repeat Track looped; Pause stopped at 0.109 s and accessibility seek increment
moved the paused clock to 0.412 s. Stop and replay succeeded, reused the owned
pin directory and did not repeat inference. The
[visual proof](../output/oauth-review/native-playback-fixed.png) establishes
native playback/clock controls for synthetic media, not listening quality,
sustained resources, real YouTube or account transfers. The earlier pin failure
and its original checkpoint remain above for history.

The installed Desktop diagnostics evidence is available separately from setup:
the three-second local-MPS preparation reports about 9.5 s, child RSS 388 MB and
MPS driver 548 MB, alongside bounded local history. Clean menu Quit left no app
process; reopening returned to Mac-ready Home, the persisted synthetic Library
entry and successful AVPlayer playback. The selected original remains. This is
one local synthetic run/restart observation, not sustained-resource acceptance or
Google/account/private-storage proof.

A later native auth review identified cancellation after Firebase completion and
unbounded HTTP response buffering as remaining corrections. That follow-up is
source work requiring new checks/package; this installed checkpoint does not
claim those newer fixes. Google exchange backend secret configuration/deployment
and completed Firebase/backend sign-in remain unaccepted.

## Latest installed auth-hardening checkpoint — 2026-10-02

`output/macos/build-86ee4723-8133-476a-9cf6-769588384605.noindex/` is now installed
at the same canonical `/Applications/MusicMute Local.app`: **1,116,892,697 bytes**,
303 ARM64 binaries, ad hoc signed and not notarized. Deep strict code signing
passes; the native binary and all three packaged controls match their SHA-256
hashes. The exact four public config keys include the matching registered Desktop
client ID and no secret. Only one app is visible; previous bundles remain in the
private hidden `.noindex` backup.

The later native auth correction is included in this package. Google/Firebase
credentials remain staged until backend confirmation; Cancel promptly aborts
active Firebase/bootstrap/reauthentication work and prevents late acceptance,
remaining distinct from logout. The stream transport enforces a 2-MiB global
response bound and 32-KiB Google-exchange bound, checks declared and received
bytes, and cancels oversized downloads. Both native suites, production Swift 6
typechecking, strict formatting and Info/English/Arabic plist checks passed.
Blocked-phase cancellation fixtures prove no credential saves and prompt busy
clearing without releasing withheld responses; these use synthetic credentials.

A fresh real Google browser flow opened the registered project's chooser and
selected the account; human consent subsequently completed. The authoritative
token-free `account-state.json` now has a UID and session generation. Native
source publishes that state only after Firebase sign-in and backend bootstrap
acceptance, establishing actual Google/Firebase/backend sign-in. No token or
identity value is included in this report. Computer-use visual inspection then
hit pipe failures in three attempts, so signed-in visual UI acceptance remains
pending. A later owner-pair acceptance is recorded separately below. The prior
c482315f playback/diagnostic/restart proof remains
scoped to that build; new-build media acceptance will be recorded separately.

## Production backend checkpoint — 2026-10-02

After the preceding installed checkpoint, the latest complete desktop
`npm run verify` passed **35 files / 690 tests**, typecheck, **100-file
zero-warning lint**, build and formatting in one run. Same-owner warm local-file
save/recovery fixes passed 96 focused tests and avoid repeat inference while
staging the currently selected validated original. Guest-to-owner file caches
remain separate by design for privacy. These newer source checks do not replace
the package hash or native playback/login evidence above.

The additive Desktop Google exchange passed a later complete backend
`pnpm run verify`: **149 files / 1,329 unit tests**, **29 files / 181 HTTP fixtures**,
formatting, zero-warning lint, typecheck, tracked-secret scanning, transfer
benchmarks and build. Its 21 new HTTP fixtures are included; strict validators
also reject trailing line terminators in code/verifier/callback/config/ID token.
Compiled
`node --test test/rate-limits.integration.mjs` passed **12 tests**, including two
service instances sharing a public exchange budget and atomic refusal leaving
the other IP budget untouched. The integration uses isolated real Redis with no
Google client configuration; it establishes shared admission, not real sign-in.
No production credential or OAuth deployment was performed for this new route
at that pre-approval source/package checkpoint.

`pnpm run package:caprover` prepared a separate review artifact `api.tar`,
**2,291,712 bytes / 351 regular unique entries**, SHA-256
`4e1af692844b0e71558f2c82317fc8f65d61a9b7847e35c13ed9bb40fda65d02`.
Inspection matched every archived byte to the tested source/build allowlist and
confirmed the three new exchange runtime files and all six local-media-sync
runtime files. No dotenv, credential data, generated output, tests, mobile/worker
component or dependency-directory files are included. All 351 entries passed
the repository credential scan plus npm credential-assignment check. The
existing Firebase service-account TypeScript helper is runtime source, not a
credential file. This artifact was prepared for operator review before the later
explicit approval and activation recorded below.

The user explicitly authorized production deployment. The allowlisted archive
from the uncommitted checkout had SHA-256
`9947d58cb43b61f7bf91646b2d50dcfbb230a40b9983b18597d69d2e8e197c16` and was
deployed with `caprover deploy -n musicmute -a api`. CapRover build/readback
confirmed `deployedVersion: 104`, `img-captain-api:104`, `isBuilding: false` and
one instance. Live `/health/live`, `/health/ready` and `/app-policy` returned
HTTP 200. Unauthenticated `GET /local-media-syncs/:id`,
`POST /local-media-syncs` and `POST /realtime-tickets` returned HTTP 401.
No commit or push accompanied this deployment. These checks establish running
deployment and authentication protection, not an authenticated account transfer.

After specific human approval for the Desktop-secret retrieval, private backend
configuration and tested Google fix deployment, the exact reviewed archive
`4e1af692844b0e71558f2c82317fc8f65d61a9b7847e35c13ed9bb40fda65d02` was
deployed successfully as **`img-captain-api:105`**. Protected CapRover readback
confirmed `deployedVersion: 105`, the actual `versions[].deployedImageName`,
one instance and `isAppBuilding: false`.
The fixed Desktop client pair is backend-only, matches the registered public
client ID, and preserves other environment values. The application's CLI-setting
regression was caught and repaired as recorded below. Private config
file/directory permissions are 600/700; no credential values were printed or
included in the app/archive/docs.

Live `/health/live`, `/health/ready` and `/app-policy` returned HTTP 200.
Empty `POST /auth/desktop-google-token-exchanges` returned HTTP 400
`INVALID_INPUT`; a single synthetic invalid authorization code with valid PKCE
returned HTTP 400 `GOOGLE_TOKEN_INVALID_GRANT`, both `Cache-Control: no-store`.
The second probe proves that the configured server-to-Google fixed-client path
reached the provider and preserves the safe failure contract. It does not prove
a successful real token exchange, Firebase/backend session or private R2 save.
The earlier API 104 checkpoint is retained above as historical evidence.

The initial claim that every CapRover application setting was preserved required
correction: CLI 2.3.1 cleared `websocketSupport` and `serviceUpdateOverride` during
the update. HTTP health remained 200 while three correct, bounded synthetic
WebSocket handshakes returned Nest problem-JSON 404 for realtime and worker-hint
paths. Those responses bypassed the upgrade handlers' raw empty 401/503 rejection
responses. The operator restored both settings from the owned before-snapshot with a
direct API update containing all 13 fields, then deep-compared every other
application field for preservation. The correct unauthenticated
`/realtime/socket` handshake now returns 401. Actual API 105 image, one instance,
no build, health 200 and synthetic `invalid_grant` 400/no-store remain confirmed.
This records a caught and repaired deployment regression; authenticated realtime
snapshots still need their own acceptance. No credential paths or values are
published.

## Live owner local-file save checkpoint — 2026-10-02

The final installed 86ee4723 `desktop-control LOCAL_START` processed an owned
synthetic three-second WAV using the current token-free accepted owner session,
generation and actual installation. The native app watcher obtained authorization
internally; the test did not read Keychain or bearer tokens. Automatic `SYNC`
obtained a ready, committed server receipt. `LocalSyncTransfer` accepts that
receipt only from a server view with `status: ready` and `committed: true`.

The matching outbox was committed, with no error and a receipt present. After
durable confirmation, the private staged original was absent and the local vocals
remained **61,170 bytes**. The user-selected synthetic WAV stayed intact at
**264,678 bytes**. This verifies live authenticated private-R2 original/vocals
pair acceptance and receipt-before-cleanup for one locally processed fixture.

Same-owner/same-file replay returned in **183 ms** with `cache_hit: true`,
`sync_state: ready` and the same server job. Its progress was only
`preparing_file`/`cache_check`, with no `processing`, `model_load`, separation or
encoding. This is warm vocals/committed-pair reuse without duplicate publication
or repeated inference. Safe proofs:
[local preparation](../output/oauth-review/owner-local-smoke.json),
[owner save](../output/oauth-review/owner-sync-smoke.json),
[warm reuse](../output/oauth-review/owner-warm-smoke.json).

Actual Google/Firebase/backend sign-in and this one live owner/private-R2 pair
save are now confirmed. Email sign-in, refresh/link/logout/deletion recovery,
signed-in visual inspection, owner downloads, mobile Library appearance,
authenticated WebSocket snapshots and real cloud quota/processing remain
unverified. This synthetic fixture does not establish listening quality or real
YouTube source matching.

Final operator readback reconfirmed API 105/`img-captain-api:105`, one instance,
no build in progress and `websocketSupport: true`. The fixed Desktop client pair
is configured and matches the installed public client ID; installed config has
exactly four public keys and no secret. Only one MusicMute app is visible. Five
owned temporary credential/configuration snapshots and their private staging
directory were removed after rollback staging was no longer required; generated
Desktop-secret scratch no longer remains. No identity, job ID, credential value
or staging path is published in this ledger.

Current retained vocals MP3 occupancy is **44,319,869 bytes across 12 files**,
within the shared decimal 1 GB budget. This is bounded current occupancy,
not live eviction-pressure, sustained disk/memory or long-duration proof;
eviction-pressure validation remains fixture-only.
The new Chrome bundle is installed on disk, but its Reload/new-version
end-to-end acceptance is pending; prior-build Chrome panel checks do not satisfy
it. Native cancellation/buffering corrections are now installed in 86ee4723;
remaining account/media acceptance remains open. Full Android parity and explicit Cloud
selection in Chrome are follow-ups, not completed by the presence of native
controls.

## Installed cache and title checkpoint — 2026-10-03

Final source verification passed `npm run verify`: 929 tests in 40 files,
whole-component type checking, 109-file zero-warning lint, build and formatting.
Both native Swift 6 suites passed after the title and asynchronous Keychain-read
changes. Strict Swift formatting and EN/AR strings validation passed.

The canonical `/Applications/MusicMute Local.app` is now build `afcd570c`,
1,117,038,995 bytes with 303 ARM64 native files. Installation preserved the
previous app in the hidden `.noindex` backup directory. Only one MusicMute app
is visible; signing remains local ad hoc, without notarization.

Final read-only installation audit matched all 11,326 package file/symlink
entries, all companion/extension dist files, the native executable and EN/AR
resources. Deep strict signature verification passed. Public configuration
contains only the four allowed keys; no values were printed.

[Installed cache report](../output/native-cache-proof/0fb7ffec-5899-4c4d-877c-be7319f6baaf/result.json)
passed 29 checks. Two fresh installed hosts replayed a copied, previously
qualified MP3, served exact 1,024-byte HTTP 206 ranges, refused missing
capabilities with HTTP 403, recorded current cache timings without historical
inference timings, removed scratch and exited without orphaned process groups.
The installed native Library command retained an English/Arabic title fixture
after host restart. It is a metadata/protocol check, not visual or listening proof.

The isolated sparse pressure fixture started at 1,020,382,842 logical bytes and
evicted the oldest unpinned entry to reach 990,382,840 bytes. Active pins were
preserved; an all-pinned cache refused admission with `OFFLINE_CACHE_FULL`,
a pinned damaged manifest refused replacement with `CACHE_UNSAFE`, and cache
clearing preserved pins before removing only unpinned fixture entries. All seven
host process groups exited cleanly; network and tool attempts were zero.
Sparse entries prove accounting, protection and eviction, not playable audio,
physical disk exhaustion or sustained resource use. This qualification did not
modify the real user's audio cache.

The final manifest is now serialized with its destination audio path before
admission. Exact-fit and one-byte-short pinned unit cases prove that a rejected
publication cannot leave newly copied vocals above the budget.

Titles now survive acquisition, native results, manifests, catalog/outbox save
and warm replay without another lookup, audio download or inference. Optional
malformed titles are discarded independently of valid audio; recipe-8 keys remain
unchanged. Account custom names take priority, then source titles, then retained
local titles. The Library merge preserves playback/save metadata and avoids
duplicate rows. Two known historical owner entries were repaired using their
exact video IDs and YouTube's public metadata, through the validated catalog API;
audio hashes, sizes, cache/job/operation identity and files were preserved.
Unknown historical titles are not invented or automatically reprocessed.
The two historical repairs changed local catalog metadata only; existing server
job metadata was not rewritten. Future local saves retain the acquired title.

Resident account reuse and one bounded native-authorized cache restore are now
implemented before inference. Tickets contain only owner/generation, video/job
identity, state and deadlines; authorization stays in the native app. Restores
have a fixed five-second foreground deadline, cancellation/account fences and
cleanup of unadopted downloads. Missing, slow or offline account reads may fall back once
to explicitly selected local processing, with no automatic cloud compute job.
The native restore watcher and capture watcher share a bounded event-driven
continuation. Live Chrome restoration after Reload still needs acceptance.

Actual startup profiling found the old UI thread waiting in
`SecItemCopyMatching`. Keychain reads now run off the UI actor; delayed, stale,
cancelled and duplicate restoration fixtures pass. Save/remove access controls
remain unchanged. The updated app's Settings navigation was observed working
while the macOS authorization wait remained pending, with a localized restoration
message. [Actual waiting view](../output/oauth-review/native-keychain-wait.png).
At that checkpoint, human Keychain approval was required before the signed-in
Library visual check; the automation tool rejected access to SecurityAgent for safety.
Later native computer-use observations failed because their connection closed,
including after a supported session reset. This is an additional verification
blocker, not evidence of an app crash; the app inventory still listed MusicMute
as running. No alternate UI automation or Keychain bypass was attempted.

Google Auth Platform saved the app name **MusicMute**, the public homepage/privacy
links and the existing product's authorized domain. Its automatic branding check
reported that the homepage is behind login and domain ownership is unverified.
The sign-in display name is therefore not confirmed changed for users yet.
The console requests a public product homepage and verified domain ownership
before retrying; its ownership guidance specifies a 24-hour propagation wait.
[Saved branding evidence](../output/oauth-review/google-branding-saved.png).
No OAuth scopes, client redirects, credentials or production processing
configuration were changed by this branding action.

## Cache lifecycle follow-up — 2026-10-03

The token-free accepted-account marker subsequently confirmed successful native
account restoration. A bounded sample of the canonical app found the main thread
idle in the normal AppKit event loop, without the previous Keychain wait. Native
computer-use still failed to connect; this prevents the final native Library
visual check, but is not evidence of an app crash or a remaining authentication wait.

Actual Chrome replay of a saved public YouTube track reached vocals-ready with
one recorded cache hit, one ready event and no engine work. Current lookup,
validation and grant timings were 0.720 ms, 3.868 ms and 0.452 ms. The video ran
with original audio muted; Pause and Stop left it paused with original mute
restored. Hiding and reopening the controls preserved the active playback state.
[Actual playback controls](../output/browser-cache-proof-1790978682541.noindex/chrome-panel-visible.png).
These observations are not listening-quality, source-track or measured lip-sync proof.

The existing installed `afcd570c` passed a new
[32-check isolated baseline](../output/native-cache-proof/e9542ec7-15c4-4f89-a557-9e5f282b16c5/result.json):
ten same-host replay/cancel cycles issued fresh grants and revoked old grants,
with 17 file handles at both the first and tenth observation. RSS increased from
80,144 to 86,864 KiB; this short observation does not prove leak absence. The
guard denies acquisition, inference and external network work, allowing only
strictly bounded read-only OS process-birth queries for fixture-owned processes.
This baseline predates the new cross-process Chrome pins and crash workspace recovery.

The storage review found and fixed pre-ticket crash scratch ownership and Chrome
grant pins in source, including Stop releasing READY grants after offscreen audio
stops. Focused fixtures include actual owned SIGKILL recovery and cross-process
cache clearing. The full TypeScript checkpoint passed 971 tests in 42 files,
typecheck, 113-file lint, build and formatting. Native Library pin/recency and
retained-manifest title recovery are subsequent changes awaiting their own final
checks and a replacement installed bundle; the 971-test checkpoint is not their proof.

## Current installed lifecycle/title qualification — 2026-10-03

The replacement build `82bd3515-ef9c-498c-ac96-32df88b76258` is installed at the
canonical Applications path; the previous bundle is preserved in the hidden
rollback directory. It contains 303 ARM64 native binaries and 1,117,157,967 bytes,
uses local ad hoc signing and is not notarized. All 11,326 file/link entries,
six companion dist files and ten extension dist files match the package/source.
Deep strict signing passed. Only one MusicMute app is visible in Applications;
public configuration still has only the four allowlisted keys.

Final source validation passed `npm run verify`: **985 tests in 42 files**,
TypeScript checks, zero-warning lint, build and component formatting. Both native
suites, production Swift 6 typecheck with warnings as errors and strict Swift
formatting passed. The final installed harness additions also passed syntax,
scoped lint and formatting checks.

[Installed 36-check report](../output/native-cache-proof/3574d707-c64c-4901-96d2-e1b330ff7015/result.json)
matches installed host SHA-256
`8c1273245f14612c846af806d420375ac3ea21fa030f558d939707d64095dd37`.
It proves two fresh-host warm replays, exact Range bytes and capability refusal,
EOF pin release, ten same-host START/CANCEL cycles with pin release, and the
previous decimal 1 GB/pinned-corrupt/refusal/clear matrix. Handles remained at
17; RSS was 80,368 then 86,512 KiB. These are short observations, not leak proof.

A separate installed eviction component preserved the active Chrome host's
copied vocals under cache clearing. That isolated eviction fixture intentionally
skips Chrome's exclusive single-host launcher: it proves cross-process disk-pin
protection, not concurrent Chrome-host installation or real browser playback.
There were no forbidden acquisition, inference or external network operations.
Read-only process-birth queries were bounded and restricted to fixture-owned PIDs.
The logical sparse pressure fixture fell from 1,020,382,842 to 990,382,840 bytes;
it did not change the real user's cache or physically exhaust the disk.

The installed native Library command also recovered and persisted a missing
legacy catalog title from the exact verified retained manifest. It preserved
timestamps/order, changed the catalog revision and performed no download or
inference. Source tests additionally cover custom names, malformed optional
titles, cursor invalidation and wrong hash/path/video/owner rejection. Missing
titles cannot be recovered if both the catalog and retained manifest lack them;
no same-video cross-job guessing or automatic network enrichment is introduced.

Native Library Play now validates and publishes its playback pin and touches
LRU recency under the same mutation lease used by eviction. File/hash/owner
checks run off the UI actor; busy waits are bounded and cancellable. Stop,
logout and successor playback fence late work. Native fixtures cover both race
orders, private linked/foreign/corrupt storage and malformed account fields.
Chrome Stop now sends existing native CANCEL after offscreen audio is silent;
hiding the panel does not cancel processing or playback.

Native computer-use recovered after replacement. Actual Home, guest Library,
Settings and Diagnostics navigation worked. A local diagnostics export completed;
its 564,341-byte private JSON passed a sensitive-field scan. Retained historical
alerts remain visible, with no claim that they are new errors in this build.
[Actual export view](../output/browser-cache-proof-1790978682541.noindex/updated-app-diagnostics-export.png).
The fresh build is waiting inside off-main `SecItemCopyMatching` while the UI
remains responsive. At this checkpoint human saved-sign-in authorization and
Chrome Reload were requested. The later owner replay checkpoint records actual
session restoration and native title/playback acceptance; updated browser Stop
acceptance remains open.

## Installed native guest playback checkpoint — 2026-10-03

The actual canonical `82bd3515` app completed Home → local audio file → player
→ Stop → Library → Play → Stop using the existing owned three-second synthetic
WAV. Home reported “Playing your saved voice without processing again”; Library
rendered `synthetic` and the native player advanced through its three-second
timeline. These were computer-use actions in the real app, with no fixture UI
replacement or Keychain credential read.

[Private five-check proof](../output/native-guest-cache-proof/ae3e6a24-1a93-4e20-bc0f-4f92c3016e26/result.json)
matches the current installed host hash. The matching Home job recorded one
cache hit, no engine events and 16.572 ms to native readiness. This is a preparation
timing, not measured input-to-speaker latency. A read-only observer confirmed the
native playback pin existed and was released by Stop. Direct Library replay
advanced cache recency by approximately 105.2 seconds without another preparation
job or engine event; final Stop again released the pin. Retained vocals remained
61,170 bytes, no job scratch or ownership markers remained, and the selected
264,678-byte WAV retained its exact checksum. The prior short handoff pin was
expired and inactive. The observer began after Home reached READY, so its own
sampling does not independently cover that first job's entire execution.

[Actual Home view](../output/browser-cache-proof-1790978682541.noindex/native-guest-warm-home.png)
and [actual Library replay](../output/browser-cache-proof-1790978682541.noindex/native-guest-library-replay.png)
provide visual evidence for this installed guest workflow. These checks extend
the earlier isolated 36-check report; that earlier report's native visual flag
remains false within its own scope. They do not establish signed-in owner saving,
current owner Library titles, updated Chrome Stop behavior, listening quality or
long-run resource stability. Saved-account access recovered after this guest
checkpoint; see the later owner replay evidence. Chrome Reload remains required
for updated browser acceptance.

## Existing guest YouTube title repair — 2026-10-03

Actual Library inspection found three older guest URL records whose catalog and
retained manifest both lacked titles. Their exact validated video IDs were
`Xrwy4bNg9Ho`, `zdU3GxQfLaI` and `KWWBNyA_Wxk`. Official YouTube oEmbed returned
their public titles through bounded requests with no cookies, credentials or
redirects. A private metadata-only backup preceded repair. The existing catalog
validation, shared mutation lease and atomic writer were used with an additional
guard allowing only these three source titles and catalog revision to change.
The guard preserved every other field, row order and timestamps and rejected
unrelated changes before publication. Before/after full hashes, sizes, inodes,
permissions and retained manifest bytes were unchanged for 14,983,445 audio bytes.
No audio was downloaded or processed, and no server job was changed.

[Private metadata repair proof](../output/metadata-repair.noindex/legacy-guest-20261003/proof.json)
records the invariants; its adjacent private backup contains only catalog
metadata. Ordinary Home cached playback refreshed the real app's Library, which
then visibly showed all three repaired YouTube titles.
[Actual corrected Library](../output/browser-cache-proof-1790978682541.noindex/native-library-titles-repaired.png).
This is a deliberate repair of three exact legacy guest entries, not automatic
network enrichment or new authenticated owner acceptance. Future results retain
titles in the normal processing path. Unknown legacy entries still require
verified metadata rather than guesses from durations or another track.

## Actual signed-in native title and cache replay — 2026-10-03

Saved account access recovered in the actual canonical `82bd3515` app. Its
Library showed “Account library connected” and the local YouTube item
`lrRjmR5F8kk` as `تاعب روحي | سمسم شهاب | اغاني شعبي | فيلم الالماني`, replacing
the reported generic “Saved voice” display. Play used those retained vocals;
the native clock was observed at 1:32 and subsequently at the end of the
4:08 timeline. The player and Library retained the correct title.

[Private eight-check report](../output/native-owner-replay-proof/93989114-3716-463d-b753-440decf9a72c/result.json)
passed for this actual installed owner replay. Native disk pins moved from
zero to one on Play and back to zero on Stop. Recency advanced after the
baseline; the private 4,974,280-byte vocal file still matched its retained
manifest checksum. No new desktop preparation job, READY event, engine event,
scratch or workspace marker was observed in the replay interval. The known
selected synthetic WAV also retained its exact bytes. There is no original
source for this legacy YouTube cache entry to compare; no original-byte claim
or new account upload is inferred from this replay.

[Actual owner Library and player](../output/browser-cache-proof-1790978682541.noindex/native-owner-title-playback.png)
is the visual title proof. This closes the reported installed owner title and
cached native playback case, with no token or Keychain content read. It does
not establish listening quality, source audio-track identity or mobile sync.

## Actual Chrome account transition and Stop finding — 2026-10-03

The existing Chrome extension reached READY for the exact cached YouTube item
`yeGzdru1l4w`; the canonical installed host recorded a 64.128 ms cache-hit
preparation with no engine event for that matching job. This is readiness
timing, not input-to-speaker latency. During an earlier paused guest replay,
account restoration revoked the native grant but left Chrome showing an active
muted session. The host account invalidation callback silently called
`jobs.close()` instead of publishing a terminal cancellation. The new source
fix uses the existing CANCELLED snapshot and fences admission and cancellation
races; Chrome must acknowledge offscreen silence before restoring original audio.

An actual GUI Stop restored the original video's unmuted paused state, but the
currently loaded Chrome version left its disk pin present. The
[private Chrome report](../output/chrome-warm-pin-proof/67ba4390-56e6-4558-93cf-9e116f14823b/result.json)
therefore remains **failed** for Stop pin release. The native owner replay's
successful Stop is a separate result. Updated source behavior must still be
installed and reloaded before this Chrome acceptance can be closed.

An earlier near-end playback navigated through YouTube autoplay to a successor.
It was cancelled before READY, with owned child exit and scratch cleanup
confirmed. Resource events reached the engine startup path, so that successor
is not described as a zero-engine replay. No successful inference or listening
claim is made for it. The original tab was returned to the exact cached video
and left paused with MusicMute stopped and its original mute restored.

## Installed account cancellation update — 2026-10-03

The account invalidation fix is implemented in `host.ts` and `jobs.ts` without
a new wire status or endpoint. The observer aborts a captured lookup and calls
single-flight cancellation with a fixed redacted account reason. START and cache
clearing stay fenced while cancellation drains; admission checks its AbortSignal
before publishing a successor or invoking processing. Captured task/controller
references, stale callback rejection and close joining cancellation prevent late
work from revoking a successor. Actual bundled-host fixtures cover READY guest
to owner, owner-generation and unsafe-state changes, unchanged publication,
in-progress cancellation and revoked capabilities/pins. Job fixtures also cover
delayed preflight/revoke, duplicate cancellation and shutdown races.

Chrome `background.ts` consumes a matching CANCELLED snapshot before sending
ordinary page progress. It retires that session through existing Stop, awaits
offscreen audio silence, then restores the original video's mute. It sends no
recursive native cancellation; duplicate snapshots and stale callbacks cannot
stop a successor. Five new cases cover playing/paused, manual/automatic sessions,
withheld audio acknowledgement and same-tab replacement. Fifteen companion/host
cases cover the cancellation/admission races.

`npm run verify` passed **1,005 tests in 42 files**, typecheck, 113-file
zero-warning lint, build and formatting. The focused companion/account run
passed 128 tests in three files; the focused background/offscreen/content run
passed 191 tests in four files. Native source was unchanged from its previously
passing suites; the production package compiled it using Swift 6 warnings as
errors. Packaging and `npm run install:macos -- --applications-dir /Applications`
passed.

Canonical build `05a05b5c-a3e8-40c4-8415-139496a22caf` contains 303 ARM64 native
binaries and 1,117,161,673 inventoried bytes. It is ad hoc signed, not notarized.
[Package alignment proof](../output/package-alignment-proof/6fdbe793-177a-4dff-b1e8-c27a0d6b95d4/result.json)
compares every installed/package file and link, all 11,326 entries, plus six
companion and ten extension dist files. Public configuration has only its four
allowlisted keys; one MusicMute app is visible in Applications. Deep strict
code signing passed. The prior app is preserved in the hidden rollback folder;
no new visible copy was created. The stopped native app quit normally and its
previous canonical host/guardian also exited; the attempted guarded SIGTERM
was not sent because that host had already exited.

[Current installed 36-check report](../output/native-cache-proof/3c9bd4ab-56e6-4eae-977d-1b9dd5c71255/result.json)
matches host SHA-256
`b9ca523c6570537cd9ba05e578e2c98e06c2bc5044acf28044fe33cb0ca4b2e6`.
It passes warm playback, exact 1,024-byte Range/403 refusal, EOF pin release,
ten same-host CANCEL cycles, independent eviction pin protection, title recovery
and decimal 1 GB LRU/refusal/clear behavior, with zero forbidden tool or network
attempts. Sparse bytes fell from 1,020,382,842 to 990,382,840. File descriptors
stayed 17; RSS rose from 80,432 to 87,344 KiB across the short fixture run,
which is an observation rather than leak proof. All fixture hosts exited normally;
scratch was empty. Its isolated HOME bypasses readiness/acquisition/inference
and does not establish actual browser, owner-upload or listening acceptance.

Reconnecting native computer use after the update returned a closed native pipe
three times, including after resetting the computer-use JS session. No alternate
UI/credential automation was attempted. The prior actual owner title/playback
proof remains valid for `82bd3515`; it is not relabelled as newest-build visual
proof. Chrome's extension-management automation restriction still requires a
manual Reload. A pending user request asks for Reload and reopening the canonical
app before the remaining live checks. The previously failed real Chrome Stop
report remains failed until the updated loaded version passes that actual check.

## Configurable offline storage (2026-10-04)

Settings → Storage saves a whole decimal-GB budget (minimum 1 GB, default 2 GB).
The app, Home notice and Library usage display the effective budget. The private
versioned `cache/offline-settings.json` setting is saved atomically while holding
the existing cache mutation lease. Cache admission reads it for every mutation,
including in already-running extension helpers. Explicit tiny fixture budgets
remain available to tests. Runtime, models, originals and active scratch remain
outside the offline vocals budget.

The additive local IPC command `SET_CACHE_BUDGET` takes exactly
`{ "budget_bytes": <integer bytes> }` and returns
`{ "cache_bytes": <integer bytes>, "budget_bytes": <integer bytes> }`. Budgets
are whole multiples of 1,000,000,000 and remain within JavaScript safe integer
precision (maximum 9,007,199 GB). Saving a lower limit does not evict existing
voices. The next admission retains the existing LRU, playback pins, pending-save
pins, safe-path checks and disk-reserve checks. `LIBRARY_CACHE` and `CLEAR_CACHE`
report the saved budget instead of a fixed 1 GB.

Local IPC validation follows the portable integer-format, JSON naming and
compatibility guidance in the [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/),
retrieved on 2026-10-04 (rules 171, 118 and 106). REST-specific URL, HTTP status
and OpenAPI endpoint rules do not apply to this existing native IPC transport.
Historical installed 1 GB qualification retains its original scope; the
new setting still requires a new installed app before user-facing acceptance.
