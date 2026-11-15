# Now Playing and Library artwork — 2026-10-09

This follows the [October 8 thumbnail implementation](library-thumbnails-2026-10-08.md)
and extends the original nullable artwork to Now Playing, compact playback and
queue surfaces. Google Play publication remains on hold by the owner's request.

## Data and fallback behavior

The existing acquisition supplies the original thumbnail URL. MongoDB job and
shared-source `extra_data` preserve the validated string; owner HTTP and raw
WebSocket job views expose nullable `thumbnail_url`. No image is uploaded to
application storage, and no additional metadata acquisition or backfill occurs.
Older jobs, local audio, unsafe URLs and unsuccessful image loads retain the
existing platform placeholders. Clients load only the supplied public image.

Artwork uses square cover cropping, rounded corners, a subtle border and a soft
shadow. Adjacent song titles provide accessible names; decorative artwork does
not duplicate announcements. Track identity and URL changes must reset image
state so an earlier song's cover cannot appear on the next song.

## Backend verification on October 9

Fresh public `/health/live` and `/health/ready` requests returned HTTP 200.
CapRover service `api` was read back as `img-captain-api:136`; its four thumbnail
JavaScript/source-map files match the current compiled source, and its environment
digest matches the previous thumbnail baseline. The host had 33,826,951,168 free
bytes when inspected. The prior out-of-space checkpoint no longer describes
current API readiness. This continuation performed no server cleanup or API
deployment.

Executed from `backend/`:

```sh
pnpm exec vitest run src/jobs/job-extra-data.spec.ts src/jobs/jobs.presenter.spec.ts
node --test test/library-thumbnails.integration.mjs
```

The two unit suites passed 15 tests; isolated MongoDB/Redis integration passed
four tests covering exact source/job URL persistence, shared-cache reuse, null
compatibility and no calls to global `fetch`. A synthetic in-memory projection
inside the running API container returned the original supplied URL unchanged,
and null for missing or unsafe values, without exposing private `extra_data`.
That container check created no production MongoDB job and made no provider or
image request. Proof is in
`/tmp/musicmute-player-thumbnails-20261009/api-live-proof.json`.

## Client implementation

- Android reuses its bounded, cancellable public-image loader across the large
  Now Playing cover, mini player, Library cards and queue rows. Owner/job identity
  guards read current Library metadata. The large cover decodes at most 512 pixels
  per edge; lists use 256. Opening the player reuses the original-byte cache.
- Web shares `TrackArtwork` across Library, mini player, Player and queue. Current
  artwork loads eagerly; list images load lazily. Safe URL validation, no-referrer
  requests and track/URL keys preserve placeholders and reset stale image state.
- iOS shares `JobArtwork` across Library, full Player, mini player and queue.
  macOS shares `DesktopTrackArtwork` across its existing compact Now Playing tile,
  Library and queue. Both retain existing controls and use URL identity to reset
  framework image loading. No separate large macOS player layout was added.

Main files: Android `ui/library/LibraryThumbnail.kt`, `LibraryScreen.kt`,
`ui/player/FullPlayer.kt`, `PlayerScreen.kt`, `PlaybackQueueSheet.kt`,
`PlaybackPresentation.kt` and `ui/VocalApp.kt`; web `src/player/TrackArtwork.tsx`,
`PlayerUI.tsx`, `src/library/LibraryArtwork.tsx`, `LibraryPage.tsx` and styles;
iOS `Vocal/UI/PlayerView.swift`, `LibraryView.swift`; macOS
`chrome-extension/macos/DesktopMediaViews.swift`. Related tests, component guides
and native version manifests were updated. Unrelated checkout edits were preserved;
no commit or push occurred.

## Client checks actually run

- Web: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
  `npm run build`, `npm run test:server`, `npm run test:e2e`, and
  `npm run package:caprover` passed. Results: 253 unit tests, 10 server tests and
  12 installed-Chrome fixture tests, including English/Arabic loaded, missing,
  loading, failed and changed-song artwork. Existing chunk-size and npm dependency
  warnings remain; no dependencies changed.
- Android: `./gradlew :app:testPlayReleaseUnitTest :app:lintPlayRelease
:app:bundlePlayRelease :app:assemblePlayRelease` passed: 417 tests in 66 suites,
  zero failed/skipped. Lint had zero errors with unchanged 186 warnings/one hint.
  Bundle preflight, signatures, eight native 16 KB alignment checks and the APK's
  production API configuration passed. No Android installation or device/UI test.
- Companion: typecheck, lint, build, format and
  `npm test -- --maxWorkers=1 --testTimeout=20000` passed: 2,252 tests in 76 files,
  four skipped. `npm run test:native -- DesktopTests` passed with its unchanged
  30-second timeout; strict Swift formatting and Chrome packaging passed. Separate
  offline static renders checked loaded/loading/missing/unsafe/failed cover phases.
  No Mac app launch, installation or worker change occurred.
- iOS: 36 focused unit tests and two English/Arabic artwork UI fixture tests passed
  on only the existing iPhone 17 Pro / iOS 26.0 simulator,
  `3CC14436-EC3C-4419-A079-C84951E5FA07`; 16 screenshots were exported. Unsigned
  ARM64 Release archive succeeded. Exact `xcodebuild` and package commands are in
  `/tmp/musicmute-player-thumbnails-20261009/swift/commands.json`.

Source review found no blocking owner, identity, fallback or accessibility
regression. Static renders and simulator/browser fixtures do not establish live
thumbnail network loading, authenticated playback or framework image-memory bounds.

## Delivered versions and live verification

| Surface | Result                                                                                        | Remaining boundary                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| API     | Active `img-captain-api:136`; public liveness/readiness 200; thumbnail runtime matches source | Database behavior is proved with isolated MongoDB, not a production fixture write.                                    |
| Web     | Deployed `img-captain-app:23`, build `b8216ed8-7e61-4b68-aaca-e02ef6d05649`                   | Public assets and an existing authenticated Library were inspected; loaded-artwork playback is fixture-tested.        |
| Android | Signed 1.0.2 (22) APK and AAB                                                                 | Local artifacts only. Google Play remains on hold: no upload, submission or publication in this continuation.         |
| macOS   | Public 0.1.3 ARM64 development DMG, build 1791502214                                          | Ad-hoc signed, not notarized; no installed or automatic-update activation claim.                                      |
| Chrome  | Public 0.1.3 development ZIP                                                                  | Downloadable package only; no Chrome Web Store publication.                                                           |
| iOS     | Unsigned 0.1.4 (5) archive                                                                    | No configured team or exact `com.hatem.musicmute` profile with Sign in with Apple and APNs; IPA distribution blocked. |

Web was deployed with `caprover deploy -n musicmute -a app -t` and the verified
allowlisted archive. Its SHA-256 is
`134acc306c54c638066604737abed5b141cda5ec48e36d95a532ac71f39701a3`.
Comparison with the previously deployed archive shows only five changed production
inputs: Library artwork/page, Player UI, shared TrackArtwork and CSS. Public
`/healthz`, entry and four JavaScript/CSS assets return HTTP 200; asset hashes match
the running container. Runtime environment digest and server are preserved. Public
HTML includes the existing edge challenge script. Live proof:
`/tmp/musicmute-player-thumbnails-20261009/web/web-live-proof.json`.

The existing authenticated Library displayed its two records with placeholder
artwork. This observation does not prove a newly acquired production thumbnail or
live audio playback. No new production job, provider acquisition or metadata lookup
was created for this continuation.

The following release assets were uploaded through Chrome into the existing public
Standard release bucket at the new immutable prefix
`releases/macos-player-thumbnails-2026-10-09/`. No storage policy or application-media
permissions changed. Public downloads returned HTTP 200 and matched exact bytes,
content lengths and SHA-256:

- [Mac development DMG](https://downloads.music-mute.com/releases/macos-player-thumbnails-2026-10-09/MusicMuteLocal-0.1.3-arm64-development-build-1791502214.dmg):
  17,173,827 bytes;
  `19d486e71b59d76a0f4831341410ddeedc1fcae99c583397d8fc552bf146a011`.
- [Chrome development ZIP](https://downloads.music-mute.com/releases/macos-player-thumbnails-2026-10-09/musicmute-local-0.1.3.zip):
  640,779 bytes;
  `da2f7e33bbe92ec848c06f0e7a89b0dee05a5eb4a58f81b9bcb91be03d0b7aa1`.
- [Checksums](https://downloads.music-mute.com/releases/macos-player-thumbnails-2026-10-09/SHA256SUMS-build-1791502214.txt):
  218 bytes, matching the local checksum file.

Mac DMG verification also checked read-only mounted 160-leaf inventory, strict deep
signature, architecture/version, public Google configuration/callback and seven
sealed runtime URLs; the mount was detached. Release download proof:
`/tmp/musicmute-player-thumbnails-20261009/release-public-proof.json`.

Local Android artifacts are in
`/tmp/musicmute-player-thumbnails-20261009/android/`:

- `MusicMute-1.0.2-build22.apk`: 5,803,169 bytes;
  `0684508f72dad3c77ce1402e0c5d326a3685496b64067c10ee77049e2d3fc232`.
- `MusicMute-1.0.2-build22.aab`: 11,702,248 bytes;
  `0775f60b3a8dd84a667ea06539900f94342b451826472f23dcc30133632c28f5`.

The iOS archive is
`/tmp/musicmute-player-thumbnails-20261009/swift/MusicMute-0.1.4-build-5-player-thumbnails.xcarchive`.
Its ARM64 main binary SHA-256 is
`b4130ef833a94eefaf4f6027c60c528ce8d1ec44641f3a295082b60c7a87748f`.
It remains unsigned; it is not an installable IPA.

Fixture screenshots are under the web `screenshots/` and Swift `ios-visual-proof/`
directories in that evidence folder. The upload screenshot is
`release-upload-proof.jpg`; native package proof is `swift/delivery-summary.json`.
