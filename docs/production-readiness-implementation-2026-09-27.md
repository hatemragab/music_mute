# Production readiness implementation — 27 September 2026

Follow-up to [the initial review](production-readiness-review-2026-09-27.md), after the user authorized implementation. This ledger supersedes the initial review only for the findings explicitly resolved below. A public launch remains conditional on the open gates.

## Changes completed

- Web production CSP now allows local `blob:` audio metadata inspection. The deployed server previously blocked WAV and MP3 before upload. A retained browser regression runs against the production server, rather than only Vite.
- Web audio SHA-256 declarations now use padded base64, matching the existing API and S3 contract. Hex declarations previously returned `INVALID_INPUT`; a known digest vector protects this boundary.
- Added a localized React error boundary with reload recovery and optional, sanitized Sentry error reporting. Events omit original messages, user context, request data, breadcrumbs and query strings; only allowlisted built-asset stack locations are retained. Tracing and replay are disabled, with a per-page event budget. Runtime DSNs are validated and CSP permits only the configured ingest origin.
- Web server adds host-only HSTS. Chrome, Firefox and WebKit are selectable in the browser regression configuration.
- iOS Release defaults now point at the production API, privacy and deletion pages; regenerated the Xcode project. The ignored local Firebase plist remains uncommitted. Files-picker tests select the cell instead of a filename caption, and save an independently named synthetic export. Artifact-request expectations account for existing original-track prefetch.
- Corrected dashboard test formatting. Added application CI workflow definitions for backend, web and dashboard; native validation remains a local gate on the authorized simulator. Workflows have not been pushed or run remotely.

## Live web release and processing evidence

- CapRover app `app`, image **7**, deployed at approximately **14:45 UTC**.
- Allowlisted source archive SHA-256: `56b5e3f8d387bc0f06bd91df9cdf6a8c5646bd78da62bc31eecb43dad80bd434`.
- Previous image **6** remains the immediate rollback candidate; image **5** preceded this implementation session. Rollback execution was not tested.
- HTTPS returned 200; live HSTS and `blob:` media CSP were verified. Runtime configuration reports Sentry enabled for project `musicmute-web-client` (4512158868766720). No private credentials were added to the browser configuration.
- Submitted only a project-generated eight-second WAV through the real signed-in browser, with rights confirmed and trim disabled. Job `6ab92d3daa2e773d189ee1ac` reached Ready; browser playback advanced to the end.
- Worker attempt `9ed3303b-6132-4917-9d76-eb804ddf5463` succeeded without a child restart. Server/worker timestamps show **13.267 seconds for the worker attempt**, not end-to-end browser latency. Separation took 2.563 seconds across three windows.
- Independently retrieved the pinned synthetic output from S3 and decoded it using FFmpeg: **163,048 bytes**, duration **8.080544 seconds**, SHA-256 `52d80f8b62070dd4cdfd25626bca44bce5f1cf5b7bb87b54a90eddc7f597382b`.
- The web Download control opens a signed media tab. An automatic browser download event did not occur; native browser Save/export UX is not yet accepted. Do not equate the independent S3 retrieval with proof of browser file saving.
- The new Sentry project is configured for error monitoring only. Receipt of a controlled browser event and alert delivery remain unverified because computer access became locked.

This live job used the already-running worker, not the pending signed RC runtime. No production account or media was deleted. Synthetic test artifacts remain available.

## Checks run after implementation

| Area | Evidence | Boundary |
| --- | --- | --- |
| Web | Format, lint, typecheck; 98 unit tests; 9 server tests; production build; Chrome 6 browser tests | Local and fixture tests, with the separate live job above |
| Browser matrix | Firefox and WebKit each passed all 6 tests on final application source | Desktop engines, not physical mobile browsers |
| Backend integration | Deletion 3, processing 15, realtime 1, infrastructure 1 tests passed | Isolated fixtures, including dependency recovery; not a production restore drill |
| Backend baseline | Initial review: 945 unit and 148 HTTP fixture tests, build, lint, typecheck and format passed | No backend source changes by this implementation |
| Android | Direct release 286 unit tests; Play release 266; both release lint tasks, direct APK assembly and Play AAB bundle passed | No device install, store upload or distributed-artifact acceptance |
| iOS | Final full run passed: 153 unit tests and all 10 UI tests, after fixing the Files-picker interaction; Swift-format lint passed | Authorized iPhone 17 Pro/iOS 26.0 simulator only; no TestFlight proof |
| Dashboard | Formatting passed after correction; initial review 83 unit, 11 deployment and 34 browser tests passed | Fixture services, no new dashboard deployment |
| CI | `actionlint` passed for both application and worker workflow definitions | No remote CI execution or branch protection proof |
| Working tree | `git diff --check` passed | Existing unrelated edits preserved; no commit/push |

Android command: `./gradlew :app:testDirectReleaseUnitTest :app:testPlayReleaseUnitTest :app:lintDirectRelease :app:lintPlayRelease :app:assembleDirectRelease :app:bundlePlayRelease`.

Built artifact SHA-256 values: direct APK `7c799f9c689dcb18c8fc1ec1e924dcebae9f2e7aeb0d3a499a536eeb7023ebac`; Play AAB `8214d79c30a6bd0dfc6ff8fc0b1f90a5cf26438a3460a12d0d288c94af55683f`. These identify local builds, not uploaded releases.

iOS command: `xcodebuild -project ios/MusicMute.xcodeproj -scheme MusicMute -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' -derivedDataPath /tmp/musicmute-readiness-ios-isolated -clonedSourcePackagesDirPath ios/DerivedData/SourcePackages -parallel-testing-enabled NO test CODE_SIGNING_ALLOWED=NO`.

`xcodebuild -configuration Release -showBuildSettings` independently confirmed the API, privacy and deletion URL settings. This does not prove a signed distribution archive.

Backend commands: `pnpm run test:deletion:integration`, `pnpm run test:processing:integration`, `pnpm run test:realtime:integration`, `pnpm run test:integration`.

## Open gates and exact next actions

1. **Worker signing:** provide only the location of the approved private key matching `worker-release-2026-09`. Verify its public fingerprint, sign and promote the existing candidate through the release process, then run normal trusted update and live job acceptance. Do not bypass verification or substitute another trust key. npm publication is already recorded in [worker release progress](../worker/RELEASE-PROGRESS.md); it does not activate the native runtime.
2. **Disposable account:** supply a designated test identity/session for real registration, verification mail, reset, provider linking, revocation, deletion and recovery. Do not test these destructive flows on the active personal account.
3. **Browser finish:** unlock the Mac, prove native file saving and receipt of a sanitized diagnostic event in Sentry, then restore the browser to its ordinary state. Verify alert routing with the intended recipient before claiming operational alert acceptance.
4. **Restore and retention:** live S3 checks confirmed versioning Enabled, all four public-access blocks enabled and AES256 default encryption. No lifecycle configuration exists. Choose retention separately for active originals, outputs, deleted-account cleanup and old release artifacts; do not apply an indiscriminate expiry rule. Establish backup ownership and an isolated restore target, then perform a timed restore drill. Local Redis recovery tests do not establish production backup recovery.
5. **Release identity:** the working tree contains substantial pre-existing changes. Review and freeze an immutable release commit, connect successful remote CI to it, and map native artifacts and server images to that source. The current archive hash identifies this web deployment but does not replace a clean reviewed source commit.
6. **Native distribution:** validate iOS signing, providers, archive/TestFlight; validate Android distribution signing and Play/direct delivery. Build success is not store availability. No additional simulator or device was used.
7. **Operational launch:** demonstrate sustained worker capacity, offline-worker alerts, supported URL-import acceptance, quotas/abuse limits, cost alerts, production rollback and recovery ownership. Do not advertise personal-Mac capacity as an always-on service.
8. **Landing page:** root domain/DNS/HTTPS and honest availability/support/privacy links remain launch work. Advertise only clients with completed release acceptance.

API compatibility was retained, including existing snake_case wire serialization, checksum encoding and idempotency identities. The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/) were consulted on 2026-09-27 for compatibility, data formats and HTTP behavior. This is implementation evidence, not a compliance certification.
