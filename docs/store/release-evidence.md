# MusicMute release evidence

Local implementation snapshot, 2026-09-10. No deployment, store submission, production deletion or store approval is claimed. The [consolidated validation record](../validation/2026-09-10-store-readiness.md) contains final backend and iOS evidence and supersedes preliminary counts below.

## Android snapshot

Executed in `android/` with JDK 17 and the existing Android SDK:

```sh
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease
```

At the Android implementation handoff, 146 JVM tests across 28 suites passed with zero failures/errors. Lint reported zero errors and 38 warnings. Debug and signed release APK assembly passed. The release merged manifest retained WorkManager `dataSync` and Media3 `mediaPlayback` service types, with no broad storage permission. Test coverage included persisted cloud-consent review, cancellation without creating a cloud job, recoverable deletion responses, a restart journal and owner-scoped cleanup.

Source inspection showed import-first home, explicit secondary YouTube download permission, a separate review before cloud upload, and explicit-tap vocals-only playback. This is source/unit/build evidence. It is not device proof of document pickers, provider reauthentication, long transfers, process termination, playback cleanup or production deletion.

Android runtime/UI tests are outside the authorized scope: the only authorized native UI target is the existing iPhone 17 Pro, iOS 26.0 simulator, UDID `$IOS_SIMULATOR_UDID`. No Android device was substituted. Exact Play bundle validation and demonstration recordings remain release requirements; an assembled release APK is not equivalent to bundle/store review proof.

The review follow-up passed all seven tasks together: debug unit tests/lint/APK, release APK/lint/unit tests and signed release bundle. Both debug and release had 153 tests across 28 suites with zero failures/errors. Race tests cover an accepted A receipt after switching to B, owner-specific startup recovery and writer cleanup, invalidated-session purge, preserving earlier uncertainty after a rate-limited retry, and a 20-second token/HTTP deadline with durable receipt persistence outside the deadline. Android device/UI proof remains outstanding.

## Public pages

Executed in `backend/`:

```sh
npx prettier --write src/public-pages
npm test -- src/public-pages/public-pages.controller.spec.ts
```

Eleven controller/HTTP tests passed. They cover an actionable mailto request without a bearer, required publication fields, HTTP 503 when fields are absent, unsafe email/header rejection, HTML escaping, ignored caller-supplied identities, no POST/DELETE public mutation, privacy content and restrictive script CSP.

The first test run failed because the new module/controller did not yet exist. The implementation then passed. These tests use local synthetic configuration; `example.test` addresses are fixtures, not a published support destination. Focused public-page lint subsequently passed with zero warnings/errors. Global module/prefix integration and final backend lint/typecheck/build are verified separately by the integrating task.

The public pages contain semantic headings, labelled navigation, visible keyboard focus, responsive text and no external script/style dependency. A deployed-browser accessibility review, real mail-delivery exercise and public-route check have not been performed. Missing public identity/contact/timeframe/retention configuration intentionally leaves the routes at HTTP 503.

## Remaining integration evidence

| Area                   | Evidence required before release                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS                    | 136 unit tests and final Home/settings UI passed, plus targeted native Files/consent/deletion-cancel scenarios; real provider authentication and release signing remain |
| Backend                | Final verification passed: 432 unit tests, 38 HTTP tests, integration suites and build; live disposable deletion remains                                                |
| Disposable lifecycle   | Accepted request through safe storage cleanup, Firebase deletion and finite replay-fence expiry                                                                         |
| Public resource        | Actual domain, developer identity, monitored mailbox, verified ownership process, supported timing/retention and live URL verification                                  |
| Android store artifact | Exact signed bundle inspection and truthful foreground-service demonstration using owned/licensed audio                                                                 |
| Listing                | Owned-audio screenshots/video, visible secondary YouTube flow and matching features/privacy/deletion URLs                                                               |
| Data Safety            | Verified collected/shared categories, provider destinations, operational logs, backups and actual finite retention                                                      |

Do not mark the final Data Safety form from a source-code inventory alone. Firebase identity/profile, installation/device/push records, audio inputs/vocals results, source/job metadata, bounded diagnostics, infrastructure logs and backup/support retention need operational reconciliation. The public privacy draft describes Firebase, MongoDB and S3, plus the 24-hour pseudonymous security replay fence; operator-supplied retention must reflect actual infrastructure.

## Policy sources checked 2026-09-10

- [Google Play account deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en): in-app and actionable external request route; an inaccessible or unconfigured page is not publication-ready.
- [Google Play User Data](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en): accurate privacy/data-handling disclosures.
- [Google Play Intellectual Property](https://support.google.com/googleplay/android-developer/answer/9888072?hl=en): retained source downloading remains a distribution/rights risk; user confirmation does not establish permission or guarantee approval.

See [listing draft](owned-audio-listing.md) and [support runbook](account-deletion-support-runbook.md). Neither document authorizes publication or real-account deletion.
