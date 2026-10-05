# Direct-download macOS release

MusicMute is distributed as a DMG outside the Mac App Store. Notarization checks
security and signing; it does not create an App Store listing. This pipeline follows
Apple's [notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[issue-resolution guide](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
and [packaging guide](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).

## Release protections

`package:macos:release` requires an explicitly selected valid Developer ID
Application identity. It signs embedded native code individually before sealing
the app. It checks the certificate chain/Team ID, secure timestamp, Hardened
Runtime, macOS SDK in each slice and final entitlements. Debugger entitlements
are forbidden. Node retains JIT; Python retains executable-memory permission.
Release Python keeps library validation enabled because bundled native modules
share the signing team. Actual inference must qualify this configuration.

Development `package:macos` keeps its local signing behavior and `latest.json`.
Release writes `latest-release.json` and a final external signed-file inventory;
it cannot become the development installer's default accidentally. An embedded
inventory is diagnostic evidence, not a signature-verification substitute.

FFmpeg/FFprobe, Node, Python, ML dependencies and local YouTube acquisition tools
are delivered as a separate content-addressed runtime ZIP. The app seals the
exact URL, byte count, SHA-256, signing team and full file inventory in
`runtime-bootstrap.json`; it contains no expanded `Contents/Resources/runtime`
tree. The ZIP is release output, not an optional dependency: it must be retained,
notarized as its own code-bearing submission and hosted at its sealed immutable
HTTPS URL before distribution. Required notices/source information are covered
in [THIRD-PARTY.md](THIRD-PARTY.md).

Kim Vocal 2 weights also stay outside the DMG. First Prepare downloads and
verifies the runtime, then downloads the approved owner-hosted model when it is
not already verified. Runtime releases, models, account sessions, cache and logs
live outside the signed app and survive app replacement. Mutable user state
requires current-owner private permissions.

Each `package-result.json` includes `steady_state_bytes`: exact app bytes, runtime
installed bytes, the fixed approved 66,759,214 model bytes and their total for
one app + one runtime release + one model. This base processing footprint is
informational, not a hard cap. It excludes the runtime ZIP, setup scratch/headroom,
additional retained runtime releases, cache, logs, diagnostics, pending uploads
and user results.

## Build and qualify

Use the component README's approved runtime/downloader/public configuration
inputs. Set `MUSICMUTE_MAC_SIGN_IDENTITY` to the selected certificate SHA-1 and
`MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL` to the publisher-owned immutable HTTPS
runtime directory. Add only required CDN redirect hosts through
`MUSICMUTE_RUNTIME_REDIRECT_HOSTS`, then:

```sh
npm run verify
npm run test:native
npm run package:macos:release
npm run test:release-runtime -- --app /absolute/release/MusicMute\ Local.app --model /absolute/verified/Kim_Vocal_2.onnx
node scripts/qualify-app-relocation.mjs --app /absolute/output/macos/build-UUID.noindex/MusicMute\ Local.app --model /absolute/verified/Kim_Vocal_2.onnx
```

For a release that changes only app code, reuse the exact runtime from a prior
Developer ID package under the same Team ID:

```sh
MUSICMUTE_RUNTIME_REUSE_PACKAGE_RESULT="/absolute/output/macos/build-PRIOR-UUID.noindex/package-result.json" \
  npm run package:macos:release
```

This skips current runtime/downloader/YouTube staging and runtime Mach-O
re-signing, while app and Sparkle code are still rebuilt and timestamp-signed.
The prior package result, canonical sibling thin app, embedded/sidecar manifest
and runtime ZIP must all remain present and owned safely. Packaging rechecks the
exact hashes, extracted inventory, content-derived ID and code signatures, and
fails closed unless runtime API, worker source version, Developer ID mode and
Team ID match. It copies the unchanged ZIP and manifest into the new build root
and records the prior result/build/version in `runtime.reuse_source`. Supplying a
runtime download base or redirect configuration is optional on this path. Each
supplied value is independently validated against the prior sealed manifest.

Do not use artifact reuse after changing runtime, engine, downloader or YouTube
tool inputs. Advance the worker runtime source version and run the normal fresh
runtime package flow instead. A successful reuse package still needs the same
qualification and release gates as any other release.

Runtime qualification uses synthetic speech/music and a verified local model in
private disposable state. It denies network and bundle writes, runs actual signed
FFmpeg/Python/Torch/MPS inference, requires the complete unchanged timeline and
rechecks the signature. It uses no user audio or Chrome profile and does not enroll
a worker. It is not listening, fresh-Mac or notarization acceptance.

Relocation qualification also requires the exact app inside its generated
`build-<UUID>.noindex` directory, with the sibling `package-result.json`, runtime
ZIP and bootstrap manifest intact. It verifies and stages that one runtime in
private disposable state, proves both app locations remain thin, reuses the same
external runtime before and after the move, repairs only the disposable Chrome
registration and re-audits the runtime afterward. An installed app without its
package artifacts is intentionally not accepted as release-gate input.

## Prepare, submit and resume

Store notarization credentials using interactive `notarytool store-credentials`
in a local Keychain profile. Never put passwords/private keys in this repository,
the app, extension, reports or command arguments. The release tool accepts a
profile name only; credential-bearing options are rejected.

```sh
npm run release:macos -- --package-result /absolute/build/package-result.json --identity SELECTED_CERTIFICATE_SHA1 --prepare-only
npm run release:macos -- --release-root /absolute/prepared/release-UUID.noindex --submit --keychain-profile MusicMute-Notary
npm run release:macos -- --release-root /absolute/prepared/release-UUID.noindex --resume APPLE_SUBMISSION_UUID --keychain-profile MusicMute-Notary
```

Preparation creates a signed UDZO candidate with an Applications drag target and
installation instructions, and copies the exact runtime ZIP and manifest into
the durable release root. `public_ready` remains false. Before upload, the tool
durably records each exact candidate hash and intent. The DMG and runtime ZIP are
submitted to Apple independently, with separate persisted submission IDs and
bounded status/log reads. An ambiguous upload is never automatically repeated:
recover its ID from Apple's history and resume those exact bytes. Logs retain
only redacted issue categories and safe bundle paths.

Only Apple's `Accepted` result for both exact artifacts permits completion. The
DMG is stapled; ZIP archives cannot be stapled, so its accepted submission ID and
digest remain the runtime ticket evidence. Ticket validation, signature
verification and Gatekeeper assessment of the DMG and contained app must pass.
Even then `public_ready` remains false until quarantined clean-user app launch,
runtime Prepare/relocation and the other recorded release gates pass. Invalid
results, unfinished scans, missing authentication and failed checks remain
false. Runtime, browser and fresh-user acceptance stay separate evidence. Do not
modify accepted ZIP bytes, signed app contents or a stapled DMG afterward.

## User installation

1. Open the DMG and drag its single app to Applications.
2. Launch that copy and choose **Prepare my Mac**. The app installs its verified
   runtime and then prepares the model without administrator permission.
3. Follow the app's separate Chrome unpacked-extension instructions. Chrome Web
   Store distribution is a separate delivery task.

Do not disable Gatekeeper or remove quarantine. A normal first-open confirmation
can remain for an identified notarized download. Validate a quarantined copy,
relocation, upgrades and another local user before wider sharing. Testing this
development Mac alone cannot prove all supported machines.

## Local readiness checkpoint — 2026-10-03

`npm run verify` passed type checking, linting, 1,267 tests across 46 files,
the build and formatting checks. `npm run test:native` passed both Swift suites.
A read-only audit found all 303 bundled native binaries compatible with the
declared macOS 14 minimum.

The first Developer ID packaging attempt timed out at native signing. A bounded
disposable signing probe also timed out without a timestamp request, while the
macOS SecurityAgent was running. This points to local private-key access as the
next prerequisite; it is not evidence that Apple rejected the app. The failed
build is private and records a safe failure report. The installed development
app was not replaced.

The user must approve the expected Developer ID signing request locally and
configure the `MusicMute-Notary` Keychain profile before the release attempt can
continue. Signed-runtime inference, DMG preparation, Apple submission/acceptance,
stapling, Gatekeeper and installation checks remain unverified. No release is
ready to share at this checkpoint.
