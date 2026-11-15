# Native link-import UI visibility validation

Date: **2026-10-08, Africa/Cairo**. Scope: the revised
[implementation prompt](../../AI-PROMPT-hide-link-import.md), followed by the
owner's explicit instruction to implement, deploy and test the work. This record
distinguishes source, local fixtures, installed artifacts and live observations.
The later deployment authorization supersedes the prompt's earlier no-deploy line.

## Implemented behavior

The existing dashboard account-policy setting controls link-entry UI in
**Android, iOS and the macOS app**. File import stays available. The end-user web
client and Chrome browser panel retain their behavior. This setting is absent
from import admission, cache delivery, acquisition reservation/retry and job
scheduling; it adds no processing restriction, cancellation or error code.

The standard `account_policies` document stores `linkImportEnabled` and
`linkImportDisabledCountries`. Missing saved fields read as false/empty without
rewriting existing documents. Existing `settings.read`/`settings.manage`, fresh
authentication, reason, operation receipt and `expectedRevision` protect writes.
Legacy administrator writes that omit the additive fields preserve current
values. Country codes are unique assigned uppercase ISO alpha-2 codes, bounded
to 250 and stored sorted; `XX`, `T1`, lowercase and unassigned codes are rejected.

The existing `URL_IMPORT_ENABLED` flag still defaults to false, with its previous
server behavior intact. Native visibility requires both that flag and the saved
switch. The dashboard displays `link_import_forced_off` separately from the saved
switch. It provides the searchable country picker and removable English
name/code chips using bundled codes and `Intl.DisplayNames`; no country service
is called.

Schema version 2 remains unchanged. Public checkout and the existing owner
`policy` resource add all six fields: `link_import_enabled`,
`link_import_disabled_countries`, `visitor_country`, `link_import_visible`,
`link_import_reason`, and `link_import_policy_revision`.

| Effective switch | Country list / observation                          | Native link UI | Reason            |
| ---------------- | --------------------------------------------------- | -------------- | ----------------- |
| Off              | Any                                                 | Hidden         | `globally_hidden` |
| On               | Empty, including null country                       | Visible        | `allowed`         |
| On               | Nonempty; country missing, `XX`, `T1` or unassigned | Hidden         | `unknown_country` |
| On               | Country selected                                    | Hidden         | `country_hidden`  |
| On               | Other assigned country                              | Visible        | `allowed`         |

HTTP uses the current request's Cloudflare country. A socket uses the country
observed on **that connection's ticket**, never the account's latest device.
`account_policies` already invalidates `policy`; no event, polling loop, Refresh
control or `user_devices` policy dependency was added.

## Requirement audit

“Fixture proven” below is local synthetic evidence, not a live account/provider
claim. Final deployment and device acceptance are recorded separately.

| Requirement                                                                      | Evidence inspected                                                                                                                                                                  | Audit result                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing saved fields and old native payload fields hide links; no uncached flash | Backend policy defaults/spec; Android parser and repository tests; iOS optional decoder/cache tests; macOS `DesktopLinkImportPolicy` and `DesktopTests.linkImportPolicyChecks`      | Source and fixtures support file-only defaults. Invalid/offline checkouts retain a last good cache when one exists.                                                                                                                                      |
| One settings document/revision and existing administration safeguards            | `backend/src/admin-settings/`, `admin-audit-query.ts`; admin-policy Mongo integration; dashboard settings page/reason dialog                                                        | Same route, permissions, fresh auth, CAS, reason and receipt; revision conflicts remain `REVISION_CONFLICT`. No migration or new permission.                                                                                                             |
| Country picker, chips, sorting and forced-process helper                         | Dashboard form, `countries.ts`, page tests and full dashboard browser flow                                                                                                          | Picker remains visible while switch is off; settings.read cannot save; save includes boolean, sorted codes, reason and revision.                                                                                                                         |
| Complete native policy payload and one shared decision function                  | `AccountPolicyService.publicPolicy()`, processing-policy controller, realtime resources/auth                                                                                        | Same helper handles HTTP and socket decisions; admin read has no visitor country. Snake_case remains centralized.                                                                                                                                        |
| Device location is server-observed and sanitized                                 | `cloudflare-location.ts`, device schema/controller/service/presenter; unit, HTTP and real-Mongo device tests                                                                        | Embedded nullable location; bounded UTF-8/escaped-byte text; controls/malformed values dropped; bounded decimal-string coordinates; no coordinates in policy.                                                                                            |
| Client JSON cannot supply location                                               | Device DTO unchanged; HTTP tests for forged country/city/location                                                                                                                   | Existing strict DTO behavior is preserved: unexpected fields return 400 rather than silently discarding them. They never become location evidence.                                                                                                       |
| Device writes are bounded and ownership-scoped                                   | Device Mongo integration and realtime ticket unit tests                                                                                                                             | Changed location or five-minute cadence; unchanged location causes no extra device write; a ticket ignores another installation's owner. Missing edge values clear the saved observation to null fields. Policy reads never write devices. No new index. |
| Each native open/session checks HTTP, then uses existing snapshots               | Android Activity/application repository lifecycle; iOS scene/session lifecycle; macOS launch/activation/scope handlers                                                              | Native checkout is `/processing-policy?schema_version=2`, with public signed-out paths. HTTP response stays no-store. Existing owner sockets supply subsequent complete snapshots.                                                                       |
| Installation cache survives offline reopen                                       | Android private no-backup JSON cache tests; iOS protected atomic cache tests/UI scenario; macOS installation-keyed preferences tests                                                | Last good payload retained; missing/corrupt/unsupported cache stays hidden. Cache is not an account-wide log.                                                                                                                                            |
| Delayed HTTP, revision and session races cannot restore stale controls           | Android repository/realtime tests; iOS request/snapshot/owner tests; macOS delayed-checkout/source-picker tests and existing socket fences                                          | Older revisions rejected; late requests fenced by session/request state; socket sequence/stream fences preserved. Same-revision country races are covered by mobile fixtures.                                                                            |
| Hide all new-link entry controls while retaining file controls                   | Android Home/shared intake/dynamic launcher shortcut; iOS `URLImportCard.allowsNewImport`; macOS Home/source preferences/handoff                                                    | URL controls omitted; file/audio/video/photo controls remain where supported. macOS saved YouTube preference resolves to File while hidden. No empty one-item segmented control or explanatory hide banner.                                              |
| Visibility changes preserve accepted work and retries                            | No flag references in backend import/jobs/usage/worker code; real-policy acquisition/retry test; shared-media regression; iOS existing-import UI scenario; Android realtime fixture | No new admission or runtime guard. Queued import/reservation survives policy push; durable acquisition retry retains one hold; existing history/retry UI stays available.                                                                                |
| English/Arabic layout and accessibility                                          | Native localized copy and RTL structure; dashboard named switch/checkboxes/chips; iOS Arabic Home scenario                                                                          | New controls have labels; macOS file-only copy is localized. Final rendered/device evidence is recorded in the release section.                                                                                                                          |
| Admin device location presentation only if rows already exist                    | Current dashboard users detail and backend admin users controller/service/presenter                                                                                                 | No existing administrator device rows/page. A new page was deliberately not created; owner device reads expose location.                                                                                                                                 |
| Web client and Chrome browser panel unchanged                                    | No task diff in `web-client/` or `chrome-extension/src/extension/`; native flag consumers inspected                                                                                 | No native visibility dependency added to those browser UIs.                                                                                                                                                                                              |
| Contract and edge configuration documented                                       | `docs/api/client-contract.md`, `docs/realtime-processing-queue/PROTOCOL.md`, `backend/openapi.yaml`, backend README                                                                 | Authored checked-in OpenAPI updated; no generator exists. Nginx snippet is documented separately from image deployment.                                                                                                                                  |

## Backend validation actually run

All commands below ran from `backend/` and completed successfully unless a
specific earlier failed attempt is described. Tests used existing frameworks.

| Command                                                                                                                                                                                                     | Result and scope                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec vitest run src/admin-settings/account-policy.service.spec.ts src/devices/cloudflare-location.spec.ts src/realtime/realtime-auth.service.spec.ts src/realtime/realtime-resources.service.spec.ts` | 4 files / **58 tests passed**: defaults, complete visibility table, invalid countries, sanitization and per-ticket country.                                                                                                                                        |
| `pnpm exec vitest run --config vitest.config.e2e.ts test/admin-settings.e2e-spec.ts test/devices.e2e-spec.ts`                                                                                               | 2 files / **11 tests passed**: no-store public checkout, current header country, forged input rejection, admin DTO/permissions and device sync.                                                                                                                    |
| `pnpm run verify`                                                                                                                                                                                           | Exit 0: formatter, full lint/typecheck, secret scan, transfer benchmark, **1,689 unit tests**, **223 HTTP E2E tests**, build.                                                                                                                                      |
| `node --test --test-concurrency=1 test/admin-account-policy.integration.mjs test/devices.integration.mjs test/realtime.integration.mjs`                                                                     | **3 integration tests passed** on isolated Mongo replica set/Redis. Includes audited revision writes, old-admin compatibility, device cadence/ownership and same-account EG/US sockets on two feed instances. Toggle pushes preserve queued job/reservation state. |
| `pnpm run test:imports:integration`                                                                                                                                                                         | **40 tests passed** with synthetic provider/audio and loopback transfer fixtures; existing cache/shared delivery, concurrency and recovery behavior remained green. No production media/provider call.                                                             |
| `pnpm run build && node --test test/url-import-admission.integration.mjs` after adding the final real-policy regression                                                                                     | **8 tests passed**, including globally/country-hidden UI preserving fresh import creation, acquisition and durable retry with one reservation; hidden UI also retains file admission. This final targeted run is separate from the preceding full 40-test run.     |
| Final focused Cloudflare test plus formatter, `pnpm exec oxlint --deny-warnings src/ test/`, `pnpm exec tsc --noEmit`, build and `git diff --check`                                                         | Passed after the final bounded-text adjustment. Unusable oversized city text is dropped before Mongoose validation.                                                                                                                                                |

An earlier integration invocation overlapped a Nest build that replaces `dist`,
causing two module-not-found failures. The complete three-test command was rerun
against a stable build and passed. That failed attempt is not counted as proof.
The realtime integration uses two independent feed/transport instances in one
process, not a deployed multi-process capacity benchmark.

## Dashboard and native validation

| Component    | Executed validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence boundary                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard    | Root reports lint/typecheck/build passed; `npm test`: **187 tests / 35 files**; `npm run test:deployment`: **19 passed**; touched-file Prettier passed; `npm run test:e2e -- --workers=2`: **60 browser tests passed** including the revisioned native switch/country save.                                                                                                                                                                                                                                                                                                    | Synthetic browser/backend fixture proof. Does not establish a real administrator save changing all three installed native clients simultaneously.                                                                          |
| Android      | `./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest :app:assembleDirectDebug :app:assemblePlayDebug :app:lintDirectDebug :app:lintPlayDebug :app:testDirectReleaseUnitTest :app:testPlayReleaseUnitTest :app:lintDirectRelease :app:lintPlayRelease :app:assembleDirectRelease :app:bundlePlayRelease` exited 0. XML reports independently read: Direct Debug/Release each **380 tests / 66 suites**, Play Debug/Release each **364 / 63**, zero failures/errors/skips. All four lint reports: zero errors/fatals; existing **205 Direct / 186 Play warnings**. | JVM/state/transport proof and build/lint. No Android device/UI execution and no existing Home Compose JVM test. `check-play-release.py` and its 35 helper tests also reported passing.                                     |
| iOS          | `xcodebuild` unit suite: **179 tests passed**. Final complete UI run: **16 tests passed / zero failures**, exit 0. Release `xcodebuild archive` exited 0 (`ARCHIVE SUCCEEDED`); strict Swift lint and diff checks passed.                                                                                                                                                                                                                                                                                                                                                      | Only iPhone 17 Pro / iOS 26.0, UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`. Earlier picker failures were repaired in test navigation; the final full suite is green. Archive is unsigned, not an IPA or App Store release. |
| macOS native | Root reports `npm run test:native -- DesktopTests SettingsTests` passed; strict Swift formatting/lint on touched files and EN/AR `plutil -lint` passed. Includes missing/legacy policy, snapshot toggles, offline cache, stale revision, delayed HTTP, signed-out public checkout and source resolution.                                                                                                                                                                                                                                                                       | Native logic tests; installed UI/inference proof is recorded separately below.                                                                                                                                             |
| Companion    | The former config/provider/setup cycle was reproduced in three import-failing suites and fresh compiled `app-control`. Minimal leaf error-class extraction preserved config re-export and pending model logic. Focused **38 tests / 4 files passed**. Equivalent full verification with `npm test -- --maxWorkers=4` exited 0: typecheck, lint, **2,213 tests passed / 4 skipped / 75 files**, build and full formatter.                                                                                                                                                       | This required repair prevents startup failure of the packaged setup/controller; it does not change browser visibility or model-download behavior.                                                                          |

The companion's original default-worker verification was intentionally stopped
with exit 130 to avoid contention; it is not a passing run. The bounded-worker
chain above completed. The freshly built `dist/companion/app-control.js` also
reached intended `INVALID_APP_COMMAND` with empty stderr, before loading app data:
the expected process exit is 1, and the smoke checker exited 0. Its sanitized
SHA/result record is
`/tmp/musicmute-cycle-startup-proof-b9bdbab0-4769-4e21-897d-db533d5b5035.json`.

Android test XML lives in `android/app/build/test-results/`; lint XML in
`android/app/build/reports/`. iOS unit/earlier-UI evidence is
`/tmp/musicmute-ios-link-visibility-complete-tests.log`, and the passing picker
regression is `/tmp/musicmute-ios-link-visibility-picker-scroll-tests.log`.
Final iOS UI evidence is in
`/tmp/musicmute-ios-link-visibility-final-ui-suite.log`. These local generated
reports are not tracked source or public release artifacts.

### Final iOS commands

The final unit run has its own clean result:
`/tmp/musicmute-ios-link-visibility-final-unit-suite.log` and
`ios/DerivedData/Logs/Test/Test-MusicMute-2026.10.08_04-53-10-+0300.xcresult`.
All commands below ran from `ios/` and exited 0. Both test commands explicitly
selected the authorized existing simulator; the generic device destination is
an archive build, not a device/UI test.

```sh
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  -only-testing:VocalTests test CODE_SIGNING_ALLOWED=NO

xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  -only-testing:VocalUITests test CODE_SIGNING_ALLOWED=NO

xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath DerivedData \
  -archivePath .build/link-import-visibility/MusicMute.xcarchive \
  archive CODE_SIGNING_ALLOWED=NO

xcrun swift-format lint --strict \
  Vocal/Processing/ProcessingMediaPolicy.swift \
  Vocal/Processing/JobsAPIClient.swift Vocal/State/ProcessingModel.swift \
  Vocal/VocalApp.swift Vocal/UI/HomeView.swift Vocal/UI/URLImportCard.swift \
  Vocal/UI/ProcessingUITestHarness.swift \
  VocalTests/ProcessingMediaPolicyTests.swift VocalTests/URLImportsTests.swift \
  VocalTests/JobsAPIClientTests.swift VocalUITests/ProcessingUITests.swift

xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
git diff --check -- .
```

Touched-source strict lint has no warnings. Recursive lint retains existing
`AuthAPIClient.swift` warnings. Archive output log is
`/tmp/musicmute-ios-link-visibility-archive.log`.

## Deployment and artifact checkpoints

All readbacks below were completed on October 8. Generated proof stays outside
tracked source and excludes credentials, location headers and signed transfer URLs.

| Surface                   | Verified result                                                                                                                                                                                                                                                                                                                                                  | Evidence / distribution boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                       | CapRover **API126**, one instance, not building. `/health/live` and `/health/ready` return HTTP 200. Public processing policy is no-store, schema 2, revision 2, country EG, globally hidden, empty disabled-country list.                                                                                                                                       | Upload archive SHA-256 `236515560036bcc0ead3fd9dec689dac9544d4d16d3a306230da3383ffa49b91`. Before/after comparison preserves all protected configuration fields, including environment, ports, WebSockets, nginx, hooks and domains. Sanitized readback is `sanitized-final-release-proof.json` in the private deployment evidence directory. No production visibility setting was saved or migrated.                                                                                                                              |
| Dashboard                 | CapRover **dashboard34**, one instance, not building; `/healthz` returns HTTP 200. Existing owner session renders the new switch and country picker.                                                                                                                                                                                                             | Archive SHA-256 `8c6c044f48aa5f95bd52ac296ebb370b458c9c38eece5ba6b8da076bf1659d8e`. Protected configuration unchanged. Screenshot: `dashboard/test-results/link-import-visibility/live-settings.png`.                                                                                                                                                                                                                                                                                                                              |
| API nginx / country trust | Live custom nginx template is empty; CapRover's default forwards request headers and has no `proxy_pass_request_headers off`. HTTP and WebSocket upgrade share the forwarding location. No nginx change was required. Cloudflare visitor-location transform is enabled and the API uses proxied wildcard DNS.                                                    | Country EG reaches live policy. Origin firewall restriction to Cloudflare remains **unverified**, so header authenticity against direct-origin spoofing is not established. No port/firewall/security configuration was changed.                                                                                                                                                                                                                                                                                                   |
| macOS installed           | Exact build **1791422383** installed at `/Applications/MusicMute Local.app`; all **160** inventory leaves match, no extras, strict deep signature passes. Runtime identity remains `macos-arm64-v1-c923b1be1f135d8c48ef81c9`.                                                                                                                                    | `output/link-import-installed-proof.json`; previous app retained in Applications backup. Compatible external runtime/model and worker state retained. File-only Home uses live policy; a synthetic six-second WAV completed actual local inference to Voice Ready and full native playback. English/Arabic Home and file picker inspected; System language restored.                                                                                                                                                               |
| macOS DMG                 | `hdiutil verify`, read-only mounted 160-leaf inventory, strict signature and Applications link passed. Public DMG and checksum downloads return **HTTP 200** and exactly match local bytes/hashes.                                                                                                                                                               | [Development DMG](https://downloads.music-mute.com/releases/macos-store-companion-2026-10-08/MusicMuteLocal-0.1.1-arm64-development-build-1791422383.dmg), **16,211,926 bytes**, SHA-256 `037090aea06a7f0889a06341ad71e56a099b5fc8971dec4186be70aff5437cbc`; [checksum](https://downloads.music-mute.com/releases/macos-store-companion-2026-10-08/SHA256SUMS-build-1791422383.txt), 126 bytes. **Ad hoc, unnotarized, updater unconfigured, public_ready=false**. Older release objects retained; no model/runtime object upload. |
| Android Direct            | Published **0.1.14 / build 15**, release `6ac6f22960c7e2566f4943e5`, policy revision **5**, minimum **11**. Independent public grant/download verifies **5,845,015 bytes**, expected hash, APK v2 signature, approved signer, package/version/build and non-debuggable manifest. Existing update decision code returns optional for build 14, none for build 15. | [Public download entry](https://api.music-mute.com/app-updates/releases/6ac6f22960c7e2566f4943e5). SHA-256 `5998a7949440576f38e902414cd95c8cb8cd09ce1c8bb9a1bfa1b6e118dbda7d`. Play/iOS selections remain null; minimum unchanged. Sanitized private proof: `/var/folders/jh/kqzv5jvj1qgfq85qwnwclz4w0000gn/T/musicmute-android-release-proof-o0_16wga/proof.json`. No Android device execution.                                                                                                                                   |
| Android Play              | Signed `android/app/build/outputs/bundle/playRelease/app-play-release.aab` is **11,641,434 bytes**, SHA-256 `a2324ff43a5675670081b002a99b6150a0fc56897b3daf40004cc72726879aaf`. Local SDK 36 / 16 KB native-library checker passed.                                                                                                                              | Public Play update policy still returns pre-existing missing-target 503. The currently open developer account's complete five-app list contains no MusicMute app; no Play listing/release was created or claimed.                                                                                                                                                                                                                                                                                                                  |
| iOS                       | Final 179 unit and 16 UI tests passed. Unsigned Release archive: `ios/.build/link-import-visibility/MusicMute.xcarchive`, **com.hatem.musicmute 0.1.2 (3)**, API origin `https://api.music-mute.com`. No embedded provisioning profile or dotenv files.                                                                                                          | No MusicMute DEVELOPMENT_TEAM or matching profile exists. Available iOS-capable signing identities span five teams, so an owner team cannot safely be inferred. Team selection/provisioning is required before signed IPA/App Store publication. Screenshots are under `ios/.build/link-import-visibility/screenshots/`.                                                                                                                                                                                                           |

macOS package:
`chrome-extension/output/macos/build-7102a65f-58df-4fea-9965-6e56f5ff2998.noindex/package-result.json`.
Both the installed app and read-only mounted DMG match this exact package.
`npm run install:macos -- --applications-dir /Applications` exited 0.
`node scripts/qualify-packaged-tools.mjs` with the exact package and approved
model passed **all 17** isolated offline checks; report
`output/packaged-tools-proof/b25828a7-9e8c-4a07-803e-5886a331a6ab.noindex/result.json`.
Those isolated checks use no real account, Keychain, browser profile, backend or
inference. The separate installed UI run above supplies actual local inference.
Public download proof is
`chrome-extension/output/link-import-visibility-proof.noindex/public-download-proof.json`;
DMG proof is `chrome-extension/output/link-import-dmg-proof.json`.
UI/publication screenshots are in that proof directory and
`dashboard/test-results/link-import-visibility/android-published.png`.

The iOS final full UI result is
`ios/DerivedData/Logs/Test/Test-MusicMute-2026.10.08_04-39-30-+0300.xcresult`.
Its archive is unsigned by design at this checkpoint: code-sign inspection exits
1, and no provisioning profile is embedded. This is build proof, not store proof.

## Remaining acceptance boundaries

- An actual production administrator switch/country save observed concurrently by
  real signed-in Android, iOS and macOS sessions is not proven by fixture tests or
  a default-hidden public checkout. No production setting was changed for these
  checks.
- Cloudflare country headers can be spoofed through a directly reachable origin.
  No origin port/firewall change or hard-coded IP allowlist was introduced. Final
  origin restriction evidence must be reported independently.
- The existing process flag may keep native link UI hidden even after the stored
  switch is on. Its default and production value were not changed by this feature.
- Signed-out Macs have no owner policy socket: they update at public checkout.
  Offline apps intentionally keep their last good installation cache. Neither
  circumstance promises immediate offline revocation.
- No paid provider or production URL import was used for feature validation.
  Synthetic/local inference, mock transfer tests and public artifact downloads do
  not establish real Firebase/R2/provider end-to-end URL processing.
- Android runtime/UI validation, Apple signing/notarization/public release and
  Google Play publication remain distinct from local builds and the recorded
  Direct APK/development DMG delivery.

The API preflight used the
[current official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-08: OpenAPI, endpoint authorization, snake_case, country formats and
compatible additive behavior (rules 101, 104, 118, 171 and 106). The contract and
tests retain existing lowercase policy reasons and strict input validation.
