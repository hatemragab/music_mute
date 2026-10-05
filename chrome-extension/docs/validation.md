# Validation ledger

The 2026-10-04 browser hardening and store candidate are described in
[Chrome Web Store preparation](chrome-web-store.md). Later checkpoints retain
their own scope; the earlier installed-package evidence below is historical.

## Manual checks and reload handoff candidate — 2026-10-06

Local manual-test build `5ed5c435-f446-4417-93d7-88e1c0be6a21` /
`1791237222` implements the owner-requested installed-content trust policy and
five-second local READY reload handoff described in [setup and updates](setup-updates.md).
No app installation, account operation, real-data reset, commit, publication or
deployment was performed for this candidate.

- Extension: rebuilt production `dist/extension`; bundled extension bytes match
  it exactly after excluding intentionally omitted source maps.
- DMG: `MusicMute-Local-0.1.0-1791237222-arm64.dmg`, 4,775,538 bytes,
  SHA-256 `d8e8ca0aeee8c4e2c1c4f5f606bc4f78fd3e1bdf20968e216454aa1f1538a95b`.
  `hdiutil verify` passed. Read-only mounted app passed strict/deep codesign and
  all 150 file/link entries matched the package. Current app-owned Python adapters
  match source. Evidence: `output/macos/manual-test-artifact.json`.
- Runtime: reuses `macos-arm64-v1-c923b1be1f135d8c48ef81c9`, archive SHA-256
  `e2ab2504dec4de6dd4bde8b7156bfb7e071bf22b4446a002d30e791ce603a064`, which matches
  this Mac's active runtime descriptor. No runtime/model reinstall was performed.
- `npm run verify` passed; after the final focused diagnostics/setup changes,
  typecheck, lint, build and format checks passed again. Final `npm test`:
  66 files, 1,969 passed, 4 existing environment-dependent skips.
- `npm run test:native`: native, desktop, updater and browser bridge suites passed.
  Final native sources additionally compiled with Swift 6 warnings as errors in
  the build/package. Tests prove ordinary execution performs zero runtime audits
  while explicit inspection detects altered contents/signatures.
- Local Python: 78 passed, no skips, using `worker/.venv/bin/python -I -B -S -m
unittest discover -s chrome-extension/tests -p 'test_*.py'` with the prepared
  pinned downloader directory selected. Shared engine: 102 tests run (101 passed) with one
  platform skip using `node scripts/run-engine-tests.mjs` and the qualified
  installed worker interpreter read-only. Fleet verification defaults are retained.
- `npm run test:e2e`: all 27 synthetic desktop Chrome checks passed, maximum
  observed drift 200 ms; `output/e2e-1791236809480/results.json`. An earlier run
  observed 258 ms against a 250 ms bound while builds ran concurrently; the isolated
  rerun passed. This is synthetic playback, not live YouTube or inference proof.
- Final packaged offline qualification: all 15 checks passed, including isolated
  Prepare/status, launcher repair, strict signatures, immutable runtime contents
  and GUI-closed HELLO (325 ms). Network/account/Keychain access was blocked;
  runtime and model were pre-staged in disposable state. Evidence:
  `output/packaged-tools-proof/c9034ff9-320e-4146-b1cb-8df23b5d8f04.noindex/result.json`.
- Final framed native HELLO/CHECK in disposable support state: HELLO 970 ms;
  eight CHECK progress/final messages; runtime 50,847 ms, model 2,001 ms, tools
  5,229 ms; all passed (58,077 ms total). Evidence:
  `output/packaged-tools-proof/e6efbf61-42a2-436c-b103-081b4a560efe.noindex/manual-check-final-proof.json`.
  These are local measurements, not a general speed guarantee or a warm-inference
  benchmark. Full-check work is now paid only when explicitly requested.

The candidate is ARM64, ad-hoc signed and not notarized/public-ready. It has not
been installed or manually accepted by the owner. No fresh YouTube acquisition,
new-model audio-quality/listening, account/R2, updater delivery, public runtime
network transfer or clean-machine setup is claimed. Changed installed executable
or model contents are intentionally trusted until Prepare/update or Check again.

## Thin-runtime Prepare evidence rules

A final thin-app record must state the starting state and every seeded artifact.
In particular, a run against a newly installed app and absent MusicMute Local
support data may still avoid the runtime network transfer by seeding the exact
package runtime ZIP as the expected complete `.zip.partial` file.

When the seed is an owned private regular file and independently matches the
bootstrap byte count and SHA-256, native Prepare promotes it through its normal
recovery path. A completed run can therefore establish archive verification,
extraction, full leaf and code-signature verification, atomic activation, model
preparation, launcher creation and Chrome registration, provided the evidence
observes each stage. It is valid fresh **app/data** proof with an exact
complete-partial seed; it is not fresh **runtime network download** proof.

The record must not infer DNS, TLS, redirects, CDN hosting, range/ETag resume or
zero-byte transfer from that run. Those require starting without an archive or
partial and fetching the exact immutable artifact from the sealed HTTPS URL.
Similarly, only claim model download when the model was absent and its transfer
and verification were observed; only claim browser readiness after the installed
registration/launcher and actual helper handshake are read back. A fresh support
root on an existing development Mac is not a fresh macOS user, quarantined DMG,
Gatekeeper, notarization or public-distribution test.

## Current c14116b8 package, install, receipt and warm-cache YouTube checkpoint — 2026-10-05

The current candidate is build ID
`c14116b8-cf2c-4865-8a24-f9f1dce2a119`, `CFBundleVersion` `1791212763`:

| Field                   | Current value                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Package record          | `output/macos/build-c14116b8-cf2c-4865-8a24-f9f1dce2a119.noindex/package-result.json`                          |
| Thin app bytes          | 17,663,025                                                                                                     |
| Architecture/signing    | ARM64, ad hoc; package/installed 139-leaf inventory and deep strict signature checks passed                    |
| External inventory      | SHA-256 `3e5d49e98f7147ac049224d36a1227b3ad46cb48f08711ff2f79f8762e00a276`                                     |
| Bundle-audit file       | SHA-256 `4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`                                     |
| External runtime        | Reused `macos-arm64-v1-c923b1be1f135d8c48ef81c9`; 1,297,496,698 declared bytes across 18,031 leaves            |
| Runtime archive         | 410,586,280 bytes; SHA-256 `9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`                  |
| Verified model          | Reused 66,759,214-byte model; SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`       |
| Base prepared footprint | 1,381,918,937 bytes for one app, one runtime release and one model                                             |
| Release flags           | `notarized=false`, `public_ready=false`, `relocated_runtime_tested=false`; Sparkle is present but unconfigured |

Source checks for this candidate passed TypeScript typecheck, formatting, a
167-file zero-warning lint, 63 test files with 1,919 passing and four skipped
tests, and the production build. Focused `NativeTests`, `DesktopTests` and
`BrowserProcessingBridgeTests` passed. The aggregate native command stopped at
the existing `UpdaterTests.swift:317` timing precondition, so that aggregate run
is not recorded as passing.

The disposable package qualification at
`output/packaged-tools-proof/e9fb0a01-33a0-44b9-b18a-391fe2130002.noindex/result.json`
passed all 15 checks, including staged external-runtime verification, immutable
app/runtime signatures, offline Setup/Status with six ready components,
missing-launcher repair, isolated Chrome registration and GUI-closed native
HELLO. It opened no installed GUI or browser, read no real browser profile or
account, disabled Keychain-helper and native outbound-network use, downloaded no
model and ran no inference. The preceding
`output/packaged-tools-proof/ac26072b-a779-4301-9973-d6a24ab37f02.noindex/`
attempt timed out in the cold GUI-closed HELLO child at 90.079 seconds and is not
a pass; the passing rerun completed that HELLO in 72.789 seconds. Neither run
establishes a cold-start SLA.

Installed readback at `/Applications/MusicMute Local.app` matched the package's
139 file/link leaves, build and ARM64 architecture and passed deep strict
signature verification. A full installed runtime verification created
`~/Library/Application Support/MusicMuteLocal/runtime/verification-receipt-v1.json`
as a private mode-0400 regular file. That observation proves receipt creation,
not a c141 fast-path timing claim. The receipt is authenticated by a
non-synchronizing device-only Keychain key and binds the signed app build/CDHash,
verification policy, bootstrap/active/runtime/release/payload identities and
exact inventory metadata. Later processes may use it only after outer-app
validation and two identical metadata fingerprints under the setup/update
leases. Missing, corrupt, unauthenticated or mismatched receipts, unavailable
Keychain access, or a bound identity/policy/metadata change fall back to full
verification and a best-effort new receipt. This narrows cooperative-update and
in-scan TOCTOU windows but cannot stop a hostile same-UID mutation after the last
check.

### Current c141 final-dist and warm-cache YouTube playback

Chrome Secure Preferences recorded extension ID
`dclpfemnpknfdlpcbfcjkmdbnociippd` at the exact repository `dist/extension`
path, with `last_update_time` `2026-10-05T15:19:15.409Z`. This reload was before
the c141 app installation at 15:20Z; no post-install reload is claimed, and the
loaded `dist` was already the final bundle. The canonical c141 app launched from
`/Applications`, and its runtime receipt updated at 15:20:33Z.

After that install, refreshing a real Stromae YouTube tab and starting MusicMute
reached visible **MusicMute · On this Mac** and **Voice-only playback**. Current
companion logs identify software `0.1.0` and package inventory
`4de0acb10e0b5790fd2ad42f143a6329cb96c8700a471d96c9daab59d7a87331`.
They record companion start at 15:27:45.352Z, `job_started` at 15:27:46.294Z,
`job_ready` at 15:27:46.366Z with `cache_hit=true` and 66.157 ms elapsed, a
5.961 ms cache hit, and `playback_started` at 15:27:46.902Z. The current session
contains zero `INVALID_MESSAGE`, `TOOL_OUTPUT_LIMIT`,
`SOURCE_AUDIO_FORMAT_UNAVAILABLE` or `ACCOUNT_RESTORE_UNSAFE` events; page
developer logs contain no MusicMute warnings/errors or target-code messages. The
page advanced after capture and was paused. Screenshot:
`/Users/hatemragap/.codex/visualizations/2026/10/04/01a107ce-edf1-74c2-bb3a-42e0d04cdb74/musicmute-c141-live.png`.

This establishes one real-YouTube warm-cache local playback start through the
current c141 companion and final unpacked `dist`. It does not exercise fresh
source acquisition, provider/downloader behavior or MPS separation, and proves
no physical listening, selected-source identity, lip-sync, sustained playback,
controls/restart matrix, account/R2/cloud behavior or Web Store delivery.

This installation was an ordinary compatible update that reused the existing
runtime, model and user state. It was not a clean reset or fresh Prepare and does
not establish runtime URL/network transfer, model download, a fresh OS user or
machine, account/R2/cloud behavior, notarization or public release. The 58d
section below remains the separate clean-reset, Prepare and synthetic native
UI/direct protocol evidence.

## Historical 58d55f40 clean-reset package and installed checkpoint — 2026-10-05

The then-source-final local package was build ID
`58d55f40-6789-42fb-9e02-5f3e43f5cc3f`, `CFBundleVersion` `1791171228`:

| Field                   | Final value                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Package record          | `output/macos/build-58d55f40-6789-42fb-9e02-5f3e43f5cc3f.noindex/package-result.json`                          |
| Thin app bytes          | 17,547,290                                                                                                     |
| Architecture/signing    | ARM64, ad hoc; package/installed inventory and deep strict signature checks passed                             |
| External runtime        | `macos-arm64-v1-c923b1be1f135d8c48ef81c9`                                                                      |
| Runtime archive         | 410,586,280 bytes; SHA-256 `9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`                  |
| Installed runtime       | 1,297,496,698 declared bytes across 18,031 entries; allocated storage may differ from this declared byte sum   |
| Verified model          | 66,759,214 bytes; SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`                   |
| Base prepared footprint | 1,381,803,202 bytes for one app, one runtime release and one model                                             |
| Release flags           | `notarized=false`, `public_ready=false`, `relocated_runtime_tested=false`; Sparkle is present but unconfigured |

The package result's external `final_inventory_sha256` is
`2fda53d1b4216db660fc11777e817527b282cfd25439423a8a7de48dc4a91a03`.
The embedded `Contents/Resources/bundle-audit.json` identity is
`9606d131c65fe59910dd77e5c82f6eac1b5dc09e465878fe0e45eecfb5f755b5`.
Package/installed comparison matched all 139 app file/link leaves with no byte or
link differences. Installation normalized only the group ID; no bundle node was
group/world writable. The installed build and ARM64 architecture were exact, and
`/Applications/MusicMute Local.app` passed deep strict signature verification.

The separate disposable qualification at
`output/packaged-tools-proof/5d721f3c-235d-4577-9da2-33c35c756e3a.noindex/result.json`
passed all 15 checks: staged external-runtime verification, immutable app/runtime
signatures, offline Setup/Status with six ready components, missing-launcher
repair, isolated Chrome registration and GUI-closed native HELLO. Its own scope
uses no installed GUI, real browser profile, account, Keychain helper, model
download or inference.

### 58d authorized clean reset and Prepare

The final reset first isolated the prior app, MusicMute Local support root,
native-messaging manifest, preferences and app backups at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-063747-final-58d55f40`.
The exact account-auth and guest-capability Keychain items were absent; deletion
commands returned status 44. `MusicMuteWorker`, the Chrome profile, repository
artifacts, source media and unrelated data were preserved. The exact final app
was installed into `/Applications`; source-to-installed inventory, build, ARM64
and strict-signature checks passed before first Prepare.

After the final proof, the `063747` archive was permanently purged; it is absent
and unrecoverable. The earlier `053140` and `055936` reset archives are also
absent. The empty installer-created `/Applications/.musicmute-backups.noindex`
was removed and old auxiliary paths were verified absent. At that checkpoint the
installed app was build `1791171228`.

Only the package's exact runtime ZIP was preseeded at the expected
`runtime/downloads/*.zip.partial` path with mode 0600. Prepare consumed it through
the normal verification/extraction/activation path, reached all six Ready checks,
and the UI showed **Ready** / **Mac ready**. Runtime validation took 19,736.927 ms.
The absent model was downloaded and verified in 13,417.891 ms. This is valid clean
app/support-data, archive verification, activation and model-download evidence,
but it is not runtime URL, DNS, TLS, redirect, CDN or HTTP Range/ETag proof.

Post-Prepare readback found the support, runtime and downloads directories at mode
0700, downloads empty, `active.json` mode 0400 with the exact runtime/archive,
the launcher at mode 0700, and both model and native-messaging manifest at mode 0600. The installed app remained exact, ARM64 and strict-signed.

### 58d signed-out native and preserved-profile Chrome evidence

Signed-out Home showed Google and email actions plus the web-app and Google Play
product links, with no stale media error. The GUI processed
`output/desktop-smoke/8eae9504-066c-424b-8935-00ed135f9e9e/synthetic.wav`
(264,678 bytes; SHA-256
`001d9f51f6ab3149daea19ac4188cbcfe3faf4cfe6e1b789e3c958cc15ba6703`).
It reported **Voice ready** in 58,356 ms, automatic playback reached 3.017 s, and
Library showed the 3.0-second result as **Saved offline**, 62 KB. After
Quit/relaunch the entry persisted and replay loaded with **Pause** at 0:00. The
signed-out Library correctly omitted connected copy.

The existing unpacked extension `dclpfemnpknfdlpcbfcjkmdbnociippd` remained
loaded from repository `dist`. Its core bundle files matched the installed
package; the installed native manifest and launcher were exact. A direct installed
`--browser-processing-bridge` settings request returned
`{ "processing_mode": "local" }`. An exact native-messaging HELLO through the
registered manifest and extension origin returned `ready: true`, `darwin`,
`arm64`, version `0.1.0`, 1,200 seconds and provider `LOCAL_MACOS`, with
`processing_selection_v1` negotiated. The native host exited and the GUI remained
closed. This is protocol-level handshake and on-disk loaded-bundle alignment, not
a final popup UI observation.

This is an existing development Mac, not a fresh OS user or machine. The runtime
network path, real YouTube acquisition/playback, physical listening, source-track
identity, lip-sync and sustained-duration behavior remain unproved. The run was
signed out and establishes no signed-in account, cloud Library/R2, cloud
processing or cross-device flow. The app remains ad hoc signed, unnotarized,
updater-unconfigured and not public-ready; the unpacked extension establishes no
Chrome Web Store delivery. The future Downloads landing and Google Play
destinations were unavailable when checked and remain discovery-only.

### Library snapshot-readiness correction

The final audit found that build `2ed7711e` could make Home/Library show connected
as soon as the WebSocket was ready, before a valid first jobs snapshot arrived.
Build `58d55f40` scopes snapshot acceptance to the current account session and
stream ID. Only a structurally valid jobs page marks that pair ready; disconnect,
reconnect, account change and stale async completion paths reset or identity-fence
readiness, while pagination on the same ready stream preserves it. Home and
Library connected copy now consumes this readiness instead of transport readiness.

`npm run test:native` passed all four native suites after the fix. The focused
Swift 6 warnings-as-errors build and strict swift-format check passed. The native
regression reducer covers wrong-account and wrong-stream snapshots, reconnect,
same-stream pagination, teardown, valid empty/paginated pages and malformed page
rejection. `npm run verify` then passed typecheck, zero-warning lint across 167
files, 63 Vitest files with 1,910 passing and 4 skipped tests, build and Prettier.

## Superseded 2ed7711e package checkpoint — 2026-10-05

Build `2ed7711e-7cd6-4b37-992f-c6fb02782812` / `1791168902` retains its exact
17,524,458-byte package/install, Prepare, synthetic playback/relaunch and
preserved-profile Chrome evidence in repository history. Its external inventory
was `e64f07d32ead963fd9f731d7d05cb8a99b94ab6085bf8a8dee76c61f00876285`
and its embedded bundle identity was
`b8e73da37c9caee8ac207d011c217693fe4917c3404912d68acc8ee99b5ed332`.
Its package record is
`output/macos/build-2ed7711e-7cd6-4b37-992f-c6fb02782812.noindex/package-result.json`;
its 15-check disposable proof is
`output/packaged-tools-proof/757b7d0b-1f45-4253-952c-96aeadc0be96.noindex/result.json`.
It is historical rather than source-final because it predates the
account/stream-scoped first-jobs-snapshot readiness fix. Build `58d55f40` above
supersedes it. Its `055936` reset archive was permanently purged and is
unrecoverable.

## Interim e2aa package, reset, Prepare and UI checkpoint — 2026-10-05

This package/install run is preserved as valid dated evidence, but later audits
found that the web Account page Google link needed the Google G, macOS connected
copy needed `account.online`, and Library snapshot readiness needed to wait beyond
socket readiness for the first valid account/stream jobs snapshot. Therefore e2aa
is **not** source-final; historical 2ed fixed the first two gaps, and authoritative
58d above fixes the final snapshot-readiness gap and supersedes both. The interim
package was build ID
`e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6`, `CFBundleVersion` `1791167264`:

| Field                   | Recorded value                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package record          | `output/macos/build-e2aa2a66-bbb2-470c-98c6-c2cdf0e904f6.noindex/package-result.json`                                                                        |
| Thin app bytes          | 17,524,330                                                                                                                                                   |
| Architecture/signing    | ARM64, ad hoc; deep strict signature verification passed                                                                                                     |
| External runtime        | `macos-arm64-v1-c923b1be1f135d8c48ef81c9`                                                                                                                    |
| Runtime archive         | 410,586,280 bytes; SHA-256 `9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`                                                                |
| Installed runtime       | 1,297,496,698 declared bytes across 18,031 file/link entries; `du -sk` may report 1,309,552 KiB because that is allocated storage, not the declared byte sum |
| Verified model          | 66,759,214 bytes; SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`                                                                 |
| Base prepared footprint | 1,381,780,242 bytes for one app, one runtime release and one model                                                                                           |
| Release flags           | `notarized=false`, `public_ready=false`, `relocated_runtime_tested=false`; Sparkle is present but unconfigured                                               |

The package result's external `final_inventory_sha256` is
`b182774d45d2cb24b5d6c529e596b2a2160d9403a2a1bfd2553c62f19f77b4d7`.
The companion-reported `package_inventory_sha256` is instead
`a0f4091d4d96e9bc734287ae1ede7ddb422ee5b776844c8dc335610e04fc9e53`,
the SHA-256 of `Contents/Resources/bundle-audit.json` listed inside that final
inventory. These values cover different artifacts and must not be interchanged.
The installed `/Applications/MusicMute Local.app` matched the interim package tree,
reports the exact build, is ARM64 and passes deep strict code-signature
verification.

The separate disposable qualification at
`output/packaged-tools-proof/25f5be61-a442-436b-bc26-b1c987c7f24b.noindex/result.json`
passed all 15 checks. It verifies the staged external runtime, immutable package
and runtime signatures, offline Setup/Status with all six components ready,
missing-launcher repair, isolated Chrome registration and a GUI-closed native
HELLO. Its own record explicitly opened no GUI/browser, used no account or
Keychain helper, allowed no outbound network and ran no inference; it is package
qualification, not the installed UI run below.

### Authorized clean app-data boundary and Prepare

The authorized e2aa reset initially isolated the previous app, MusicMute Local
support data, native-messaging manifest, preferences and old app backups at
`/Users/hatemragap/.Trash/MusicMuteLocal-reset-20261005-053140-final-e2aa`.
It did not remove the Chrome profile, repository output, source media,
`MusicMuteWorker` or unrelated data. Both the account-auth and guest-capability
Keychain items were absent; their delete probes returned status 44. The exact
e2aa package was then installed into `/Applications`, and the MusicMute Local
support root was confirmed absent before first Prepare.

To avoid repeating a 410 MB transfer on this development Mac, the exact sealed
runtime archive was copied privately with mode 0600 only to the app's expected
`runtime/downloads/*.zip.partial` path. No release, model, launcher or active
descriptor was preinstalled. Prepare consumed that package-bound partial through
the normal verification/extraction/activation path, downloaded and verified the
66,759,214-byte model, passed all six component checks, and the installed UI
showed **Ready** / **Mac ready**. This establishes clean app/support-data Prepare,
archive verification, extraction, activation, model download and readiness. It
does **not** exercise the runtime URL, DNS, TLS, redirects, CDN, HTTP Range/ETag
resume or a zero-byte network start.

Post-Prepare readback found the support root, `runtime/` and
`runtime/downloads/` at mode 0700, with `runtime/downloads/` empty. `active.json`
was mode 0400 and selected the exact runtime/archive above; `native-launcher.sh`
was mode 0700 and the native-messaging manifest was mode 0600. The installed app
still passed strict signing and ARM64 checks.

### E2aa signed-out native and preserved-profile Chrome evidence

On first launch the signed-out Home showed Google and email sign-in plus product
discovery, without a stale media error. The installed GUI then processed
`output/desktop-smoke/8eae9504-066c-424b-8935-00ed135f9e9e/synthetic.wav`
(264,678 bytes; SHA-256
`001d9f51f6ab3149daea19ac4188cbcfe3faf4cfe6e1b789e3c958cc15ba6703`).
It reported **Voice ready**; the player advanced to 3.017 s; and Library showed
the 3.0-second result as **Saved offline**, 62 KB. After a clean Quit and relaunch,
the Library entry persisted and replay advanced from 0.250 s to 3.017 s.

The existing unpacked Chrome extension
`dclpfemnpknfdlpcbfcjkmdbnociippd` was reloaded from the interim installed app.
Its corrected popup showed **Up to 20 min**, **Your Mac is ready**, and
**Ready · processing stays on this Mac**. Local tools showed processing mode
**On this Mac — Apple Silicon**. A direct installed bridge
`{ "operation": "settings" }` request returned
`{ "processing_mode": "local" }`. With the GUI app quit, **Check again** launched
the installed native host and returned Ready. The eight saved local errors remain
preserved-profile history from 2026-10-04; they are not fresh failures from the
e2aa install.

This interim checkpoint used an existing development Mac, not a fresh OS user or
machine. The app remains ad hoc signed, unnotarized, updater-unconfigured and not
public-ready. Processing used only synthetic audio and does not establish
listening quality, real listening-source identity, lip-sync or sustained-duration
behavior. The run stayed signed out and proves no account, Library cloud sync,
private R2 or cloud-processing path. Chrome remained an unpacked preserved-profile
installation; no fresh YouTube acquisition/playback or Chrome Web Store delivery
was attempted.

## Earlier thin candidate pair — 2026-10-05 (historical)

Before the interim e2aa package and authorized clean app-data run above, the local
candidate pair was:

| Role  | Build        | Package record                                                                        | App bytes  | Runtime reuse                     |
| ----- | ------------ | ------------------------------------------------------------------------------------- | ---------- | --------------------------------- |
| Fresh | `1791161573` | `output/macos/build-a080a372-f235-41d1-99db-e16841fee061.noindex/package-result.json` | 17,371,631 | No                                |
| Reuse | `1791161574` | `output/macos/build-a11b999c-042a-4cb5-bd7c-4cc030b9029f.noindex/package-result.json` | 17,371,704 | Yes, exact fresh-build provenance |

Both thin apps omit `Contents/Resources/runtime`. Their external artifact is
runtime `macos-arm64-v1-c923b1be1f135d8c48ef81c9`: a 410,586,280-byte ZIP with
SHA-256 `9b972df17be6fa5797f651e23d71cc5ea667b50f888b7e9dd8240bc1aef181d0`
and a sidecar manifest with SHA-256
`29ce41c4711ef754efd1ae7105f3543108a6be7e14776dff2daebbc34c6bc55c`.
Fresh and reuse copies are byte-identical. Extraction independently matched all
18,031 declared entries: 17,549 files, 482 contained symlinks,
1,297,496,698 installed bytes and 336 ARM64 ad-hoc hardened-runtime signatures.

Both apps pass `codesign --verify --deep --strict` and all eight app Mach-O
signatures. Their exact post-seal inventories independently match all 137 app
entries and have SHA-256
`8bb51c264c42366403f0e59142ace4ec432aa7548d53cee23bc2bafba406dadc`
(fresh) and
`9c3f50d19095d1e7673fe05602feef85ba6521d40e2d1c4e2f335102fc716537`
(reuse). The embedded audit is explicitly pre-outer-seal, excludes itself and
defers the main executable and `CodeResources` measurements to those external
final inventories. The exact model metadata remains 66,759,214 bytes with
SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.

`output/packaged-tools-proof/00d1570c-a68e-4c2c-b64a-65eab2e9d6e2.noindex/result.json`
passes all 15 disposable offline checks. It stages and re-audits the exact
external runtime, runs packaged Setup and Status with all six components ready,
repairs an absent launcher, verifies isolated Chrome registration, receives a
GUI-closed native HELLO and confirms the runtime and app signature remain
unchanged. It opens no GUI or browser, reads no existing user state, permits no
network or Keychain helper, uses no account, downloads no model and runs no
inference. Native home resolution is exercised with a disposable
`CFFIXED_USER_HOME`; this is not a real installed launcher or clean-user test.

The two historical builds were produced with outbound network and writes to `/Applications`,
the per-user Applications folder and all real MusicMute support roots denied.
At that earlier checkpoint, `/Applications/MusicMute Local.app` remained the historical embedded-
runtime build `1791143568` at 1,320,162,362 file bytes with a valid strict
signature. The candidate uses `downloads.example.invalid`, is ad hoc signed,
unnotarized, `public_ready=false` and `relocated_runtime_tested=false`. Therefore
that candidate checkpoint did not prove a live Prepare download, Finder installation,
Gatekeeper/quarantine acceptance, notarization, real Chrome playback, inference,
deployment or publication.

## Historical browser/store candidate checkpoint — 2026-10-04

That dated browser candidate passed 1,488 source tests and 31 production-manifest
Chrome fixture checks, including six minutes with a genuinely hidden player and
a forty-second pause/resume. Both native suites and all 58 Python tests passed.
The exact tested ZIP, SHA-256, commands, generated assets and remaining public
release gates are recorded in
[the store validation checkpoint](chrome-web-store.md#local-candidate-validation--2026-10-04).
This does not replace or upgrade the historical installed/live evidence below.

## Historical checkpoint — 2026-10-02

At that checkpoint, source passed **448 Vitest tests in 21 files**, typecheck, build,
Prettier and lint on **67 files with zero warnings/errors**. Generated build
`67960e3f` contains **1,113,057,345 bytes** and **303 ARM64 native files**. Its canonical
installation passes 21 source/package/installed hash checks and strict signatures;
inventory prefix is `1a3f1f61a192`. Reopened Overview shows Mac ready. It is ad hoc
signed and not notarized.
Prior installed `cb26daf3` passed 21 alignment/signature checks and showed Mac
ready. Earlier `cb7dec7c` native/cache/fault/UI evidence retains its original scope;
it is not new-build playback acceptance.

The earlier regular Chrome observation found **zero MusicMute controls**, one
existing HaramMute control, and a paused 19.021-second YouTube video. It predates
the user manually loading the extension, which is now resolved. Subsequent actual
Chrome evidence includes the injected icon, preparation and voice-only state, but
also exposes a long-pause/retry recovery failure. Physical listening and
source-track matching are explicitly unverified. The user later Reloaded
`cb26daf3`; cached playback, pause, seek, rate and Stop were observed on actual
HTTPS YouTube. This partial prior-build evidence does not close the measured
offscreen-closure/restart matrix. New panel and context invalidation behavior
now have refreshed-page live panel hide/reopen, keyboard movement, Escape/Home
and centered-icon evidence after the user's new Reload. Actual context revocation
while active safely paused/restored mute, then refresh/retry resumed cached
playback and final Stop restored original audio. Successful pointer dragging and
the complete offscreen/restart/sleep matrix remain separate pending checks.
The full requested MVP is not complete.

## Evidence availability

The earlier ignored `output/` evidence directory disappeared during this session.
A read-only audit of the previous ledger found all **46 distinct historical
JSON/PNG paths** it cited absent. Historical timings, screenshots and acceptance
records below are preserved as narrative context, **not currently inspectable
proof**. Their disappearance does not prove a product failure, and old successful
runs do not establish the current source/package state. New artifacts listed in
this ledger were inspected separately after they were recreated.

No artifact is counted as current proof solely because an earlier message or this
ledger describes it. Generated package metadata, installed bytes, actual execution,
synthetic fixtures and ordinary browser observation each have their own scope.

## Historical 679-era evidence and then-open gates

Everything in this section predates and is superseded as current package/install
evidence by c14116b8 above; 58d55f40 separately supersedes it for clean-reset,
Prepare and synthetic UI evidence. The then-current source verification
was `source-verify.json` in the panel proof
directory: 448 tests/21 files, typecheck/build/format, 67-file zero-warning lint and
88 source pins. The current
package creation record is
`output/macos/build-67960e3f-97ec-44bf-a29b-662357b28677.noindex/package-result.json`.
Its installation/alignment report is
`output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/installed-alignment.json`:
21 hash checks, strict signatures, private backup, sole canonical Spotlight result
and unchanged registration. Reopened actual Overview showed Mac ready.

New ordinary HTTP browser checks run compiled content.js/CSS with a fake Chrome
runtime: panel hide/progress/READY/playback/reopen, arrow/Shift/Home movement,
430px/320px resize and icon centering. They load no extension and play no
replacement audio. Hidden clocks advanced from 9 to 2,394 with one Start and zero
Stop/Cancel; explicit Stop counted once and restored mute. Pointer UI attempts missed the handle, so successful drag
evidence is limited to unit tests. These checks are not live YouTube acceptance.

Prior `cb26daf3` browser controls are recorded under
`output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/prior-cb26-live-playback.json`.
The adjacent `prior-cb26-host-summary.json` is latest bounded native history, not
correlated to the UI cycle; it cannot establish an error-free browser cycle.

Historical `67960e3f` real YouTube cases, image and bounded console summary are
`real-youtube-panel-cases.json`, `real-youtube-compact-controls.jpg` and
`real-youtube-console-summary.json` in that same panel proof directory. They
establish the narrow live panel scope described below, not source-track matching,
physical audio quality or a complete browser restart/offscreen/sleep matrix.
The updated cases also record actual context-loss safety, refresh/retry and final
Pause/Stop; `real-youtube-reload-notice.jpg` preserves the actionable notice.
`fixture-cases.json` saves the compiled fake-runtime checks, including explicit
Cancel/Stop and simulated invalidation/mute restoration without errors.
`installed-app-ready.ax.txt` and `.jpg` save the reopened canonical Mac ready
view. `new-build-host-summary.json` is latest bounded history: 117 rows, four
cache READY observations across two hosts and empty code counts. Its exact
inventory matches the new build; it is not necessarily correlated to one UI cycle.

| Scope                                                            | Evidence                                                                                                                                                                                           | Status and limit                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical panel/invalidation source                             | `output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/source-verify.json`                                                                                                              | Passed 448 tests/21 files, typecheck, 67-file zero-warning lint, build/format and 88 source pins; source checks alone do not claim live playback                                                                                              |
| Historical 679 app package                                       | `output/macos/build-67960e3f-97ec-44bf-a29b-662357b28677.noindex/package-result.json`                                                                                                              | 1,113,057,345 bytes/303 ARM64 files; ad hoc signed, not notarized                                                                                                                                                                             |
| Historical 679 installed alignment/Overview                      | `output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/installed-alignment.json`                                                                                                        | 21 hash checks/strict signatures; inventory 1a3f1f61a192; canonical/private backup/unchanged registration/sole Spotlight; reopened Mac ready                                                                                                  |
| Historical compiled HTTP panel fixture                           | `output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/fixture-cases.json`                                                                                                              | Compiled content.js/CSS/fake runtime: hide/continue/reopen, keyboard/resize/icon, explicit Cancel/Stop and simulated invalidation/restore mute; no extension load/replacement audio; pointer unit-only                                        |
| Historical 679 real YouTube panel                                | `output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/real-youtube-panel-cases.json` and `real-youtube-compact-controls.jpg`                                                           | Cached 219.521s source: hidden continuing playback/reopen, keyboard movement/Escape/Home, 304×127.70px panel and zero icon-center offsets; no successful pointer drag or physical listening claim                                             |
| Historical bounded YouTube console                               | `output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/real-youtube-console-summary.json`                                                                                               | Final 491 retained records from 13:52:36–13:53:33; zero warning/error entries after cutoff 14:19:33.362Z in this bounded result, not entire-profile/error-history clearance                                                                   |
| Historical 679 context-loss/reconnect                            | Updated `real-youtube-panel-cases.json` and `real-youtube-reload-notice.jpg` in the panel proof directory                                                                                          | Revoked active context: disabled icon/Refresh notice/paused/unmuted; HTTPS refresh/retry resumed cached Voice-only; final Pause/Stop paused/unmuted/unpressed; full lifecycle matrix separate                                                 |
| Historical 679 bounded host history                              | `output/panel-controls-proof/5b59b489-8cb1-40a1-bca0-ad7a2abb76b5/new-build-host-summary.json`                                                                                                     | 117 rows/four cache READY observations/two hosts; exact new inventory/empty code counts; not necessarily one correlated UI cycle or an inference claim                                                                                        |
| Prior recovery/context source audit                              | `output/applications-continuation-proof/a2205389-2080-4492-9fbc-f14002125e91/recovery-source-verify.json`: npm verify 379/19, 64-file zero-warning lint, typecheck/build/format and 80 source pins | Passed dated source; superseded for current source by 448/21 verification; extension-loading harness false                                                                                                                                    |
| Earlier installer/noindex source audit                           | Terminal npm verify 374/19 and 64-file lint before recovery work; 53 installer guard cases                                                                                                         | Passed dated source audit; Spotlight canonical result unchanged before/after; superseded for current source by 379-test proof                                                                                                                 |
| Earlier pinned source snapshot                                   | `output/current-source-verify-proof/d4e0dd42-409d-447b-a6fc-cf9e26208919/result.json`: 321/18, 63-file lint and 84 source pins                                                                     | Earlier source snapshot; excludes the new installer tests/guards and noindex packaging change                                                                                                                                                 |
| Raw upstream track preservation                                  | 17 current Python source tests for the guarded bootstrap                                                                                                                                           | Passed offline source; no extra acquisition or browser-selected-track proof                                                                                                                                                                   |
| Pinned selector and stdin replay                                 | `output/source-selection-proof/0ae58d70-465e-484c-a8fd-b818a72d7716/result.json`: 36 checks/seven cases in 3.260s                                                                                  | Passed offline pinned CLI/current TypeScript; zero network and child launches                                                                                                                                                                 |
| Swift identity/decoding/UI source                                | `output/native-identity-current-proof/269bf7f9-e11d-42cb-b168-fb06fc0fc1cb/result.json`                                                                                                            | Strict Swift 6 NativeTests and production compilation, strict format; eight inventory replacement cases; installed execution false                                                                                                            |
| Prior cb26 app package                                           | `output/macos/build-cb26daf3-9230-4fa3-8afa-35c0dfb0c28b.noindex/package-result.json`                                                                                                              | 1,113,043,305 bytes/303 ARM64 native files; verified previous runtime/downloader reused read-only; zero additional absolute RPATH removals; ad hoc/not notarized                                                                              |
| Prior cb26 source/package/installed alignment                    | `output/applications-continuation-proof/a2205389-2080-4492-9fbc-f14002125e91/updated-installed-alignment.json`                                                                                     | Passed 21 checks: 18 source/package/installed plus main/audit/Info.plist; strict signature; private noindex backup; sole canonical Spotlight app; browser playback false in that report                                                       |
| Prior cb26 native Overview                                       | `output/applications-continuation-proof/a2205389-2080-4492-9fbc-f14002125e91/updated-app-ready.ax.txt` and `updated-app-ready.png`                                                                 | Actual cb26 Overview Mac ready observed; not full UI/export/Chrome acceptance                                                                                                                                                                 |
| Prior cb26 Diagnostics and canonical Finder location             | `output/applications-continuation-proof/a2205389-2080-4492-9fbc-f14002125e91/updated-diagnostics.ax.txt` and `single-visible-app.ax.txt`                                                           | Recorder 2d118fd17397/expected model ce74 and historical failures retained; refreshed Finder points to canonical /Applications app; no new 679 export claim                                                                                   |
| Prior cb7 package                                                | `output/macos/build-cb7dec7c-5edf-48cd-91ad-4cf275b599e5.noindex/package-result.json`                                                                                                              | Preserved previous generated package, 1,113,041,631 bytes/303 ARM64 files/58 removed RPATHs; creation record retains old path strings                                                                                                         |
| Prior cb7 installation/alignment                                 | `output/installed-build-proof/976ffcfb-6714-479f-b431-2952ffcbf390/result.json`                                                                                                                    | Earlier 18-file/main/inventory alignment/signature and matching Swift proof; retains prior execution scope                                                                                                                                    |
| Prior cb7 packaged YouTube acquisition/MPS/Range                 | `output/live-smoke-1790940725516-a3a6fbc3-bdda-4fe5-98d5-a819999f43ca/result.json`                                                                                                                 | Passed 19.021s, 19.005556s untrimmed output, Range206/1,024 bytes; cb7 recorder/inventory/verified model match; full track ID unknown; browser playback false                                                                                 |
| Prior cb7 cache replay                                           | `output/native-cache-proof/988ea356-048b-4558-9a43-ad14a694d1b1/result.json`: 15 checks/two hosts/343ms                                                                                            | Fresh jobs/capabilities and retained provenance in prior build; readiness/acquisition/inference/browser bypassed                                                                                                                              |
| Prior cb7 write-fault recovery                                   | `output/native-write-fault-proof/0036ddcf-ed64-45d0-acef-dc4e10f3d32b/result.json`: 47 checks/4.694s                                                                                               | Prior package identity preserved, safe write/log recovery, no fixture verification claims; readiness/acquisition/inference/browser bypassed; no physical disk fill                                                                            |
| Prior cb7 Diagnostics UI/private export                          | `output/current-native-ui-proof/cb3f6a61-e610-48d4-8c64-341a2f977858/result.json`, `export.png` and `export.ax.txt`: 15 checks                                                                     | Actual prior installed UI/private 12,410-byte export/current-at-recording identity and legacy unknown preservation; not new cb26 UI/export proof                                                                                              |
| Canonical global app and preserved duplicate cleanup             | `output/applications-continuation-proof/a2205389-2080-4492-9fbc-f14002125e91/duplicate-app-cleanup.json`, `global-setup.ax.txt` and `applications-finder.ax.txt`                                   | Canonical `/Applications/MusicMute Local.app`; moved old bundles/noindex package preserved; model/cache/logs unchanged; Setup runtime/model/connection Ready observed; no app deletion                                                        |
| Regular Chrome loading                                           | User completed initial load, prior cb26 Reload and new 67960e3f Reload followed by ordinary YouTube refresh                                                                                        | New aria-controls/expanded and compact panel observed; no automated extension loading permitted                                                                                                                                               |
| Pre-fix actual regular Chrome preparation and playback telemetry | `output/applications-continuation-proof/a2205389-2080-4492-9fbc-f14002125e91/root-live-observations.json` and `consumer-before-recovery-fix.json`                                                  | Actual icon/preparation/voice-only state; 226.621s/219.521s cold preparation 23.270s/22.229s; initial four READY jobs with cache hits and 31 reported drift samples 2–112ms; incomplete bounded history; no physical listening/track matching |
| Pre-fix actual Chrome recovery failures and local export         | `output/applications-continuation-proof/a2205389-2080-4492-9fbc-f14002125e91/actual-playback-failures.ax.txt`, `actual-playback-failures.png` and `consumer-export-proof.json`                     | AUDIO_CONTEXT_LOST and generic navigation UNCAUGHT_ERROR retained; actual pre-fix GUI export 461,112 bytes; later prior cb26 control cycle does not close wider recovery matrix                                                               |
| Pre-load regular Chrome HTTPS YouTube observation                | `output/browser-integration-observation/4b552120-fe90-4a2c-8a73-77ec0c375b99/result.json` and `youtube.png`                                                                                        | Earlier zero MusicMute controls, one HaramMute control, 19.021s paused; superseded for loading status by the user's manual load; no replacement playback attempted                                                                            |
| Real pause/seek/rate/volume/stop/navigation/ads/two-tab playback | Historical 679 hidden/reopened continuing playback; prior cb26 actual HTTPS cached Play/Pause/Home/ArrowRight/1.5× resume/1× Stop; earlier failures retained                                       | Partial controls; physical listening, measured >30-second offscreen closure and restart/ads/two-tab acceptance remain open                                                                                                                    |
| Speech/music quality, selected-track matching and lip-sync       | No current audiovisual acceptance                                                                                                                                                                  | Pending                                                                                                                                                                                                                                       |
| Clean-user/quarantine/notarization/store acceptance              | No fresh-machine or public-release proof                                                                                                                                                           | Pending                                                                                                                                                                                                                                       |
| MusicMute online / Windows offline                               | Future provider interfaces                                                                                                                                                                         | Disabled                                                                                                                                                                                                                                      |

No backend/provider, fleet service, credentials or R2 data were changed for this
component. No commit, push, publication or deployment was performed.

## Historical 679-era source checks

The then-current panel/invalidation source passed `npm run verify`: **448 tests in 21
files**, **67 linted files with zero warnings/errors**, typecheck, build and
formatting, with 88 source pins in `source-verify.json`. Actual-handler tests keep preparation/playback clocks and generations
unchanged when the active waveform, close button or Escape hides controls.
Progress/READY/playback do not reopen dismissed controls; explicit Cancel/Stop
still restore original audio. Pointer capture, clamping, keyboard movement, Home,
resize, hidden reopen and remount/invalidation disposal have unit coverage.
Context-invalidated synchronous throws and rejected messaging retire old loops,
restore mute and pause active ownership. Diagnostic delivery/capture safely
contains both failure forms, excludes raw exceptions and removes its handlers.
Only the safety Refresh YouTube notice may reopen a dismissed invalidated panel.
Ordinary transient receiver errors remain retryable.

The earlier recovery/context audit passed `npm run verify`: **379 tests in 19
files**, **64 linted files with zero warnings/errors**, typecheck, build and
formatting. `recovery-source-verify.json` records the successful command and 80
source hashes, with post-fix browser validation and extension-loading harness
explicitly false. The bounded recovery change joins an in-flight media load,
uses the latest clock for its current owner and permits one reload after a clock
transport failure; a failed reload reaches the existing safe error boundary.
Regression tests cover recreated-listener races, newer clocks during async
queries, joined failures and successor ownership. Safe fixed browser context and
numeric generation survive diagnostic writer/reopen/export projection; arbitrary
private strings remain excluded. This is source proof, not Chrome acceptance.

The final installer/noindex audit ran `npm run verify` successfully: **374 tests
in 19 files**, typecheck, **64 linted files with no warnings/errors**, source build
and repository formatting. The build script writes `dist/`; it does not package
or install an app. Installer tests import only guarded helpers and create owned
temporary filesystem fixtures. Spotlight returned exactly
`/Applications/MusicMute Local.app` before and after the checks. No additional
visible app copy was created.
This completed audit predates the actual Chrome recovery finding and the source
fix; it must not be presented as post-fix verification.

The 53 installer tests preserve the default home target and admit only the exact
explicit `/Applications` option. They fence root-owned real system-parent
permissions, arbitrary/duplicate arguments, private backup ownership/type/links,
group/world writes, same filesystem and replacement identity. Exclusive noindex
directory creation, concurrent reuse and refused foreign-shaped fixtures preserve
existing bytes. Source tests do not establish actual promotion/rollback execution;
the finite installer-recovery qualifier was updated only to find preserved apps
in both the parent and new noindex folder, and was not rerun by this audit.

`npm run verify` checks the shared protocol, setup, diagnostics, process handling,
cache and playback code. Mocked DOM/Chrome/audio tests exercise the actual content,
background, popup and offscreen handlers. They cover late READY after Stop/Cancel,
same-ID video replacement, pending audio-load handoff, original mute preferences,
ownership loss, stale clock failures, helper/offscreen loss and bounded recovery.
The ad checks release/reclaim owned original mute and preserve the user's
preferences. Source tests do not establish actual Chrome decoding, autoplay,
YouTube ad transitions or audible synchronization.

Job tests cover cancellation during retained copy/publication/pruning, unsafe
cache paths, model mismatch and recipe changes. Recipe **8** refuses recipe **7**
and older cache reuse while preserving their files. Result metadata does not grant
a model-verification claim: only provenance written by the trusted native pipeline
after existing model/output validation can be replayed. Otherwise valid
current-recipe results without verification provenance remain playable without
being upgraded to verified inference; old recipe versions remain ineligible.
A cache hit never claims a new inference run.

New diagnostic records and reports identify their recorder's software version,
packaged/development scope and expected model. A safe owned inventory fingerprint
is optional. Legacy records retain unknown identity, and historical records keep
their own identity. Generic browser events cannot set recorder identity or model
verification. Combined app summaries, including setup and UI history, are bounded
to the complete 64 KiB reply envelope; compaction marks coverage and leaves the
full saved export unchanged. These details are specified in
[bridge.md](bridge.md) and [diagnostics.md](diagnostics.md).

Swift's current proof compiles the actual presentation source alongside its
models, process bridge and journal with Swift 6/warnings as errors, runs native
checks and compiles the production application separately. Eight deterministic
inventory replacement cases cover directory/path replacement and safety changes
before digest acceptance. It uses owned temporary fixtures, not environment
injection into the production bundle lookup. It does not launch the installed app
or prove its visible Diagnostics identity labels.

## Historical source-audio evidence at that checkpoint

Acquisition selects
`bestaudio[protocol=https]/bestaudio[protocol=http_dash_segments]`, accepts one
exposed language/preference profile and refuses described/ambiguous tracks or
mismatched selected metadata. Only the accepted format reaches the downloader
through bounded ephemeral stdin with `--load-info-json -`. Webpage/original/
additional URLs, entries and private extractor fields are omitted, preventing a
silent second webpage extraction. Googlevideo HTTPS and materialized DASH paths
are validated; returned identity is checked before inference.

The owned guarded bootstrap now inspects **already returned** raw player responses
and preserves an optional full upstream `audioTrack.id` and raw `audioIsDefault`
boolean only through a conservative unique transport match. It delegates to the
pinned extractor once; it does not make an extra extraction request, patch wheel
archives, clone the extractor or infer a full ID from language/itag alone.
Ambiguous/conflicting evidence stays unknown. Distinct known full IDs sharing the
same language/preference are refused. Missing raw fields remain supported and
unknown. Known evidence cannot be silently changed or dropped in the projected
transfer result.

Bootstrap SHA-256 at that checkpoint:
`67d9b2eb34b407167f1590fe711fc73f5539d7a814a90cb90b97649b313ee8e6`.
The package retains pinned official yt-dlp **2026.08.19** and yt-dlp-ejs **0.8.0**
wheels, read directly by bundled Python with `-I -B -S`. Bundle/archive/EJS checks
run before execution; no pip, external site-packages or plugins are needed.

The 36-check qualification exercised the actual pinned selector, positional
format-ID handling, one-entry replay, strict failure without re-extraction and an
offline dummy transfer through the actual `after_move` template/current TypeScript
validator. Its negative control retained a webpage URL and exposed one blocked
re-extraction attempt. Across the seven cases, network and child launches were
zero; 21 Python `file`/`uname` startup probe attempts were blocked before launch.
The report explicitly sets acquisition, inference and browser playback false, and
full underlying/live selected-track verification false.

Diagnostics expose only `source_audio_track_id_known` and an optional
`source_audio_is_default`; raw IDs are excluded. A raw default flag is extractor
evidence, not an original-track or browser-selected-track claim. Recipe 8's legacy
`source:"default"` cache policy label is not such a claim either. Equal durations
and successful separation do not establish matching audio in the real player.
C4/D14 remain open until that match and audiovisual behavior are qualified.

## Historical 679 package and prior native acceptance

Generated `67960e3f` is
`output/macos/build-67960e3f-97ec-44bf-a29b-662357b28677.noindex/MusicMute Local.app`.
Its creation record reports **1,113,057,345 bytes** and **303 ARM64 native files**,
ad hoc signed and not notarized. The canonical same-path installation passes 21
source/package/installed hash checks and strict signatures. Inventory prefix is
`1a3f1f61a192`; Spotlight returns only `/Applications/MusicMute Local.app`, the
previous app remains in its private backup and registration is unchanged.
Reopened actual Overview shows Mac ready. `installed-alignment.json` in the new
panel proof directory records this scope. New narrow panel live YouTube checks
have their own browser evidence below; they are not inferred from package
creation or installed hashes.

### Prior cb26 package and installation

The prior generated package is
`output/macos/build-cb26daf3-9230-4fa3-8afa-35c0dfb0c28b.noindex/MusicMute Local.app`,
also recorded by `latest.json` and its matching creation record. It contains
**1,113,043,305 bytes** and **303 ARM64 native files**. The initial default packaging
attempt failed with `ENOENT` because its development downloader source was
absent. Packaging then succeeded using an explicitly selected, verified private
read-only projection of the previous packaged runtime/downloader. This packaging
setup failure is not a consumer processing failure. The reused runtime was already
normalized, so this build removed zero additional absolute RPATHs. It remains ad
hoc signed and not notarized.
It excludes model weights and fleet worker state. Runtime files come from an
allowlisted read-only build source; the packaged application resolves its own
Node/Python/FFmpeg/downloader/MPS engine. Its model is downloaded separately from
its approved owner-hosted URL and verified at **66,759,214 bytes**, SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.

The prior cb26 app was installed at
`/Applications/MusicMute Local.app`. The updated alignment proof passes **21
checks**: 18 source/package/installed files plus package/installed main binary,
audit and Info.plist. Its strict signature passes. The prior canonical app is
preserved at
`/Applications/.musicmute-backups.noindex/MusicMute Local.previous-3898d7a6-e68b-4d78-9db3-c6eea28f26a5.app`;
the backup directory is private mode 0700 and Spotlight returns only the canonical
app. Registration is unchanged by this same-path update. Direct computer use
observed the updated Overview **Mac ready**, as saved in `updated-app-ready.ax.txt`.
Its Diagnostics shows the new inventory prefix **2d118fd17397**, expected model
**ce74** and retained earlier errors. Fresh Finder navigation identifies exactly
`/Applications/MusicMute Local.app`; an earlier stale window handle was not used
as the final location evidence. These focused observations do not establish a
new full diagnostic export or post-fix Chrome success.
The recorded installed main SHA-256 is
`7a892061f5b964d43b2f2c50d7a4cfec20003c4ae86500513230bfed5b52db99`;
the inventory SHA-256 is
`2d118fd173977cfa7ac2032525c6d8ce081eaeb464082eb7bf72d67c23135259`.
These checks explicitly do not claim post-fix browser playback or listening.

Before this update, the canonical global app's connection was repaired and Setup
observed runtime/model/connection Ready. The former home-directory primary and previous `88495ce9` apps
were moved to owned
`~/Library/Application Support/MusicMuteLocal/retired-apps.noindex/`, preserving
them without copying or deleting. The earlier generated `cb7dec7c` build was
moved to its own noindex folder; its preserved creation record retains the original
pre-move path strings. The cleanup proof records model,
cache, logs and the Chrome-loaded extension folder unchanged, obsolete launch
entries unregistered and no app deleted. Earlier native/cache/write-fault/UI
qualification remains inspectable below, with its original `cb7dec7c` identity
and execution scope; it does not establish new-build acceptance.

Model/cache/logs live under
`~/Library/Application Support/MusicMuteLocal/`, separate from fleet state.
Native Messaging uses `com.musicmute.local` and extension ID
`dclpfemnpknfdlpcbfcjkmdbnociippd`. Readiness/registration observations alone do not
prove that regular Chrome has loaded the matching extension. The user separately
confirmed initial manual loading during this continuation. Following the same-path
cb26 update, the user completed Reload and the partial live control cycle below.
The user completed the new 67960e3f Reload and ordinary YouTube refresh; the new
compact panel's narrow live UI evidence is recorded below.

### Prior cb7 native YouTube preparation

The fresh installed `cb7dec7c` native run passed one public 19-second YouTube
acquisition, actual Kim/MPS separation and protected HTTP 206/1,024-byte Range
retrieval in **19.021 seconds**. The output is **19.005556 seconds**, trim false.
The report identifies `PACKAGED_APP` and explicitly sets browser playback false.
Readiness/cache admission reached metadata at 7.023s, download at 9.788s,
processing at 10.966s and READY at 18.988s; these are elapsed milestones, not
independent stage durations.

Persisted `local_pipeline_completed` and `job_ready` records contain the recorded
software version **0.1.0**, prior cb7 inventory fingerprint and verified
model pin. The expected and verified model match separately. This source has
**full track ID unknown**, recorded as `full_track_id_known:false` with
`extractor_metadata_only:true`. No original/default/player-selected track claim
is made. A successful native run and range retrieval do not establish audible
replacement, listening quality or synchronization on the real player.

### Prior cb7 recipe-8 cache replay

The qualifier passed **15 checks** across two fresh installed hosts in **343ms**;
replays took 166ms and 167ms. Both created fresh job IDs/capabilities, served
matching retained bytes with HTTP 206/1,024 bytes and refused a missing capability
with HTTP 403. Each durable job log contains that run's cache lookup, validation and
media-grant timings, one measured cache hit, its cb7 recorder/inventory identity
and verified-model provenance from the actual native result. It emits no current
inference events or historical inference timings as new work.

Both hosts exited zero with empty stderr and no owned process groups or scratch
remaining. Installed host bytes and source cache bytes/metadata remain unchanged;
forbidden network/tool attempts were zero. Readiness, acquisition, inference and
browser playback are explicitly bypassed. This is cache replay qualification,
not ordinary startup timing or real-player acceptance. An initial invocation
omitted its required video argument and failed before any process/check; it is a
qualifier argument error, not an installed product failure.

### Prior cb7 installed write-fault/recovery qualification

The fresh installed host passes **47 checks in 4.694s** with injected scratch and
retained-media write denials (`EACCES`), denied log writes and a real 48-byte log
prefix followed by injected `ENOSPC`. Safe FAILED jobs never obtain media grants;
uncached/cached fixture successors reach READY and serve matching ranges. A healthy
restart restores recording, repairs exactly 48 torn bytes, preserves explicit
incomplete-history coverage and replays unchanged cache bytes.

Those report/event identities match the prior cb7 package fingerprint. All four
fixture scenarios report `fixture_verification_claimed:false`; copying an actual
native output into a fixture does not create trusted pipeline verification
provenance. Successful fixture/cache events cannot upgrade themselves to model
verification. This directly qualifies the earlier provenance regression in the
installed native host, alongside source coverage.

All owned native sessions exit zero with empty stderr, no forced shutdown and no
remaining process groups/scratch. Forbidden network/tool attempts are zero; host
bytes, source proof audio/metadata and the strict installed signature remain
unchanged. Readiness, acquisition, inference and browser playback are bypassed;
the disk is not physically filled and consumer/fleet state is unchanged. Fault
fixture timings are not normal processing performance or audiovisual proof.

### Prior cb7 installed UI and private diagnostic export

Direct computer use observed the actual installed `cb7dec7c` Overview showing
**Mac ready**, Setup showing runtime/model/native connection Ready, and Diagnostics
showing its report recorder **v0.1.0 / Packaged app**, inventory prefix
**c8fd39d67bf6** and expected model prefix **ce74**. The expected-model disclaimer
is visible; these labels do not claim a new inference or loaded Chrome build.

The actual Export action displayed its local save notice. Its full private JSON is
**12,410 bytes**, mode **0600**, same-owner with link count one. All **15 focused
checks** passed: schema/privacy/full export, recorded report/setup/Swift `app_started`
identity matching the installed audit, legacy UI/setup identity remaining unknown,
retained setup alerts and absence of raw URLs/personal paths or an unproved
`verified_model_sha256`. The older `TOOL_TIMEOUT`, `CANCELLED`, `TOOL_TIMEOUT`
alerts remain visible; successful new activity does not hide them.

Screenshots and AX text for Overview, Setup, Diagnostics and export are saved
beside the inspected result; `export.png` and `export.ax.txt` show the save notice
and identity labels. Readiness returned Ready too quickly for a distinct transient
checking-state observation. This run therefore does **not** prove its busy
rendering, actual-operation cancellation, full keyboard/VoiceOver acceptance,
Chrome loading or browser playback. The native short run above used separate
owned proof state; this ordinary UI export is not relabeled as its inference log.

## Real Chrome loading and audiovisual gate

Pre-load ordinary HTTPS computer use observed the requested short public YouTube page with
zero MusicMute controls. The observation was saved from the current tool result
before that owned tab was closed; it does not report a still-open/live test tab.
The existing HaramMute control is not MusicMute acceptance.

Automatic approval review rejected navigation to `chrome://extensions` because
the allowed browser surface supports HTTP/HTTPS only. Extension loading through
CDP, another browser, shell, indirect UI or the existing automated E2E loading
harness is not an allowed workaround. **Do not run that harness in this session.**
The user completed initial manual loading of the installed app's
`Contents/Resources/extension` folder into regular Chrome. The app offers Reveal
folder and Copy path for fresh installations. This resolves loading, without
authorizing that harness or claiming automatic installation. The app has since
been updated at the same path. The user completed the prior cb26 Reload and
refreshed YouTube; the user also completed Reload of the new 67960e3f update.
Its refreshed-page compact panel UI check passed within the narrow scope below.
Older injected scripts
cannot be retroactively patched by changing the bundled files.

### Actual regular Chrome observations before the recovery fix — 2026-10-02

The saved `root-live-observations.json` records the real injected MusicMute icon,
the Separating vocals panel with the original video paused, and the Voice-only
playback panel with original audio muted. Consumer native jobs reached READY
through the packaged app. The first two cold sources were **226.621 seconds** and
**219.521 seconds**, preparing in **23.270 seconds** and **22.229 seconds** from
precise job elapsed metrics. Their initial cache replays also reached READY,
making four initial ready jobs. The outputs measured 226.603560s/219.509841s;
these duration observations do not establish matching speech or physical lip-sync.

Initial scoped telemetry reported **31 clock-drift samples, 2–112ms**. The later
saved consumer report includes retries and a short-video test: nine READY jobs,
six cache hits, 33 drift observations and 11 diagnostic errors. Its retained event
array is explicitly truncated/incomplete; counters and the initial scoped audit
are not a complete event-by-event history. Media-clock drift is not measured
speaker/display latency, listening quality or a leak/long-playback guarantee.
The report identifies packaged v0.1.0 and inventory `c8fd39d67bf6`; observed
trusted native pipeline records retain their verified model provenance. Neither
the root observation nor export claims physical listening or original-track match.

The long-pause/retry test found repeated **AUDIO_CONTEXT_LOST**. The page displayed
Playback paused, the video stayed paused and its prior original mute state was
restored, but clicking retry did not recover replacement playback. A separate
navigation recorded one generic **UNCAUGHT_ERROR**; the captured older record
does not identify a trusted browser context. Actual native Diagnostics displayed
both failures, and the actual GUI Export produced a local **461,112-byte** report
as recorded by `consumer-export-proof.json`. The diagnostic system captured a real
consumer failure, but no recovery fix is accepted from these pre-fix observations.

Bounded recovery and safe browser-context diagnostic retention passed source
checks and were installed in `cb26daf3`, as evidenced above. The user's later
manual Reload and partial control observations are recorded below; measured
offscreen closure and the full long-pause/retry/navigation matrix remain open.
Actual audible replacement,
selected source track, listening, full player operations and lip-sync still need
their own acceptance; native READY/Range and historical fixture tests do not close
those gates.

### Prior cb26 actual cached controls after manual Reload

The actual HTTPS cached 219.521-second source reached the Voice-only panel.
Play showed original video `muted:true` and playing. Pause was observed at
82.98 seconds; Home moved to 0 and ArrowRight to 5 while it remained paused and
muted. Resume at 1.5× showed `paused:false`, `muted:true`, rate 1.5 and time 5.020.
The rate was restored to 1× and explicit Stop restored `muted:false`.
`prior-cb26-live-playback.json` records this browser cycle.

This demonstrates those prior-build controls, not physical listening, selected
audio-track matching, measured >30-second offscreen closure, browser/helper
restart or complete navigation/ads/two-tab acceptance. The adjacent
`prior-cb26-host-summary.json` contains latest bounded native history and is not
correlated to this UI cycle. No zero-error claim is derived from it.

### New compact panel and reload-context fixture

The current 304px panel starts at the top right, with a header movement handle
and separate Hide MusicMute controls button. Active waveform/close/Escape change
visibility without Stop/Cancel, generation, mute or pause changes; Escape returns
focus without scrolling. Dismissal persists through job/progress/READY/playback.
Pointer movement is clamped; arrows move 8px, Shift moves 24px, and Home restores
the anchor. ResizeObserver reclamps the player/panel, while hidden/remounted or
invalidated controls release capture/listeners/observers.

The ordinary HTTP fixture uses the actual compiled content.js and CSS with a
fake Chrome runtime. It observed hide/progress/READY/playback/reopen, keyboard
movement/reset, 430px/320px resize and icon centering. It does not load an extension
or provide real replacement audio. Native pointer UI attempts missed the handle;
successful drag is covered by the helper's 24 cases and actual-handler unit tests
only. Hidden fixture clocks advanced from 9 to 2,394 while Start remained one and
Stop/Cancel remained zero; explicit Stop later counted one and restored mute.
The user completed Reload after the new same-path installation and refreshed
ordinary YouTube; narrow live panel evidence follows. A screenshot
showing the old send line 111 stack may be retained history or a stale retired
script and is not treated as a newly reproduced failure or success.

### Historical 679 actual YouTube compact panel after refresh

The refreshed HTTPS page exposed the new waveform's matching `aria-controls` and
`aria-expanded` attributes. A cached **219.521-second** source showed Preparing.
The close button hid controls while the video played at **142.796858s** with
`paused:false` and `muted:true`; it was still hidden and playing at **176.52433s**,
with no observed Stop or restart. After pause/reopen at **176.588492s**, the
waveform remained pressed and original audio muted. This directly demonstrates
that hiding controls does not stop the observed replacement session.

Actual keyboard ArrowLeft and ShiftDown moved the panel within the
**1282.975×721.669px** player. Escape hid it and returned focus to the waveform
without changing the session; Home restored the **12px top-right** CSS anchor.
The visible panel measured **304×127.70px**; the actual icon's center offsets in
both axes were **0**. Cases and image are saved as `real-youtube-panel-cases.json`
and `real-youtube-compact-controls.jpg` in the panel proof directory above.

The final `real-youtube-console-summary.json` includes **491 bounded retained
records**, all from **13:52:36–13:53:33 UTC**; the earlier snapshot had 497.
Its cutoff is the installed alignment time,
**14:19:33.362 UTC**; there are zero warning/error entries after that cutoff in
this result. This is not a cleared extension history, a complete Chrome profile
audit or an assertion that the whole session had no errors.

Synchronous/rejected context invalidation and diagnostics cleanup pass source
tests. Actual Chrome context revocation while playback was active showed the
disabled waveform and actionable Refresh YouTube notice; the video was
`paused:true` and `muted:false`. The saved case
`actual-context-invalidated-safe-pause-original-mute-restored` and
`real-youtube-reload-notice.jpg` preserve that safe restoration.

An ordinary HTTPS refresh and retry then reached cached Voice-only playback at
**93.725681s**, `paused:false` and `muted:true`. Final Pause/Stop at **135.563223s**
left `paused:true`, `muted:false` and waveform `aria-pressed:false`. This directly
qualifies the observed context-loss/refresh/reconnect/Stop cycle; it does not
establish a complete browser restart, offscreen closure or sleep/wake matrix.
Native pointer UI
attempts missed the handle, so no successful actual drag is claimed. Physical
voice quality, player-selected source identity, measured offscreen closure and
the full navigation/restart/ads/two-tab matrix remain open.

## Historical records — artifacts currently unavailable

The earlier ledger recorded the following same-machine results. Their referenced
ignored reports/screenshots are absent as of this update, so the numbers below
are historical context rather than currently inspectable acceptance. Do not use
these rows as proof for `cb7dec7c` or the current source.

| Historical scope                          | Earlier record                                                                                                                 | Practical limit                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Installed build `55d23ba0`                | 1,112,802,640 bytes/303 ARM64 files; 18-file alignment/strict signatures; 19.267s native short run                             | Recipe 7; browser playback false; old package/proof absent                                  |
| Installed build `88495ce9`                | 22.179s public 19-second native acquisition/MPS/Range; 19.005556s output/trim false; 21 qualified timing labels                | Before current diagnostic identity/provenance/recipe-8 package                              |
| `88495ce9` cache/fault fixtures           | 13 cache checks/321ms; 39 write-fault checks/4.629s                                                                            | Readiness/acquisition/inference/browser bypassed                                            |
| `88495ce9` actual native UI/export        | Overview/Setup/retained alerts, 11,297-byte private export/eight checks                                                        | Transient readiness state not observed; current identity display untested                   |
| Earlier first setup                       | App-owned model downloaded/verified, per-user registration ready                                                               | Development Mac; not a fresh OS user/quarantined machine                                    |
| Native preview/UI                         | 12 synthetic preview checks: global Cancel/Escape/scroll, disabled opacity, retained alerts, unavailable history and AX labels | Synthetic preview; full keyboard/VoiceOver/actual command cancellation pending              |
| Relocated short Kim/MPS engine            | Ten-second synthetic speech/tone; 441,000 equal normalized pre/post-trim samples; zero removed; 8.173s                         | Engine fixture, not YouTube/player/listening proof                                          |
| Long synthetic Kim/MPS engine             | Five minutes: 21.999s/1.135 GiB peak RSS; two 15-minute runs: 49.108s/48.893s and 2.415/2.319 GiB                              | Synthetic tone/speech; fresh engine each run, no sustained browser or leak proof            |
| Isolated setup/foreign registration       | 12 CLI checks and 19 installed conflict/recovery/HELLO checks with isolated HOME and denied external reads/network             | Verified model cloned; not a first download/fresh OS user/browser test                      |
| Model interruption/retry and app movement | 12 model recovery checks and 12 signed-copy relocation/registration-repair checks                                              | Chrome's remembered path and fresh-machine acceptance untested                              |
| Actual disposable installer failures      | 45 promotion/validation/rollback/conflict/retry checks, preserving candidates and originals                                    | Injected filesystem failures, not physical full disk/public distribution                    |
| Download/separation cancellation          | 16 checks, stage cancellation without grants/orphans, then native successor READY/Range                                        | No browser; current source/package needs affected qualification                             |
| Chrome fixture                            | 19 isolated Chrome 154/source-host checks, maximum synthetic clock drift 53ms under a 250ms fixture bound                      | No YouTube/inference/packaged host; report absent; automatic loading harness cannot run now |
| Older developer/standalone native runs    | About 64.817s/75.989s total; older tool probes around 15–17s, later wheel native runs about 19–24s                             | Conditions varied; no long-podcast SLA or speaker/display latency proof                     |

Nested model-load/separation/encoding timers overlap their parent processing timer
and cannot be added independently. RSS comes from the named process; five-second
samples have limited coverage. End-of-run MPS allocation/driver values are not GPU
utilization or peak GPU memory. Two engine runs do not prove leak absence.

Earlier fault checks injected scratch/media `EACCES`, log denial, partial `ENOSPC`
and a torn tail, then observed safe fixture/cache/Range successors and process
cleanup. They did not physically fill the disk or run readiness/acquisition/MPS/
Chrome. The older `DISK_SPACE_LOW` startup refusal separately verified admission,
not write recovery. Prior cb7 write-fault proof is retained above; the updated
build's wider fault acceptance remains separate.

Earlier test fixes worth retaining: `--no-plugins` was replaced by supported
`--no-plugin-dirs`; capability checks were added. A test supplied a noncanonical
Origin with a trailing slash and was corrected after the server refused it.
Installed Python validation created signed-bundle bytecode with `-I` alone;
launchers/tests now use explicit `-B`/`-I -B`. These explanations are historical
root-cause context, not current reports or permission to mutate bundle contents.

## Remaining delivery and launch work

- Preserve the separate scopes of current c14116b8 package/install/receipt,
  historical 58d55f40 clean Prepare/synthetic native UI/registered-manifest
  protocol handshake, superseded 2ed, interim e2aa and all earlier native/cache/
  fault/browser records during any later acceptance audit.
- Preserve the narrow historical 679 panel and observed context-loss/refresh/
  reconnect/Stop acceptance; verify successful pointer drag separately.
  Retest measured long-pause/retry/navigation and restart boundaries.
- Extend the current c141 warm-cache YouTube playback-start evidence to uncached
  acquisition/separation and physically verified voice playback, then
  pause/seek/rate/volume/stop/navigation/ads/two-tab behavior.
- Qualify the source track against the audio selected in the actual player; assess
  Arabic/English speech/music quality, background singing and visible lip-sync.
- Complete native setup cancellation, actual browser Cancel and full
  keyboard/VoiceOver acceptance; current panel Escape has its own live proof.
- Qualify sustained five/15-minute browser playback, repeated-run resources,
  sleep/wake and browser restart before final duration/hardware promises.
- Complete fresh-OS-user/fresh-machine installation and the wider physical fault
  matrix; the historical 58d support-data reset on this development Mac is not
  that proof.
- Separately qualify notarization, Gatekeeper/quarantine, signed updates/rollback,
  licence/distribution conditions and Chrome Web Store acceptance before release.
- Enable online and Windows only after their own authenticated/native/source,
  installation, process-containment and playback acceptance.

## Historical 2026-10-03 installed cache/title update

See the [account-connected checkpoint](desktop-tasks.md#installed-cache-and-title-checkpoint--2026-10-03)
for final 929-test source verification, both native suites, build `afcd570c`,
the 29-check installed cache/Range/title/pin/pressure report and the actual
responsive Keychain-wait view. These scopes are separate from Chrome reload,
new authenticated account downloads, physical disk exhaustion, listening and
Google branding verification, which remain unverified or externally pending.

## Historical 2026-10-03 lifecycle/title build

The [current installed checkpoint](desktop-tasks.md#current-installed-lifecycletitle-qualification--2026-10-03)
records canonical build `82bd3515`, 985 TypeScript tests, both native suites,
full package/source alignment and strict signing, and the 36-check installed
cache/title/pin/pressure qualification. The native diagnostics export also passed
an actual UI check and private JSON inspection. Chrome baseline replay and
control visibility have their own earlier live proof; updated Chrome Reload/Stop
was still pending at that checkpoint. Saved sign-in later recovered and actual
owner native titles/playback passed; updated Chrome acceptance still needs manual
Reload. None of these checks establishes source
track identity, listening quality, physical disk exhaustion or notarization.

## Historical 2026-10-03 actual native guest cache replay

The [installed guest checkpoint](desktop-tasks.md#installed-native-guest-playback-checkpoint--2026-10-03)
adds actual Home/file/player/Stop/Library replay in the then-canonical Mac app,
with a separate private five-check report. The existing synthetic audio was
reused without inference; native pins, recency, scratch cleanup and preservation
of the selected original were observed. This closes that guest native workflow
only. Saved-account access and owner Library playback were subsequently verified;
updated Chrome Reload/Stop remains pending. The isolated 36-check report retains
its own scope and visual flags.

The [legacy guest title repair](desktop-tasks.md#existing-guest-youtube-title-repair--2026-10-03)
also has actual dated Library visual proof. Three exact verified YouTube records
received only public source-title metadata; audio and row timestamps were
unchanged. That guest repair has its own scope; subsequent signed-in proof is
recorded separately below.

## Historical 2026-10-03 actual signed-in native title and replay

The [owner replay checkpoint](desktop-tasks.md#actual-signed-in-native-title-and-cache-replay--2026-10-03)
records saved-session restoration, the exact reported YouTube title in the
actual Library/player, clock advancement, native Play/Stop pins, recency,
retained vocals and zero new processing. Its private eight-check report passes.
It does not assert a new upload, original-byte identity, listening quality or
mobile Library acceptance.

The [Chrome transition finding](desktop-tasks.md#actual-chrome-account-transition-and-stop-finding--2026-10-03)
records a separate actual cached READY, the account-change stale UI defect and
failed Stop disk-pin release in the currently loaded Chrome version. That
private report remains failed. Source fixes and a future package cannot replace
actual Reload/Stop acceptance; native successful Stop does not close it.

## Historical 2026-10-03 installed account cancellation update

The [latest installed checkpoint](desktop-tasks.md#installed-account-cancellation-update--2026-10-03)
records the account-change notification and cancellation/admission races fixed
through the existing protocol, **1,005 source tests**, new canonical build
`05a05b5c`, full package/source alignment, strict signing and its own passing
36-check installed cache report. Native Swift 6 compilation passed; native source
was unchanged from the previous passing suites. Three failed native computer-use
reconnections and the pending manual extension Reload keep newest-build live
native/browser acceptance open. The previous actual owner Library proof is
preserved under `82bd3515`, and the failed actual Chrome Stop report remains
failed. No account upload, listening or notarization claim is added.

## 2026-10-05 playback performance implementation

Cloud YouTube processing now submits the canonical URL to the backend import
flow, without acquiring, decoding, converting or uploading the original on the
Mac. Server vocals retain streamed size/digest verification. Bounded local
integrity receipts require unchanged private file identity. Local cache hits
skip inference readiness and foreground account restoration; misses use a
persistent model process. Shared original reuse remains backend-authorized.

Validation on this implementation:

- `npm run verify`: 65 suites, 1,939 passed, four skipped, plus typecheck,
  lint, production build and formatting.
- `npm run test:native`: four native suites passed.
- Python runtime suite: 48 passed, 29 skipped.
- `npm run test:e2e`: 27 checks, zero errors in installed Chrome with synthetic
  fixtures (`output/e2e-1791222505891/results.json`).
- Backend `pnpm run verify`: 1,643 unit and 208 HTTP tests passed, with build
  and repository checks. Additional imports (40), processing (19), and community
  integration (14) checks passed.
- Installed model/runtime with synthetic eight-second audio: 7,284 ms cold,
  1,034 ms warm in the same process, and 1,027 ms through the full local provider.
  Model load fell from 5.486 seconds to 0.000006 seconds. Evidence:
  `output/local-engine-cc3f36f2-524f-4e21-a8a8-64125b72f4b7.noindex/result.json`.
- Authorized CapRover deployment advanced API version 114 to 115. Read-back
  confirmed version 115, one instance and unchanged application settings.
  Live/ready health and app-policy returned 200; unauthenticated source delivery
  returned 401. This is not authenticated R2/cloud-processing proof.

No live YouTube timing, listening assessment, fresh-user runtime download,
notarization or newest-package installation is asserted. The DMG is intended
for this already prepared Mac; its runtime download URL is still a placeholder.
The user will install the package and reload the extension.

Final local artifact: `MusicMute-Local-0.1.0-1791223412-arm64.dmg`, 4,730,673
bytes, SHA-256 `40d605e945f8b9c852c27efbe401019d19475726370e2e91dce79e2a085df4da`.
Build `33ec6821-1f27-4aba-968a-d07202ded0aa` passed `hdiutil verify`, read-only
mount inspection, strict deep signature verification, and comparison of every
app file against the packaged source bundle. The exact packaged native host
returned `HELLO ready=true` and exited zero with no stderr in an isolated home
with network and real user-state/Keychain access denied. That cold full-runtime
verification took 51,106 ms; it is not a warm startup or processing benchmark.
Optional receipt authentication now uses a noninteractive data-protection
Keychain query, avoiding the legacy default-Keychain creation dialog. When the
Keychain is unavailable, full verification remains required. The final four
native suites passed again after this change.

## 2026-10-05 account-free local processing repair

The installed app's `desktop-public-config.json` was absent. A fresh local
YouTube request initialized the optional community client through
`publicApiOrigin`, which raised `ACCOUNT_NOT_CONFIGURED` before local processing.
Local cache hits had hidden this dependency. The provider now proceeds with
local acquisition/separation when optional shared configuration, guest credentials
or service access is unavailable. Native duration discovery also falls back to
local metadata. Cloud account authorization remains unchanged.

`npm run verify` passed: typecheck, lint, 65 suites with 1,947 tests passed and four
skipped, production build, and formatting. Eight new regressions cover a fresh
signed-out native request with the real missing-public-config path and zero backend
calls, Chrome provider fallback, guest-session network failure, cancellation, and
no repeated processing after local work starts. Existing shared artifact/timeline
validation tests still pass. Processing in these tests uses synthetic fixtures;
they do not assert live YouTube acquisition or newest-package installation.
