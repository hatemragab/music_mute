# Import failures and retries, 2026-10-01

## Production diagnosis

Read-only logs from the MusicMute VPS were examined for 10:39:00–11:02:17 UTC
on 2026-10-01, after the owner-authorized JoJAPI activation. The correlated
adapter/router counts were:

| Event                                                               | Distinct executions |
| ------------------------------------------------------------------- | ------------------: |
| JoJAPI `/download` returned HTTP 200                                |                  16 |
| Audio transfer completed through adapter and router                 |                  14 |
| Google media returned HTTP 403; router returned dependency HTTP 503 |                   2 |

The failed Google transfers occurred at 10:52:18.588 and 10:58:18.764 UTC.
Each followed a successful vendor response and ended after approximately eight
seconds. Stage and final records describe the same two failures; duplicate log
records are not additional failed executions. No HTTP 429 or import-queue outage
marker appeared in this bounded window. Raw URLs, media, credentials, account
identifiers and vendor payloads were not copied into this record.

The Android message “The import service is temporarily unavailable. Try again
shortly.” covers dependency/storage failures. The observed production dependency
failures came from refused Google media delivery, not a failed JoJAPI resolver
response. The screenshot was not correlated to specific database records, so
these counts establish the observed failure path rather than the identities of
the screenshot's cards.

Fourteen successful transfers in the same window do not support a blanket IP
block. The 403 response alone does not distinguish IP binding, signed-link
authorization, source restrictions or a temporary refusal. Matching the supplied
headers/cookies cannot make the VPS share the vendor's network egress; see the
[request-context qualification](REQUEST-CONTEXT-2026-10-01.md). Retries can recover
some transient failures but cannot guarantee Google acceptance. The previously
documented vendor source-version defect also remains unresolved.

## User-visible recovery

Android Home now offers **Try again** alongside Delete for eligible failed URL
imports. The saved source, trim setting and prior consent are retained. Known
terminal imports start one new request UUID; uncertain admissions resume the same
identity and existing subscription. Current stored state, duplicate-tap protection,
session fences and loading state prevent stale or repeated submissions. Invalid
input, policy denials and conflicts remain removable without automatic recovery.

New server admissions have [three automatic acquisition retries](../../../docs/url-imports/retries-2026-10-01.md)
after the first attempt, with durable 5/10/20-second backoff. The same import,
shared producer, frozen recipe and one usage hold survive retry. Only eligible
transient failures before an upload intent/job reservation can acquire again.
Each execution makes one paid provider call. Historical failed imports are not
bulk requeued. Processing jobs use the separate
[four-attempt processing budget](../../../docs/processing-retries-2026-10-01.md).

## Validation boundary

Android direct/play JVM tests (332 direct and 312 play), lint and debug builds passed. A signed direct
release APK and direct release lint also passed; APK signature validation passed
with package `com.hatem.musicmute`, version `0.1.13` / build `14`, minimum SDK 26
and target SDK 36.
The existing direct-release version number was retained. The later connected
Android installation is recorded below.

The final command, with JDK 17 and the existing Android SDK, was:

```sh
./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:assembleDirectDebug :app:assemblePlayDebug \
  :app:assembleDirectRelease :app:lintDirectRelease \
  -PauthApiUrl=https://api.music-mute.com
```

It completed successfully in 51 seconds. Lint had no errors; warnings remain.
`apksigner verify --verbose` passed on the final APK, and generated release
configuration confirmed `https://api.music-mute.com`. The review artifact is
`/tmp/musicmute-try-again-20261001-release.apk`, with SHA-256
`bf8661f0d04ba4261cb9d7f60eb147f40bc3ef289630bdcdbbac033f38b92b0f`.

The main client changes are `UrlImports.kt`, `AudioTaskPresentation.kt`,
`VocalApp.kt`, `HomeScreen.kt`, `JobCard.kt` and `ProcessingLabels.kt`, with
coordinator/presentation tests. The server changes are the URL-import
schema/service/processor/runtime, `import-retry.ts`, safe error mapping, the
account-policy default and related tests/contracts. Backend delivery is recorded
in the [retry policy](../../../docs/url-imports/retries-2026-10-01.md).

The backend command results and deployment evidence are recorded in the retry
policy document after final validation. Synthetic retry fixtures make no paid
provider calls and do not establish future Google or vendor availability.

## Connected Android release installation

After the user's explicit request to push the source and run the release on the
connected Android phone, the signed APK above was installed in place on the
existing OPPO CPH2573 at approximately 13:48 UTC. The installed package and new
APK had the same upload signing certificate. Replacement installation with
`adb install --user 0 -r -t` returned `Success`; package inspection confirmed
version `0.1.13`, build `14`, and the original first-install timestamp. No
uninstall or app-data clearing was performed.

`am start -W -n com.hatem.musicmute/.MainActivity` returned `Status: ok` with a
267-millisecond cold launch. The process remained alive, and the current process
had no crash-buffer entries. The phone's secure keyguard remained locked and its
screen was off, so this is installation/process-launch evidence, not visual
verification of Home or Try again. No paid import or retry was initiated on the
phone during this check.
