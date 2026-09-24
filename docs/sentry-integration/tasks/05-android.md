# SEN-05 — Native Android

Status: TODO. Priority: P1. Dependency: SEN-01.

## Owned implementation scope

Version catalog, root/app Gradle scripts, manifests, `VocalApplication.kt`,
processing/download/playback failure boundaries, and JVM tests.
Proposed: a local typed observability adapter and configuration helper.

## Work

1. Pin compatible Android SDK/Gradle plugin versions. Configure direct/play and
   debug/release/authE2e variants explicitly. Disable telemetry and all upload
   tasks for tests/developer defaults; never embed build upload tokens.
2. Choose early manual initialization with manifest auto-init disabled so the
   sanitizer/configuration exists before capture. Confirm this timing with the
   pinned SDK and existing Firebase initialization; cover startup exceptions.
3. Enable required crash and ANR capture with safe context. Evaluate native NDK
   capture separately for media-library crashes and available symbols. Leave
   replay, screenshots, view hierarchy, profiling, and automatic logs off.
4. Report unexpected handled WorkManager/coroutine/download/preparation/playback
   failures at their original boundary. Preserve CancellationException, retries,
   background work results, and `ClientErrorOutbox` semantics. Do not capture
   again during durable outbox flush or map every failed download to a defect.
5. Scrub nested throwable messages, file/content URIs, media names, signed network
   grants, Firebase/session fields, and SDK breadcrumbs. Scope asynchronous work
   by immutable operation context and clear account context on logout/deletion.
6. Provide bounded offline SDK cache behavior and test opt-out/cache handling.
   Wire release/build/flavor identity and SEN-08 mappings when generated.
7. Review privacy copy and Play Data safety declarations against actual payloads;
   record required store changes for later authorized publication.

## Acceptance and tests

- [ ] JVM tests cover configuration, redaction, classification, duplicate suppression,
      owner/session changes, offline delivery failure, and cancellation behavior.
- [ ] Merged manifests show no unintended collection or upload in debug/authE2e.
- [ ] Both distribution flavors pass tests/lint/build with safe local configuration.
- [ ] Existing processing and outbox tests pass; no main-thread network/flush await.
- [ ] Release stack readability and native/ANR delivery are explicit separate gates.

From `android/`, run:

```sh
./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:assembleDirectDebug :app:assemblePlayDebug
```

Inspect release build tasks/mappings when signing prerequisites are available;
do not expose or replace signing files. **Android device/UI/crash/ANR testing is
blocked by the standing device restriction.** The authorized iPhone simulator
cannot provide Android runtime proof. Do not substitute another device or create
an Android emulator. Record the gate until the user explicitly changes scope.
