# Selected-user link-import visibility

Source and local validation: **2026-10-08, Africa/Cairo**. This extends the
existing native visibility implementation documented in [VALIDATION.md](VALIDATION.md).
The initial implementation validation preceded deployment authorization.
The deployment follow-up below records the later request; installed-app
replacement was not requested or performed.

## Administrator workflow and behavior

In **Standard account policy**, use **Hide link import for these users** below
the country selector. Search by display-name prefix, exact email or account ID;
select one or more accounts, then use **Review changes**, fresh authentication,
a reason and **Save policy**. Removing a selected chip or clearing its checkbox
uses the same save flow to restore the normal global/country rules.

The existing standard policy stores sorted `linkImportDisabledUserIds`, exposed
only to administrators as `link_import_disabled_user_ids`. The list permits up
to 1,000 unique canonical lowercase 24-hex account IDs. New selections must
exist; previously selected deleted accounts remain removable and do not prevent
an unrelated policy edit. Missing stored values default to empty, and older
administrator writes omitting the field preserve the current list. Revision
conflicts, operation receipts, transactional auditing and permissions retain
their existing behavior. Searching requires `users.read`; changing selections
requires `settings.manage`. Read-only administrators can inspect all selected
pages. Missing account details leave an ID chip that can still be removed.

| Condition                                        | Existing resolved native visibility |
| ------------------------------------------------ | ----------------------------------- |
| Global switch or process flag off                | Hidden: `globally_hidden`           |
| Global switch on, authenticated account selected | Hidden: `user_hidden`               |
| Otherwise                                        | Existing country rules              |
| Remove the account and save                      | Existing global/country rules       |

Android, iOS and Mac continue rendering from `link_import_visible`. File import,
existing imports, retries, queues, jobs and downloads retain their behavior.
The web app and Chrome browser panel retain the existing visibility scope.
The selected-user list never appears in public HTTP or owner socket snapshots.

`GET /processing-policy` remains available to guests without credentials.
Supplied Firebase Bearer credentials follow the existing full account guard,
including revocation, active profile and processing-read budgets. Invalid
credentials cannot downgrade to a guest response. The verified account ID is
passed to the same decision helper used by the owner `policy` snapshot; neither
HTTP nor socket clients can select another account. Country continues to come
from the current HTTP request or that socket's ticket. Existing
`account_policies` invalidation pushes complete policy snapshots, including after
reconnect. No new polling or resource was introduced.

Native startup checkout now uses authentication while signed in. Guest and
per-user caches are separate within existing private installation storage,
with hashed UID paths/keys. Switching accounts restores only that account's
cache or starts hidden. Existing session, request, snapshot and revision fences
discard delayed responses. Guest/local operation still needs no account.

## Main implementation files

- Dashboard: `dashboard/src/features/settings/link-import-user-picker.tsx`,
  `processing-settings-form.tsx`, `processing-settings-page.tsx`, `settings-api.ts`
  and `dashboard/src/api/contracts.ts`.
- Backend: `backend/src/admin-settings/account-policy.service.ts`, schema/DTO,
  `admin-settings.controller.ts`, `backend/src/auth/auth.guard.ts`,
  `backend/src/realtime/realtime-resources.service.ts` and audit validation.
- Native policy/cache transport: Android `ProcessingPolicyRepository.kt`, iOS
  `ProcessingMediaPolicy.swift`, `JobsAPIClient.swift`, `ProcessingModel.swift`,
  and Mac `DesktopAuth.swift`.
- Contracts: `backend/openapi.yaml`, `docs/api/client-contract.md` and
  `docs/realtime-processing-queue/PROTOCOL.md`; corresponding focused regression
  tests and narrow component documentation were updated.

## Validation actually run

| Component         | Command                                                                                                                                                                                                                               | Result and boundary                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend           | `pnpm run verify`                                                                                                                                                                                                                     | Format, lint, typecheck, secret checks, transfer benchmark, 1,672 unit tests, 223 HTTP tests and Nest build passed.                                                                                                                                                                       |
| Backend           | `node --test --test-concurrency=1 test/admin-account-policy.integration.mjs test/realtime.integration.mjs test/url-import-admission.integration.mjs`                                                                                  | 10 passed against isolated loopback Mongo replica-set/Redis fixtures. Covers sorted persistence, legacy omission, invalid/nonexistent IDs, audit/replay, selected-owner hide/unhide across feeds and reconnect, privacy, and preserved queued job/reservation/acquisition/retry behavior. |
| Backend           | Scoped Prettier, `pnpm run lint`, `pnpm run typecheck` and 69 focused policy/realtime tests after final selector hardening                                                                                                            | Passed. Latest built runtime contains the trusted bounded Mongo selector.                                                                                                                                                                                                                 |
| Dashboard         | `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:deployment`                                                                                                                                    | Passed; 190 unit tests and 19 deployment tests, including production build. Existing bundle-size warning remains.                                                                                                                                                                         |
| Dashboard         | `npm run test:e2e -- e2e/link-import-users.spec.ts e2e/processing-policy-contract.spec.ts`                                                                                                                                            | 2 Chrome tests passed. Fixture UI select/save/reload/remove plus compiled-backend policy contract. Screenshot visually inspected; synthetic accounts only.                                                                                                                                |
| Android           | `./gradlew :app:testPlayDebugUnitTest --tests 'com.hatem.musicmute.processing.ProcessingPolicyRepositoryTest' --tests 'com.hatem.musicmute.processing.JobsApiClientTest' --tests 'com.hatem.musicmute.processing.RealtimeClientTest'` | 30 focused JVM tests passed, including owner-cache isolation and delayed checkout fencing.                                                                                                                                                                                                |
| Android           | `./gradlew :app:assemblePlayDebug :app:lintPlayDebug`                                                                                                                                                                                 | Build and lint passed; no device/UI tests or installation.                                                                                                                                                                                                                                |
| iOS               | Focused `xcodebuild test` below                                                                                                                                                                                                       | 25 tests passed: policy cache and API transport, on the prescribed simulator. App/test compilation passed; no UI tests.                                                                                                                                                                   |
| Mac               | `node scripts/test-native.mjs DesktopTests`                                                                                                                                                                                           | Passed with Swift 6 warnings-as-errors; authenticated/guest checkout and cache isolation/restoration fixtures.                                                                                                                                                                            |
| Chrome component  | `npm run verify`                                                                                                                                                                                                                      | Typecheck, lint, build and format passed; 2,228 tests passed, 4 skipped.                                                                                                                                                                                                                  |
| Repository/native | Scoped Swift formatting/lint and `git diff --check`                                                                                                                                                                                   | Passed.                                                                                                                                                                                                                                                                                   |

Android used the existing SDK/JDK:

```sh
ANDROID_HOME=/Users/hatemragap/Library/Android/sdk
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-17.0.2.jdk/Contents/Home
```

The iOS command, from `ios/`, was:

```sh
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  -only-testing:VocalTests/ProcessingPolicyCacheTests \
  -only-testing:VocalTests/JobsAPIClientTests \
  test CODE_SIGNING_ALLOWED=NO
```

Earlier attempts found an unset Android SDK environment, a Mac test assertion
compile/fixture issue, and a dashboard UI-test timeout during parallel checks.
These were corrected, and the relevant commands were rerun successfully.
Those failed attempts are not counted as passing evidence.

The current [official Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-10-08. Applicable rules shaped the documented additive contract
(101), compatibility (106), verified authentication/permissions (104/105),
snake_case properties/query names (118/130), existing HTTP method behavior (148)
and success/error responses (151). Existing public guest checkout is preserved
as the product's public policy read; owner-specific resolution requires the
verified identity. No new event transport or Zalando-specific infrastructure
was introduced.

## Release boundary

These results establish source, local fixtures, native compilation and focused
simulator unit tests. They do not establish deployed backend/dashboard behavior,
real Firebase sign-in, a rebuilt installed Mac app, or a published native release.
Updated clients require rebuilt releases for authenticated startup checkout and
cache isolation. Offline clients retain only their current guest/account cache
until the next successful checkout or owner snapshot.

## Deployment follow-up (2026-10-08)

The owner subsequently requested API and dashboard deployment through CapRover.
Both allowlisted archives byte-matched the tested source and excluded secrets,
tests and generated output. Dashboard deployed successfully with the CapRover CLI
as `img-captain-dashboard:36`, replacing version 35. Active-version read-back
reported one instance, no build, and no changed application configuration fields.
The live `/healthz`, `/settings` and `/runtime-config.js` returned HTTP 200;
CSP/HSTS and runtime `no-store` remained present. Runtime configuration was
byte-identical before/after (SHA-256
`45d17689ab50bf894f8b9086b6cfd37576e1242377d89cb1bcac788eade80512`).
The served settings chunk includes the selected-user controls and matches the
local build after normalizing dependency filename hashes. Those controls were
already present in the prior live bundle; this does not establish a newly changed
chunk or an authenticated save/remove flow on production.

API rebuild was attempted twice through the same CLI/archive. Both attempts
failed during Debian package signature verification. Read-only diagnosis of the
verified CapRover host found its root filesystem at 100%, with zero available
bytes. The existing API remained `img-captain-api:128`, healthy, one instance,
WebSockets enabled, no build and unchanged application settings. Inspection of
its compiled runtime confirmed selected-user exclusions, `user_hidden`, the
validated DTO, optional authentication and trusted HTTP/socket owner handling
already exist there. Live guest policy returned HTTP 200 without exposing user
IDs, and a synthetic invalid Bearer returned HTTP 401 `UNAUTHENTICATED`.

No images, volumes or server data were removed. A reviewed cleanup plan targets
only unused `img-captain-api` images older than version 124, preserves versions
124–128 and other services, uses no forced removal, and stops once 6 GiB is free.
The dry run made no mutations. Explicit owner approval is pending before this
cleanup and another API build. Repository instructions reserve destructive
cleanup for a direct request.

Archive SHA-256:

- API: `233829e7ef244e7fbc61e58fb00fcc9f6969cdb4645c97a0b409f70bf8d469cb`
  (369 files).
- Dashboard: `86c8d9bf8029b18ad0c6dc7d6e102b92e3f93363b1235128e740c9e46d7fb409`
  (146 files).
