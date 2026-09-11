# Account deletion and import-first implementation

Local implementation, 2026-09-10. Both native apps, the shared backend, worker protocol and public pages are implemented. YouTube remains secondary as requested. No commit, push, deployment, store submission or production account deletion was performed.

## Behavior and main files

- Android `app/src/main/java/com/hatem/musicmute/` and iOS `Vocal/`: import-first Home, explicit secondary YouTube download, durable input review and rights confirmation before cloud processing. Selection or paste alone cannot start a cloud job. Playback remains explicit and vocals-only.
- Native authentication/session and processing repositories: recent provider reauthentication, final deletion confirmation, durable accepted/uncertain request journals, restart recovery and owner-scoped private cleanup. A late response for account A cannot erase account B. Definitive first-request refusal preserves the session and media; a later refusal cannot erase prior uncertainty. Apple reauthentication obtains an ephemeral authorization code for Firebase token revocation.
- `backend/src/users/account-deletion.service.ts`, `account-deletion-cleanup.service.ts`, `user-identity-fence.service.ts`, and `account-access.service.ts`: durable deletion acceptance, transactional access fencing, bounded leased cleanup, and a 24-hour pseudonymous replay fence after Firebase deletion. The request returns HTTP 202 accepted, not completed. Cleanup remains active when audio processing is disabled.
- Backend auth, devices, jobs, push and diagnostics services: account checks participate in writes to prevent concurrent creation after deletion acceptance. Worker and notification completion paths are fenced as well.
- `backend/src/worker/` and `windows-worker/`: deletion waits for worker shutdown and explicit local-data cleanup acknowledgement. The worker persists pending cleanup, purges the confined job directory and acknowledges before accepting another job. A lost lease does not prove that the old process stopped.
- `backend/src/public-pages/`, `backend/src/operations/`, and `backend/docs/account-deletion.md`: public `/delete-account` and `/privacy`, plus an ownership-verified operator deletion command. Public pages require configured identity, contact, timeframe and retention fields; incomplete configuration returns HTTP 503. Caller-supplied public identifiers cannot authorize deletion.
- `docs/store/`, native READMEs, backend API documentation and root README: listing draft, support runbook, configuration and release evidence.

## Executed validation

Backend commands ran from `backend/`:

| Command                               | Result                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run verify`                      | Passed formatting, lint, TypeScript checking, 432 unit tests, 38 HTTP tests and Nest build |
| `npm run test:auth:integration`       | Passed 17 isolated integration tests                                                       |
| `npm run test:processing:integration` | Passed 21 isolated integration tests                                                       |
| `npm run test:experience:integration` | Passed 1 integration test                                                                  |
| `npm run test:deletion:integration`   | Passed 2 integration tests covering acceptance races and cleanup                           |
| `npm run test:integration`            | Passed infrastructure integration test against final compiled backend                      |

`node --test test/auth.integration.mjs` additionally passed against the final compiled backend after public-route assertions were added. It checks unconfigured public routes return 503, configured root routes return 200, and real authenticated account deletion remains reachable under restrictive application policy. A same-second Firebase authentication fixture collision was corrected by separating the return sign-in from the intervening owner; production ambiguity protection is unchanged. The changed fixture also passed Prettier checking; `git diff --check` passed.

Android commands ran from `android/` with JDK 17:

```sh
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug \
  :app:assembleRelease :app:lintRelease :app:testReleaseUnitTest :app:bundleRelease
```

Passed: 153 tests across 28 suites in each variant, debug/release APKs and signed release bundle. Each lint variant reported zero errors and 38 warnings. Regression coverage includes consent persistence, deletion recovery, switched owners, remote invalidation, uncertain retries, and bounded token/HTTP acquisition with durable late receipt persistence. No Android device/UI test was run.

iOS final command ran from the repository root:

```sh
xcodebuild -project ios/MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath ios/DerivedData -parallel-testing-enabled NO \
  -only-testing:VocalTests \
  -only-testing:VocalUITests/VocalUITests/testHomeValidationAndSettings \
  test CODE_SIGNING_ALLOWED=NO
```

Passed: 136 unit tests and Home/settings UI. Separate targeted runs passed `ProcessingUITests/testAccountDeletionFinalConfirmationCanBeCancelled` and `ProcessingUITests/testExplicitDownloadAndNativeFileRequireRightsAndCloudConfirmation`, including actual native Files selection of synthetic MP3 audio. Those runs contained an earlier Home assertion failure; only the named passing scenarios are claimed, followed by the corrected passing final command above. Five additional fixture-based UI scenarios passed in the earlier broader run; two opt-in live tests were skipped. Only the designated existing iPhone 17 Pro, iOS 26.0 simulator was used, with no clones. Strict Swift formatting, plist validation and matching 270-key English/Arabic localization checks passed.

Worker command from the repository root:

```sh
PYTHONPATH=windows-worker python3 -m unittest discover -s windows-worker/tests -v
```

Passed: 127 tests, with 23 platform-specific skips. This is host-side Python evidence, not native Z440 proof. Backend cleanup/worker tests separately exercised acknowledgement and cleanup fencing. Scoped independent reviews covered backend acceptance/public operations and Android recovery races; reported race findings were corrected and regression-tested.

## Required before release

- Supply actual public domain, developer name, monitored support email, deletion timeframe and retention notice; configure both apps' HTTPS privacy/deletion URLs and verify the deployed pages and mailbox. No publication values or operational commitments were invented.
- Deploy the backend before the updated Windows worker. Historical attempts without local-cleanup proof remain blocked pending operator reconciliation; do not bypass that proof or automatically unlock lost leases.
- Exercise a disposable real account through provider reauthentication/revocation, worker cancellation and native Z440 purge, S3 versions/grant expiry, database cleanup and Firebase deletion. Local fixtures do not prove production cleanup or delivery.
- Validate native Windows startup/self-test/one-job processing, Android device behavior when authorized, iOS release signing, signed store artifacts and truthful store disclosures/screenshots. No store approval is claimed.
- Offline devices can purge only after reconnecting. Exported/original user files and data belonging to another account are preserved. Infrastructure backups, operational logs and support records require accurate operational retention configuration.
- Keeping YouTube secondary retains downloader-related rights and review risk. Rights confirmation records user intent; it does not establish copyright permission or guarantee store acceptance.

The checkout already contained unrelated changes. Work remained local and those changes were preserved. Mongoose deprecation warnings and Android lint warnings remain; validation did not report failures from them.
