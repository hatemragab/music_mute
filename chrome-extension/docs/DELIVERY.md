# macOS app and Chrome extension delivery

Started 2026-10-02. The requested outcome is an installed, self-contained Apple
Silicon companion and Chrome extension, with MusicMute Android styling, local
diagnostics, and actual YouTube playback evidence. Windows offline and online
MusicMute remain later providers. Publication is not part of this local delivery.

## Current c14116b8 package/install delivery checkpoint — 2026-10-05

Build `c14116b8-cf2c-4865-8a24-f9f1dce2a119` / `1791212763` is the current
candidate package/install: a 17,663,025-byte ARM64 ad-hoc app whose 139 package/
installed leaves, build identity and architecture matched, with deep strict
signature verification passing. External inventory SHA-256 is
`3e5d49e98f7147ac049224d36a1227b3ad46cb48f08711ff2f79f8762e00a276`;
the embedded `bundle-audit.json` file SHA-256 is
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`.
The exact 58d runtime and model were reused, for a 1,381,918,937-byte base
one-app/one-runtime/one-model footprint.

The package result is
`output/macos/build-c14116b8-cf2c-4865-8a24-f9f1dce2a119.noindex/package-result.json`.
The disposable package-only proof at
`output/packaged-tools-proof/e9fb0a01-33a0-44b9-b18a-391fe2130002.noindex/result.json`
passed all 15 offline checks without opening the installed GUI/browser or using
a real profile, account, Keychain helper, network transfer, model download or
inference. Installed full runtime verification created the private mode-0400
authenticated receipt. Later processes may use it only after outer-app
validation and two identical metadata passes; any missing, invalid or mismatched
receipt falls back to full verification. This was an ordinary compatible update,
not a clean reset or fresh Prepare.

Chrome Secure Preferences confirmed final unpacked `dist` under extension ID
`dclpfemnpknfdlpcbfcjkmdbnociippd`; its recorded reload preceded the c141 app
install. A post-install real Stromae YouTube refresh then reached visible
**MusicMute · On this Mac** and **Voice-only playback**. The c141 companion
identity matched `0.1.0` and package inventory
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`; logs recorded
`cache_hit=true`, 66.157 ms to ready and `playback_started`. This is a warm-cache
local playback start, not fresh acquisition/downloader/MPS separation, physical
listening, selected-source/lip-sync, sustained playback or the controls/restart
matrix. It adds no runtime-network, fresh-user, account/R2, notarization,
public-release or Web Store proof.

## Historical 58d55f40 clean-reset delivery checkpoint — 2026-10-05

Build `58d55f40-6789-42fb-9e02-5f3e43f5cc3f` / `1791171228` was the then-canonical
package/install: 17,547,290-byte ARM64 ad-hoc app, all 139 package/
installed leaves matched with no byte/link differences, and deep strict signing
passed. Installation normalized only GID and left no group/world-writable bundle
node. External inventory SHA-256 is
`2fda53d1b4216db660fc11777e817527b282cfd25439423a8a7de48dc4a91a03`;
embedded bundle-audit identity is
`9606d131c65fe59910dd77e5c82f6eac1b5dc09e465878fe0e45eecfb5f755b5`.
The reused runtime is `macos-arm64-v1-c923b1be1f135d8c48ef81c9`:
410,586,280 archive bytes with SHA-256
`9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`,
1,297,496,698 installed bytes and 18,031 leaves. With the 66,759,214-byte model
(SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`),
the total base footprint is 1,381,803,202 bytes. The package record is
`output/macos/build-58d55f40-6789-42fb-9e02-5f3e43f5cc3f.noindex/package-result.json`;
the 15-check packaged proof is
`output/packaged-tools-proof/5d721f3c-235d-4577-9da2-33c35c756e3a.noindex/result.json`.

The final clean reset first isolated old app/data at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-063747-final-58d55f40`.
After proof, it was permanently purged and is absent/unrecoverable; earlier
`053140` and `055936` reset archives are absent too. Auth/guest Keychain entries
were absent. The empty installer backup directory and old auxiliary paths are
absent; at completion the installed app was build `1791171228`.
Prepare consumed only an exact mode-0600 preseeded runtime partial, validated the
runtime in 19,736.927 ms, downloaded/verified the model in 13,417.891 ms, passed
six checks and reached **Mac ready**. Native synthetic processing reached **Voice
ready** in 58,356 ms, autoplayed to 3.017 seconds, saved a 62 KB offline Library
entry, then persisted it across Quit/relaunch and loaded replay with **Pause** at
0:00. Signed-out Library omitted connected copy.

Existing unpacked Chrome ID `dclpfemnpknfdlpcbfcjkmdbnociippd` remained loaded
from repository `dist`, whose core files matched the installed package. The
registered manifest/launcher were exact, the direct installed bridge returned
local mode, and a registered-origin native HELLO returned ready/darwin/arm64,
v0.1.0, 1,200 seconds and `LOCAL_MACOS` with `processing_selection_v1`
negotiated. The host exited and GUI stayed closed. This is protocol and on-disk
alignment proof, not a final popup observation.

Final audit also corrected a readiness gap in superseded build `2ed7711e`: socket
ready could precede the first Library jobs snapshot. Build `58d55f40` accepts only
a valid snapshot for the current account and stream, resets/fences stale
connections, preserves same-stream pagination readiness, and makes Home/Library
connected copy wait for that state. Native regressions cover wrong account/
stream, reconnect, pagination, teardown and malformed snapshots.

Limits remain explicit: existing development Mac; no runtime-network path, fresh
OS user/machine, real YouTube/listening/lip-sync, signed-in account/cloud Library/
R2, cloud processing, long run, notarization/public release or Web Store proof.
The app is ad hoc, unnotarized, updater-unconfigured, `public_ready=false` and
`relocated_runtime_tested=false`. The future Downloads and Google Play
destinations were unavailable when checked and remain discovery-only.

## Superseded 2ed7711e local delivery checkpoint — 2026-10-05

Build `2ed7711e-7cd6-4b37-992f-c6fb02782812` / `1791168902` retains its dated
package, clean Prepare, synthetic native and preserved-profile Chrome evidence.
It is historical rather than source-final because it predates the account/stream
first-jobs-snapshot readiness fence described above. Its `055936` reset archive
was permanently purged and is unrecoverable.

## Interim e2aa local delivery checkpoint — 2026-10-05

This run superseded the 679/cb artifact checkpoints below, but later source audits
found additional code gaps. Historical 2ed corrected the Google-mark and
account-online-copy gaps; final 58d corrected snapshot readiness and replaced both.
Preserve e2aa only as the following dated evidence:

| Scope                      | Final evidence                                                                                                                                                                                                                                                                                                                                                                  | Boundary                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Package                    | Build ID `e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6`, `CFBundleVersion` `1791167264`; 17,524,330-byte ARM64 app; strict package/installed tree and deep signature match                                                                                                                                                                                                              | Ad hoc signed; `notarized=false`, `public_ready=false`, `relocated_runtime_tested=false`; updater unconfigured |
| Runtime                    | `macos-arm64-v1-c923b1be1f135d8c48ef81c9`; 410,586,280-byte archive SHA-256 `9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`; 1,297,496,698 installed bytes/18,031 entries                                                                                                                                                                                    | Exact archive was preseeded mode 0600 as the expected `.partial`; no URL/DNS/TLS/CDN/range proof               |
| Footprint/inventory        | 1,381,780,242-byte one-app/one-runtime/one-model base; external `final_inventory_sha256` `b182774d45d2cb24b5d6c529e596b2a2160d9403a2a1bfd2553c62f19f77b4d7`; bundle-audit `package_inventory_sha256` `a0f4091d4d96e9bc734287ae1ede7ddb422ee5b776844c8dc335610e04fc9e53`                                                                                                         | `du -sk` may show 1,309,552 KiB for the runtime because allocated storage and declared byte sums differ        |
| Packaged tools             | `output/packaged-tools-proof/25f5be61-a442-436b-bc26-b1c987c7f24b.noindex/result.json` passed all 15 disposable offline checks                                                                                                                                                                                                                                                  | No installed GUI/browser/account/Keychain/model download/inference in this proof                               |
| Clean app data and Prepare | Prior app/support/manifest/preferences/backups initially isolated at `/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-053140-final-e2aa`; auth/guest Keychain items absent with delete status 44; exact app installed; support absent before Prepare; model downloaded/verified; six checks and **Ready** / **Mac ready** passed; reset archive later permanently purged | Existing development Mac, not a fresh OS user/machine, quarantine or Gatekeeper test                           |
| Native UI                  | Signed-out Home showed Google/email/product discovery without stale media error; exact 264,678-byte synthetic WAV reached **Voice ready**, 3.017 s playback and 3.0 s **Saved offline** / 62 KB Library; Quit/relaunch retained it and replay advanced 0.250–3.017 s                                                                                                            | Synthetic only; no listening, real source identity, long-duration, account, cloud Library or R2 proof          |
| Chrome                     | Existing unpacked ID `dclpfemnpknfdlpcbfcjkmdbnociippd` reloaded; popup showed **Up to 20 min**, **Your Mac is ready**, **Ready · processing stays on this Mac**; mode **On this Mac — Apple Silicon**; settings bridge returned local; GUI-closed **Check again** launched host and returned Ready                                                                             | Preserved profile; eight saved errors are 2026-10-04 history; no fresh YouTube or Web Store proof              |

Post-Prepare permissions/readback were private and exact: support, runtime and
downloads directories mode 0700; downloads empty; `active.json` mode 0400 with
the exact runtime/archive; launcher mode 0700; native manifest mode 0600; installed
app still strict-signed and ARM64. The downloaded 66,759,214-byte model matched
SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
See the [validation ledger](validation.md#interim-e2aa-package-reset-prepare-and-ui-checkpoint--2026-10-05)
for the complete evidence split.

## Historical 2026-10-02 delivery checkpoint

Everything below this heading retains its original dated scope. Uses of
“current” in this historical section mean current at that 2026-10-02 checkpoint;
c14116b8 above is the latest package/install evidence, while 58d55f40 remains the
historical clean-reset/Prepare/UI evidence and 2ed/e2aa are older history. Source, generated package, installed
execution and real playback remain separate. That source passed 448 tests in 21
files, typecheck, 67-file zero-warning lint, build and Prettier, with 88 source
pins saved in `source-verify.json`. Generated build
`67960e3f` contains 1,113,057,345 bytes and 303 ARM64 native files. Its same-path
canonical installation passes 21 source/package/installed alignment checks and
strict signatures; inventory prefix is `1a3f1f61a192`. Reopened Overview shows Mac
ready. It remains ad hoc signed and not notarized. Strict Swift 6
source/native checks and production compilation pass. Recipe 8 preserves optional
upstream track evidence and invalidates recipe 7 and older cache reuse without
deleting files. Prior installed build `cb26daf3` was aligned at
`/Applications/MusicMute Local.app`, with all 21 source/package/installed checks
and strict signatures passing. Its Overview shows Mac ready. Earlier build
`cb7dec7c` supplied native acquisition/MPS/Range in 19.021s, 15 cache checks,
47 fault checks in 4.694s and 15 focused UI/export checks. Those reports retain
their earlier build/execution scope; they are not new-build live acceptance.

The canonical app is the sole Spotlight app-search result. Former home-directory
apps were preserved by moves into owned `retired-apps.noindex`; the generated
package was moved to `output/macos/build-cb7dec7c-5edf-48cd-91ad-4cf275b599e5.noindex/`.
The then-current generated package was
`output/macos/build-67960e3f-97ec-44bf-a29b-662357b28677.noindex/`.
The prior `cb26daf3` package remains at
`output/macos/build-cb26daf3-9230-4fa3-8afa-35c0dfb0c28b.noindex/`.
The previous canonical app is preserved privately under `/Applications/.musicmute-backups.noindex/`.
Model, cache and logs were preserved. Future installer
backups use `.musicmute-backups.noindex`; new package folders end `.noindex`.
The user has manually loaded the canonical app's extension into regular Chrome.
Loading is resolved. On 2026-10-02, actual YouTube showed the icon, preparation
and voice-only panels; two cold sources of 226.621s/219.521s prepared in
23.270s/22.229s, with four initial READY jobs including cache hits. Initial
telemetry reported 31 clock-drift samples of 2–112ms; bounded history is incomplete
and this is not physical audiovisual latency. Long-pause/retry exposed
`AUDIO_CONTEXT_LOST`: safe pause/mute restoration, but retry recovery failed.
One generic `UNCAUGHT_ERROR` occurred during navigation. The bounded recovery
fix is source-verified and installed. It joins pending reload work, forwards the
latest owned clock and permits one bounded reload after a transport failure.
Safe fixed browser context/generation now survives diagnostic export. The user
completed the `cb26daf3` Reload. Actual HTTPS cached playback of a 219.521-second
source then showed Play with original muted, Pause at 82.98s, Home to 0s,
ArrowRight to 5s, 1.5× resume and Stop after restoring 1× with original unmuted.
This is partial prior-build control evidence; it does not measure >30-second
offscreen closure, a restart matrix, physical listening or source-track matching.
The saved latest bounded native history is not correlated to that UI cycle.

The new 304px top-right panel separates visibility from processing: active
waveform/close/Escape hide or reopen controls without changing job ownership,
generation, mute or clocks. Progress/READY/playback preserve dismissal; explicit
Cancel/Stop remain separate. Pointer/arrow-key movement is clamped, Home resets
the anchor, and resize/remount/invalidation dispose or refresh movement safely.
Synchronous and rejected context-invalidated messaging is contained; retired
content scripts restore audio, release loops/listeners and show Refresh YouTube.
An ordinary HTTP fixture with compiled content.js/CSS and fake Chrome runtime
observed hide/progress/READY/playback/reopen, keyboard movement, 430px/320px resize
and icon centering. It loaded no extension and played no replacement audio.
Pointer UI attempts missed the handle; only unit tests establish drag behavior.
The user completed the new Reload and ordinary YouTube refresh. New `67960e3f`
actual cached playback continued with controls hidden at 142.796858s and
176.52433s, then was paused and reopened at 176.588492s with active ownership and
original mute retained. ArrowLeft/ShiftDown moved within the player; Escape hid
the panel and focused the waveform without stopping playback; Home restored the
12px top-right anchor. The actual panel measured 304×127.70px and icon centering
offsets were zero. `real-youtube-panel-cases.json` and
`real-youtube-compact-controls.jpg` record this narrow live UI scope.
Actual Chrome context revocation during playback showed a disabled icon and
Refresh YouTube notice, with the video paused and original audio unmuted. Ordinary
HTTPS refresh/retry resumed cached Voice-only playback at 93.725681s; final
Pause/Stop at 135.563223s left the video paused, unmuted and waveform unpressed.
`real-youtube-reload-notice.jpg` and the updated cases record this narrow safety/
reconnect cycle, not a complete browser restart/offscreen/sleep matrix.
The final bounded console report contains 491 older records and zero
errors/warnings after the installation cutoff; the earlier 497-record snapshot
is superseded, and neither is an entire-profile/history-clear claim.
The new bounded host summary has 117 rows and four cache READY observations
across two hosts, matching inventory `1a3f1f61a192`; its empty code counts are not
correlated to one UI cycle. Successful native pointer dragging, physical
listening, source-track matching and the full playback/restart matrix remain open.

The older ignored `output/` records disappeared during this session. All 46
historical JSON/PNG paths in the previous validation ledger are currently absent.
Earlier engine, installed UI, recovery and Chrome fixture results are therefore
historical narrative with unavailable artifacts, not current acceptance. New
source/package/browser artifacts and the remaining gates are in
[validation.md](validation.md).

| ID  | Task and acceptance                                     | State                                          | Current evidence and remaining work                                                                                                                                                                            |
| --- | ------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | Setup/app/diagnostic contract; native v1 compatibility  | Verified source                                | Bounded typed protocol/Swift decoding, recorder identity and combined 64 KiB reply; native v1 retained                                                                                                         |
| D02 | App-owned Node/Python/FFmpeg/MPS engine                 | Installed; prior native run verified           | Updated package reuses verified previous runtime read-only; prior cb7 native acquisition/MPS/Range passes; no new-build native/live claim                                                                      |
| D03 | Owner-hosted verified bounded model setup               | Verified source; historical installed evidence | Exact 66,759,214-byte SHA-256 pin and source fault tests; earlier first download/recovery artifacts unavailable                                                                                                |
| D04 | Stable extension ID and safe per-user registration      | Manual load/reloads and refresh completed      | Historical initial load, cb26 Reload and 679 Reload/YouTube refresh; matching aria-controls/expanded and panel observed; same-path registration preserved                                                      |
| D05 | Android-inspired SwiftUI setup/ready experience         | Partial installed UI acceptance                | Historical 679 reopened Overview Mac ready; prior cb26/cb7 Setup/Diagnostics/UI checks retain scope; full replacement-build UI/accessibility acceptance separate                                               |
| D06 | Android-inspired popup/player controls                  | Narrow new-build actual YouTube UI verified    | Live 304×127.70px panel: hidden continuing playback/reopen, keyboard movement, Escape/Home, icon offsets zero; fake-runtime clocks/resize/explicit Stop; pointer unit-only; popup/full matrix separate         |
| D07 | Local diagnostic viewer/export                          | Partial updated installed UI acceptance        | Updated Diagnostics shows recorder 2d118fd17397/expected model ce74 and retained historical errors; prior cb7 export checks retain scope; no new-build full-export/live claim                                  |
| D08 | Audited app installed in standard Applications          | Updated; aligned locally                       | Canonical `/Applications/MusicMute Local.app`; 67960e3f 1,113,057,345 bytes/303 ARM64 files; 21 hash alignment/strict signature checks; private backup/sole Spotlight; inventory 1a3f1f61a192                  |
| D09 | First launch without fleet dependencies; recovery       | Partial                                        | Packaged own-runtime design/source safeguards; earlier isolated installed checks unavailable; clean user/quarantine pending                                                                                    |
| D10 | Update, relocation/reopen and foreign-file safety       | Partial                                        | Current global app/connection repair and preserved duplicate cleanup; 53 installer guard tests; earlier fault/relocation artifacts unavailable; fresh-user/update acceptance pending                           |
| D11 | Protocol/process/diagnostics/cache/playback regressions | Historical panel/invalidation source verified  | source-verify.json: npm verify 448/21, 67-file lint zero warnings/errors, typecheck/build/format, 88 source pins; panel/diagnostic/invalidation regressions; earlier Python/Swift proof retains scope          |
| D12 | Real YouTube control/acquisition/inference/replacement  | Partial pre-fix actual Chrome acceptance       | Real icon/preparation/voice-only state; 226.621s/219.521s cold sources in 23.270s/22.229s; four initial READY jobs; actual recovery failure remains open                                                       |
| D13 | Real pause/seek/rate/volume/stop/navigation/two-tab     | Partial actual Chrome controls                 | Historical 679 hidden/reopened continuing playback; prior cb26 cached 219.521s Play/Pause/Home/seek/rate/Stop; historical failures retained; physical listening/measured offscreen/restart/ads/two-tab pending |
| D14 | Track matching, speech/music quality and lip-sync       | Pending live acceptance                        | Known full upstream ID/raw default evidence preserved conservatively; unknown remains unknown; no original/browser-selected claim                                                                              |
| D15 | Five/15-minute and repeated resource qualification      | Partial historical engine evidence             | Earlier long synthetic engine artifacts unavailable; current sustained browser and repeated-run/leak qualification pending                                                                                     |
| D16 | Model/downloader/native/disk/logging failures           | Prior installed fault acceptance               | Prior cb7 47 checks/4.694s: write/log recovery and package identity, no fixture verification claims; new-build wider fault acceptance remains separate                                                         |
| D17 | Browser restart/offscreen/sleep/wake/cancellation       | Narrow live context-loss/reconnect verified    | Actual revoked context safely paused/restored mute/showed Refresh; ordinary HTTPS refresh/retry succeeded and final Stop restored mute; measured >30s offscreen closure/full restart/sleep matrix open         |
| D18 | Final requirement audit and affected retesting          | Incomplete                                     | New source/app/runtime aligned; refreshed YouTube panel and actual context-loss/refresh/retry/Stop verified narrowly; pointer drag, listening/track/lip-sync/full lifecycle and launch gates open              |

Automatic approval review rejected automated `chrome://extensions` navigation
because the browser surface supports HTTP/HTTPS only. No CDP, browser, shell,
indirect UI or E2E-harness loading workaround is allowed. The user completed the
manual load; this does not authorize running that automated loading harness.

Public distribution remains a separate release: notarization/Gatekeeper with
quarantine, signed updates/rollback, installer media and Chrome Web Store review
require their own evidence and authorization. Local installation cannot establish
public download or store acceptance.

## Local app control v1

The SwiftUI app starts its bundled Node with `companion/app-control.js` and one
fixed command: `status`, `setup`, `snapshot`, or `export`. It passes a filtered
environment and its absolute `MUSICMUTE_LOCAL_APP_RESOURCES` directory. No page
can invoke this interface or choose paths, commands or remote URLs. User state is
`~/Library/Application Support/MusicMuteLocal/`. Native messaging remains v1.

Stdout is bounded newline-delimited JSON, one terminal result/error per command:

- Progress: `{protocol_version:1,type:"progress",phase,percent,label}`.
- Status/setup result: `{protocol_version:1,type:"result",status:{ready,platform,
arch,version,runtime_ready,model_ready,extension_registered,extension_path,
model_bytes,cache_bytes,diagnostic_mode,max_duration_seconds}}`.
- Diagnostic result: `{protocol_version:1,type:"result",report,path?}`. The path
  is an explicit local export location, never telemetry or a browser media grant.
- Error: `{protocol_version:1,type:"error",error_code,action}`. Codes/actions are
  bounded known messages; no raw exception, stderr, environment or credential.

The app links to Chrome extension setup and can reveal/copy the bundled extension
directory. `musicmute-local://setup` only brings the setup view forward. Setup is
explicit, cancellable and single-owner; no launch-time update or cloud fallback.

## Guideline preflight

Read the current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-02 before adding the app interface. Portable rules used: API-first
(100), JSON interchange (167), snake_case properties (118), compatibility (106),
safe errors without stack traces (177) and private event data (200). The new interface is a private local
process protocol, so REST paths, OAuth scopes, HTTP statuses and OpenAPI do not
apply. Existing protected Range media delivery is unchanged.
