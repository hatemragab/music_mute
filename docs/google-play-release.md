# Google Play release guide

Submission guide for `com.hatem.musicmute`, reviewed **2026-10-08** against
current Android source and official Play guidance. This guide prepares the
submission; saved Console declarations, reviewer access, screenshots, device
behavior, backend deployment and approval each require their own evidence.

## Remaining release gates

The October 8 backend changes were deployed with CapRover CLI as
`img-captain-api:125`. Post-rollout checks returned HTTP 200 for `/health/live`,
`/health/ready`, `/app-policy`, `/privacy`, `/delete-account`, `/support` and
`/public-policy`. The live privacy page includes Firebase, Sentry, Cloudflare R2
and MongoDB disclosures; publication metadata is `2026-10-08` and matches the
reviewed correction. Public HTML/security headers were verified. CapRover
confirmed one instance, no build in progress, and unchanged environment/service
configuration. This clears the policy-publication gates from the initial audit.

`GET /app-updates/policy?platform=android&distribution=play` returned HTTP **503**
with `DEPENDENCY_UNAVAILABLE`. Resolve the deployed configuration/registry gate
below before submission; an APK/AAB build cannot repair production configuration.
Mailbox receipt/monitoring, Play App Signing setup, usable reviewer credentials,
review media, phone screenshots, foreground-service video and Android Auto host
behavior remain unverified. This document does not mark any of them complete.

## Public release resources

| Play field           | Production value                            |
| -------------------- | ------------------------------------------- |
| Privacy policy       | `https://api.music-mute.com/privacy`        |
| Account deletion URL | `https://api.music-mute.com/delete-account` |
| Support website      | `https://api.music-mute.com/support`        |
| Support email        | `hatemragapdev@gmail.com`                   |
| Policy metadata      | `https://api.music-mute.com/public-policy`  |

The pages are unauthenticated server-rendered HTML, with no advertising trackers
or public account lookup. The deletion page provides a support-assisted request
route outside the app; support verifies ownership before executing the deletion
workflow. Verify page content after deploying the local backend changes. Send a
sanitized support test and record receipt: a working `mailto:` link proves neither
mail delivery nor monitoring. Keep the published operator identity, Console
contact details and privacy/deletion pages consistent.

The public-page changes preserve the existing routes, GET semantics and explicit
HTML/security headers. They follow rules **106** (compatibility), **148** (HTTP
methods) and **178** (content headers) of the
[Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/),
retrieved 2026-10-08. Local verification does not establish deployed compliance.

Account deletion must be tested in-app and through the external request route.
The source contract provides an exact 15-day recovery deadline; active-system
cleanup starts afterward and retries failures. Privately uploaded local audio,
results and account records are removed by that cleanup. Public-link originals
and results remain in private permanent shared storage; the account's records and
access are removed. A pseudonymous replay fence lasts 24 hours; restricted logs
and backups expire under their actual service lifecycle. User-selected source
files and exported copies remain under the user or receiving provider's control.
Do not promise immediate erasure of all copies. See [account deletion](account-deletion.md)
and [Play's deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111).

## Build and read-only readiness check

From `android/`, using the existing JDK 17, SDK 36 and ignored signing/Firebase
configuration:

```sh
JAVA_HOME=$(/usr/libexec/java_home -v 17) \
  ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew :app:testPlayReleaseUnitTest :app:lintPlayRelease :app:bundlePlayRelease
```

Use a version code greater than every artifact already uploaded for this package;
verify the maximum in Play Console. Upload the **Play release AAB**, with its
recorded version, build, signature and SHA-256. Never upload a direct APK or use
the test authentication variant. Register the **Play app-signing** SHA-1/SHA-256
in Firebase; the local upload certificate does not establish that registration.

From the repository root, run:

```sh
JAVA_HOME=$(/usr/libexec/java_home -v 17) python3 android/scripts/check-play-release.py --live
python3 -m unittest discover -s android/scripts -p 'test_check_play_release.py'
```

The checker reads the actual AAB manifest, verifies its JAR signature, checks
package/version/target SDK, the absence of Android Auto metadata, prohibited
permissions, foreground-service type and native ELF alignment, then checks public production pages and the Play update
snapshot. It makes no deployment, Console, registry or account changes. Without
`--live`, it checks local packaging only. An expected live failure remains until
the backend content and update configuration are corrected through authorized
operations. A passing signature check proves the local bundle signature, not
Play App Signing enrollment or Firebase registration of Google's signing key.

Current source targets API **36**, satisfying the new-app/update requirement
in effect since August 31, 2026. [Target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878).
Native dependencies must support **16 KB** pages. The current official guidance
states update enforcement begins February 1, 2027; preserve compatibility now.
The checker inspects native load-segment alignment and current extracted-library
packaging. A change to uncompressed packaging also requires bundletool/APK ZIP
alignment verification. Neither ELF inspection nor a newer Gradle plugin proves
runtime compatibility: test the delivered APKs in a separately authorized 16 KB
Android environment. [16 KB guidance](https://developer.android.com/guide/practices/page-sizes).

Distinguish the evidence:

| Evidence                      | Establishes                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| Source and JVM tests          | Implemented rules and tested logic                               |
| Locally signed AAB inspection | Actual package, permissions, signature and native packaging      |
| Play-installed device tests   | Google-signed installation, sign-in and real UI/runtime behavior |
| Production checks             | Deployed resource content and service availability at that time  |
| Console review outcome        | Google's decision for the submitted artifact and declarations    |

## Production Play update configuration

Use the existing Releases and Update policy dashboard/registry. The backend
requires `APP_UPDATES_ENABLED=true` in the running deployment and a coherent
published release selection. A Play snapshot resolves the Android
`storeReleaseId` to a **published `google_play`** release; it rejects an
incompatible/unpublished record or a minimum supported build without a usable
target. The source flag default is not proof of the deployed flag's value.

For an authorized release operation:

1. Inspect the deployed runtime flag, current policy revision, shared Android
   minimum and selected Play release record. Diagnose the 503 before
   changing anything; it does not identify one specific failed condition.
2. Make the actual signed build available on the intended Play track. Verify
   affected users/reviewers can install it from that track.
3. Create/publish its real Android `google_play` record through the existing
   registry, using the exact version/build and reviewed package listing URL:
   `https://play.google.com/store/apps/details?id=com.hatem.musicmute`.
   That URL alone is not proof that the build was published on Play.
4. Select that published record as the Android Play release ID. Preview the
   resulting Play decisions through the existing policy workflow. Android is
   Google Play only; the dashboard does not upload an AAB or an APK. Historical
   direct-release records remain read-only and cannot be selected or published.
5. Only advance the Android minimum after the required Play target is available
   to every affected cohort. Re-read the public Play snapshot and confirm source,
   target build and store URL, then test an affected Play-installed client.

Do not create a fictional published build to silence the 503, point Play users
at an APK, or weaken minimum-build enforcement. Optional updates and mandatory
updates must both lead to an available Google Play build. The Play installer
validates the package listing and queries Google Play In-App Updates. Required
updates use the immediate flow when Play offers a build at or above the minimum;
optional updates require the selected target and prefer the flexible flow. A
required build 10 / minimum 12 / target 15 accepts a Play-offered build 14. Consent
alone never clears the blocking gate: after installation, actual build 14 makes
that same policy optional. Flexible downloads offer an explicit restart action,
including after 24-hour deferral or process recreation. The Activity owns its
launcher/listener lifetime and foreground recovery. Errors offer retry and the
validated Google Play listing; there is no direct installer or APK grant path.
[Play update integration](https://developer.android.com/guide/playcore/in-app-updates/kotlin-java).
Before raising the minimum, verify the offered build for every affected audience,
Play account ownership, the package and app-signing key, and the higher version
code. Existing direct installations must not be assumed to transition seamlessly.
[Play update testing requirements](https://developer.android.com/guide/playcore/in-app-updates/test).
[Play self-update policy](https://support.google.com/googleplay/android-developer/answer/16559646).

Implementation references: [snapshot service](../backend/src/releases/release-policy.service.ts),
[publication/selection validation](../backend/src/releases/release-publication.service.ts)
and [dashboard policy form](../dashboard/src/features/releases/update-policy-form.tsx).

## Data Safety preparation

These are source-based draft answers, not saved declarations. Reconcile them
with the exact shipped flavor, live backend, SDK payloads and provider contracts.
The form covers off-device transmissions across clients, SDKs and backend.
Retained account/media/diagnostic records are not ephemeral processing.

Purpose keys below use the exact Console labels: **F** = App functionality;
**A** = Analytics; **S** = Fraud prevention, security, and compliance;
**M** = Account management. [Data Safety taxonomy and purposes](https://support.google.com/googleplay/android-developer/answer/10787469).

| Console category → data type                | Source behavior                                                                                      | Draft collection choice                                                                  | Purposes                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Location → Approximate location             | Cloudflare IP-derived country/city/region and other estimates are retained in account device records | Collected; required for authenticated device reporting; not ephemeral; no in-app opt-out | F, M                                                     |
| Personal info → Name                        | Email registration requires a profile name; Google may supply one                                    | Required; no all-user name opt-out exists in current registration                        | F, M                                                     |
| Personal info → Email address               | Required sign-in/account identity                                                                    | Required                                                                                 | F, M, S                                                  |
| Personal info → User IDs                    | Firebase UID/internal account and owned job references                                               | Required                                                                                 | F, M, S; A where joined to first-party error diagnostics |
| Audio files → Voice or sound recordings     | Submitted speech-containing audio and isolated voice results                                         | Required for the core separation flow                                                    | F                                                        |
| Audio files → Music files                   | Supported user-provided music-containing input                                                       | Required for the core separation flow                                                    | F                                                        |
| Audio files → Other audio files             | Other supported selected audio                                                                       | Required for the core separation flow                                                    | F                                                        |
| Files and docs → Files and docs             | Submitted file names, titles and associated file metadata                                            | Required for core job/history operation                                                  | F                                                        |
| App activity → Other user-generated content | Submitted public source links and optional recovery explanation                                      | Optional: local-file processing needs neither; the explanation can be omitted            | F, M                                                     |
| App activity → App interactions             | Backend job/account actions and usage/security records                                               | Required when using authenticated features                                               | F, S; A only where used for reliability measurement      |
| App info and performance → Crash logs       | Release Sentry crash/ANR reports, privacy filtered                                                   | Required with default release telemetry; no in-app opt-out                               | A                                                        |
| App info and performance → Diagnostics      | Sentry and authenticated first-party technical failure reports                                       | Required with current automatic reporting                                                | A                                                        |
| Device or other IDs → Device or other IDs   | Installation UUID and Firebase/device-session identifiers                                            | Required; optional push registration does not make the whole type optional               | F, M, S                                                  |

Use Required when primary functionality needs the data. Manual submission alone
is not an opt-out. Optional needs an actual choice available to every user; do
not call names or diagnostics optional because some login paths/errors omit them.
Push-token registration respects notification permission, but the installation
identifier is still required. Local bookmarks, A–B controls, waveforms and
unshared temporary passage files stay on-device; review actual outbound payloads
before adding them to the declaration.

Crash diagnosis uses Play's **Analytics** purpose even though MusicMute has no
advertising analytics. Do not select Advertising or marketing, Personalization,
or Developer communications without corresponding live behavior; processing
completion notifications implement the requested service rather than a news feed.
Source inspection found no ads SDK/payment path. Declare ads **No** for this
artifact after dependency/manifest review; re-audit if monetization changes.

### IP-derived location and public privacy correction — 2026-10-08

The backend now receives Cloudflare's IP-derived visitor location and saves its
latest available observation on authenticated account device records: country,
continent, region/region code, city, postal code, metro code, timezone and estimated
latitude/longitude. Country controls native link-import UI visibility; the saved
record is part of account/device management. This is actual geographic inference
and retained collection, not merely a provider receiving an IP address. The
Approximate location draft above therefore applies; it is not ephemeral or an
optional location-permission flow. No GPS/device/browser location permission is
requested. Hiding device history does not erase the underlying record; permanent
account cleanup removes account-linked devices and their saved location.

The public privacy HTML was corrected to disclose the source, fields, purposes
and retention, and to identify coordinates as IP-derived estimates rather than
GPS measurements, without a precision or accuracy promise. Verify the deployed
privacy page contains this disclosure before treating the Console URL as current.
This source edit does not itself establish a deployed policy or saved Data Safety
answer. [Stored fields and parser](../backend/src/devices/cloudflare-location.ts),
[device writes](../backend/src/devices/devices.service.ts),
[public policy](../backend/src/public-pages/public-pages.controller.ts),
[Cloudflare visitor location](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/#add-visitor-location-headers).

Do not infer **Precise location: No** from the absence of GPS permission or the
word “estimated.” Play includes IP-inferred location in both types: approximate
is an area of at least 3 km²; precise is an area below 3 km². Retained latitude/
longitude values have no stored accuracy radius, so their decimal representation
alone does not establish that classification. Review the actual Cloudflare
geolocation accuracy and any other shipped SDK/provider payloads before finalizing
the precise-location answer. There is no verified basis here for an unconditional
precise-location exclusion. [Official location taxonomy](https://support.google.com/googleplay/android-developer/answer/10787469).

Local video preparation submits audio, not the original video; declare
Photos/Videos only if a shipped flow or provider payload actually sends those
data types.

For sharing, inspect the current contracts and instructions for Firebase,
Sentry, API/worker hosting, database, Cloudflare R2/network services and active
acquisition providers. An on-behalf-of-operator processing agreement can support
the service-provider exception; an SDK/vendor name cannot. Independent reuse,
advertising profiling or other third-party purposes require a separate assessment.
A deliberate user-directed export may qualify for the user-initiated sharing
exception. Record the basis before answering No to sharing. Exceptions to sharing
do not remove collection or public privacy-disclosure obligations.

Declare encryption in transit only after release traffic/provider review.
Declare a deletion request mechanism only after both in-app and external routes
are operational and tested. Provider data retention and the published policy
must match the current account/media cleanup contract above.

## Reviewer access: unfilled template

**No verified reviewer account or completed sample is recorded by this guide.**
The placeholders below must be filled privately in Play Console only after a
clean Play-installed sign-in and sample playback/export succeed. Do not submit
this template with placeholders or its conditional statements as assertions.

```text
MusicMute requires authentication.

Username/email: <UNFILLED: verified reusable reviewer account>
Password: <UNFILLED: save only in Play Console>
Completed Library sample title: <UNFILLED: verified rights-cleared audio>

Access verification: <UNFILLED: confirm no OTP/device approval/location restriction,
credential expiry or expiring invitation; verify adequate processing allowance>

Review steps after these access checks have passed:
1. Sign in with the supplied account.
2. Open Library and select the supplied completed sample.
3. Play Voice and Original, then save/share the result if requested.
4. To create a job, select supplied rights-cleared local audio on Home,
   review the cloud disclosure, confirm permission and submit.
5. Open Account for Privacy policy, Account deletion help and Delete account.

Support during review: hatemragapdev@gmail.com
```

Keep credentials, allowance, media, API and workers available throughout review.
The account must be reusable worldwide. If deletion testing consumes it, replace
and reverify reviewer access before the next review. No credential, mailbox
content or private review media belongs in Git.
[Reviewer requirements](https://support.google.com/googleplay/android-developer/answer/15748846).

## Foreground service: mediaPlayback

Current Play source declares only `mediaPlayback` and removes WorkManager's
foreground service. Confirm the uploaded AAB still matches. Do not declare
`dataSync` or other types absent from that artifact.

Suggested Console description:

> After the user starts a completed track, MusicMute uses a mediaPlayback
> foreground service to continue audible playback when the app is backgrounded.
> The Android media notification identifies the active track and provides controls.
> The user can pause or stop playback. Media3 manages the idle service lifecycle.

Deferred-start impact: requested background playback cannot start immediately.
Interrupted-task impact: audio stops and the user must resume playback. Select
the media-playback use case and supply a video matching the submitted build.
[Foreground-service declarations](https://support.google.com/googleplay/android-developer/answer/13392821).

Record this shot sequence on a separately authorized Android device using
rights-cleared audio and no private account details:

1. Show the submitted app version and a completed Library sample.
2. Start audible Voice playback; show its title and play/pause controls.
3. Open the notification shade and show the media notification/controls.
4. Background MusicMute; demonstrate that audible playback continues.
5. Pause/resume through the notification, then stop playback; demonstrate audio
   ends and controls/notification correctly reflect the stopped state.
6. Check the service's idle/termination behavior; do not claim immediate shutdown
   from a recording that only proves paused audio.

The shot sequence is a recording plan. No recording or FGS runtime verification
is established by this document.

## Android Auto and device acceptance

The current manifest does not advertise Android Auto. Version 22 (1.0.2) was
reported by Play as crashing at Android Auto launch, and was present in the
production, closed Alpha and internal testing tracks. Removing the declaration
from a new bundle does not change those already uploaded artifacts; check each
track and follow the policy issue's replacement instructions in Play Console.
The cause of the reported crash has not been established.

If Android Auto support is reintroduced, the account-scoped media library and
localized authentication/update/unavailable errors require host validation.
[Car quality requirements](https://developer.android.com/docs/quality-guidelines/car-app-quality),
[error guidance](https://developer.android.com/training/cars/media/errors).

Before distributing Auto support, use an explicitly authorized Android phone
with the [Desktop Head Unit](https://developer.android.com/training/cars/testing/dhu)
and select its serial/device ID explicitly. Verify browse/search/voice actions,
play/pause/queue, offline/missing media, reconnect, cold restoration, sign-out and
account switching. Signed-out and required-update states must show localized
instructions to use the phone **when it is safe to do so**, resolve to the right
phone screen and expose no prior-account audio. Check English/Arabic, rotary
navigation, contrast and host launch/content timing. The iPhone simulator cannot
validate Android Auto; these host/device checks remain outstanding.

Also exercise Play-installed Google/email sign-in, optional/mandatory updates,
background playback, sleep/loop/silence controls, export/sharing grants, widgets,
large fonts, TalkBack, Arabic RTL and account deletion with disposable data.
Compile-only instrumentation and mocked/JVM tests do not satisfy these checks.

## Listing assets and Console completion

Use [the Play listing preparation directory](../android/play-listing/README.md)
for English/Arabic text, icon/feature-graphic generation and the screenshot shot
list. Generated brand artwork is an asset, not evidence that an app screen or
processed sample ran. Phone screenshots and demonstration video must depict the
actual submitted UI. Make no unsupported availability, speed, quality,
free/unlimited, privacy or copyright claims. The macOS destination now reads
Coming soon and has no active download action.
[Listing asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151).

Complete and verify these Console-only gates:

- Developer identity/contact/package registration and Play App Signing.
- Firebase registration of the Play app-signing certificate.
- Store text/assets, countries and tracks; accurate category/target audience,
  content rating, ads, News and other applicable App content declarations.
- Saved Data Safety responses and live privacy/deletion URLs.
- Reusable reviewer access and the completed-sample instructions.
- `mediaPlayback` declaration and demonstration video; Auto form-factor review.
- Pre-review checks and pre-launch report, with critical issues resolved.
- For personal accounts created after November 13, 2023: at least 12 closed-test
  users opted in continuously for 14 days, followed by production-access approval.

The developer account type/date and testing eligibility were not inspected.
[Testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465),
[prepare an app for review](https://support.google.com/googleplay/android-developer/answer/9859455),
[User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311).
