# Library thumbnails — 2026-10-08

Library now uses the original optional video thumbnail URL across web, Android,
iOS and macOS. Backend source and isolated persistence checks pass; the backend
production checkpoint remains **pending** because the deployment server is out
of disk space. No authenticated live Library rendering is claimed.

This is the October 8 checkpoint. The [October 9 continuation](player-thumbnails-2026-10-09.md)
records recovered API readiness and the extension to Now Playing artwork.

## Behavior

The adapter retains only the pinned extractor's original `thumbnail` URL from
the existing acquisition. It does not derive resolutions, fetch the image or
make another metadata request. The private router and backend validate exact
HTTPS `i.ytimg.com`, bounded `/vi/` or `/vi_webp/` JPG/WebP paths, and optional
bounded `sqp`/`rs` parameters. Credential-bearing, malformed and unsafe URLs are
discarded. Oversized adapter metadata omits only the thumbnail, preserving the
existing title and audio fields.

The backend preserves the URL in nullable sanitized MongoDB `extra_data`,
including shared-source/cache reuse, and exposes top-level
`thumbnail_url: string | null` in HTTP job responses and raw WebSocket snapshots.
Older rows are not backfilled. Older responses, local-only audio, invalid URLs
and failed image loads retain each client's current placeholder. Native history
and the macOS companion's durable cloud-audio catalog preserve the optional URL.
Client image loading uses the original public URL; images are not copied to R2.

API preflight read the current [official Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-08. Rules 106, 118 and 123 apply to the compatible additive nullable
field and its snake_case wire name.

The earlier [adapter release record](../video_providers/ytdlp/docs/THUMBNAILS-2026-10-08.md)
contains the one real router request: HTTP 200 for `jNQXAC9IVRw`, exactly one
acquisition, unchanged native audio and its original thumbnail URL. It fetched
no thumbnail image and created no backend job, R2 object or worker task. That
record's backend/client exclusion describes the earlier adapter-only phase.

## Checks actually run

- Adapter/router: 147 tests passed (78 adapter, 37 router, 21 synthetic routing
  integration, eight metadata and three acquisition-context tests). Commands are
  recorded in the linked adapter release. The metadata-header regression is
  included in the adapter suite; its focused service run passed 11 tests.
- Backend: `pnpm run verify` passed formatting, lint, typecheck, secret scan,
  transfer benchmark tests, 1,675 unit tests in 158 files, 223 e2e tests in 33
  files and build. `node --test test/library-thumbnails.integration.mjs` passed
  four isolated MongoDB/Redis checks covering persistence, shared-cache reuse,
  nullable compatibility and zero calls to global `fetch`.
- Web: formatting, lint, typecheck, 244 unit tests in 22 files, 10 server tests,
  11 installed Chrome fixture e2e tests and production build passed. English and
  Arabic fixtures cover successful, missing and failed thumbnails.
- Android: 415 unit tests in 66 suites passed; release lint had zero errors and
  existing warnings. Release build, signed bundle validation and
  `scripts/check-play-release.py` passed. No Android device/UI run. The exact
  combined Gradle invocation is not retained in this evidence record.
- iOS: 35 focused unit tests passed on the existing iPhone 17 Pro / iOS 26.0
  simulator `3CC14436-EC3C-4419-A079-C84951E5FA07`; unsigned ARM64 Release archive
  succeeded. No thumbnail UI/image-fetch acceptance run.
- macOS/companion: format, lint, typecheck and build passed; the final full suite
  passed 2,252 tests in 76 files, with four skipped. `DesktopTests` passed under
  Swift 6 with warnings as errors. The full native updater suite was not run.
  Chrome store packaging passed. DMG verification, mounted inventory comparison
  (160 leaves), strict signature verification and seven sealed public runtime
  component checks passed. No app installation, fresh-user Prepare or real
  Google sign-in run was performed.

Backend log: `/tmp/musicmute-library-thumbnail-backend-verify.log`. Final iOS
logs: `/tmp/musicmute-library-thumbnails-ios-tests-final.log` and
`/tmp/musicmute-library-thumbnails-ios-archive-final.log`. Checks used synthetic
client fixtures or isolated services unless explicitly identified as live below.

Exact client commands (run from the named component directory):

```sh
# web-client/
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:server
npm run test:e2e
npm run build
npm run package:caprover

# chrome-extension/
npm run format:check
npm run lint
npm run typecheck
npm test -- --maxWorkers=1 --testTimeout=20000
npm run build
npm run test:native -- DesktopTests
npm run package:chrome

# ios/
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' -derivedDataPath /tmp/musicmute-library-thumbnails-ios-derived -parallel-testing-enabled NO -only-testing:VocalTests/JobsAPIClientTests -only-testing:VocalTests/CoreTests -disableAutomaticPackageResolution test CODE_SIGNING_ALLOWED=NO
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /tmp/musicmute-library-thumbnails-ios-derived -archivePath /tmp/MusicMute-0.1.3-build-4-thumbnails-final.xcarchive -disableAutomaticPackageResolution archive CODE_SIGNING_ALLOWED=NO
```

Changed Swift files also passed `xcrun swift-format lint --strict`; component
diff checks passed. The macOS package reused the existing sealed runtime with
`MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL=https://downloads.music-mute.com/releases/macos-runtime-2026-10-06/`
and the existing public desktop configuration. No placeholder runtime host or
private application-media exposure was introduced.

## Delivery and production checkpoints

| Surface | Artifact or active release                                                  | Verified boundary / remaining gate                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web     | CapRover `img-captain-app:22`, build `c5b2ed71-14ba-49bc-914b-9816011c6f9c` | Public health, entry and four JS/CSS assets returned HTTP 200; assets match the active container. Runtime environment matches baseline. CSP allows exact `i.ytimg.com`; image referrer policy is `no-referrer`. Authenticated live Library remains untested. |
| Backend | Candidate `img-captain-api:132`; rollback `:134` based on prior `:128`      | Both failed cold startup with `ENOSPC`; server disk is 100% used. At this checkpoint `:134` is selected and API health is unproved. Awaiting owner permission to clear unused Docker artifacts; live read-back remains pending.                              |
| Android | 1.0.1 (21), signed Play AAB                                                 | Uploaded to a Play draft before the owner's stop instruction. No review submission or publication; no further Play actions.                                                                                                                                  |
| iOS     | 0.1.3 (4), `/tmp/MusicMute-0.1.3-build-4-thumbnails-final.xcarchive`        | Unsigned ARM64 archive only. No configured development team or exact `com.hatem.musicmute` provisioning profile with both Sign in with Apple and APNs; IPA export/distribution blocked.                                                                      |
| macOS   | 0.1.2, build 1791479347, ARM64 development DMG                              | Public download returned HTTP 200 with matching size/hash. Ad-hoc signed and not notarized; no installation or notarized release claim.                                                                                                                      |
| Chrome  | 0.1.2 store ZIP                                                             | Package prepared. Store publication is blocked by unavailable publication tooling and remaining signing/distribution gates; no store publication occurred.                                                                                                   |

Web read-back: `/tmp/musicmute-library-thumbnails-release/web-live-proof.json`.
The public HTML has an edge-injected challenge script; its build version and
all checked assets match the container. Public assets prove the deployed build,
not authenticated API processing or image display.

macOS [development DMG](https://downloads.music-mute.com/releases/macos-library-thumbnails-2026-10-08/MusicMuteLocal-0.1.2-arm64-development-build-1791479347.dmg):
17,163,364 bytes, SHA-256
`e5ddf51325b5696b556681a47991abbb36781667bde445899464981ecbea3f14`.
Read-back: `/tmp/musicmute-library-thumbnails-release/macos-public-proof.json`.

Android AAB: `/tmp/musicmute-library-thumbnails-release/MusicMute-1.0.1-build21.aab`,
SHA-256 `8ff276f5d05ee828827ddd6049c171e9acdd1c7c45521702745afa6a8496d006`.

Chrome ZIP:
`chrome-extension/output/chrome-store/v0.1.2-YEIsbE/musicmute-local-0.1.2.zip`,
640,779 bytes, SHA-256
`9290be34d3daa0dd28e586bd1a2a5179bc0a10b16805e0a34eb385192d88e0bb`.

## Main implementation files

- Adapter/router: `video_providers/acquisition_metadata.py`,
  `video_providers/ytdlp/extract.py`, `video_providers/ytdlp/service.py`, and
  focused metadata/service tests.
- Backend: `backend/src/jobs/job-extra-data.ts`, `jobs.presenter.ts`, their two
  specs, `backend/test/library-thumbnails.integration.mjs`, `backend/openapi.yaml`,
  `docs/api/client-contract.md`, `docs/realtime-processing-queue/PROTOCOL.md`.
- Web: `web-client/src/api/thumbnail.ts`, `api/wire.ts`, `api/types.ts`,
  `library/LibraryArtwork.tsx`, `library/LibraryPage.tsx`, styles/server CSP and
  HTTP/WebSocket/image-fallback tests.
- Android: `processing/ThumbnailUrl.kt`, `processing/JobModels.kt`,
  `processing/ProcessingStore.kt`, `library/LibraryThumbnailLoader.kt`,
  `ui/library/LibraryThumbnail.kt`, `ui/library/LibraryScreen.kt` and tests.
- iOS: `ios/Vocal/Processing/JobModels.swift`, `UI/LibraryView.swift`,
  `ios/VocalTests/JobsAPIClientTests.swift` and version manifests.
- macOS/companion: `chrome-extension/macos/DesktopWorkspace.swift`,
  `DesktopMediaViews.swift`, `Tests/DesktopTests.swift`,
  `src/shared/thumbnail-url.ts`, `src/companion/cloud-provider.ts`,
  `account-cache.ts`, `desktop-catalog.ts`, associated tests and version manifests.

Existing unrelated checkout edits were preserved. No commit or push was made.
