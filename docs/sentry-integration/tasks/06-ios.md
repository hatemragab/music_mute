# SEN-06 — Native iOS

Status: TODO. Priority: P1. Dependency: SEN-01.

## Owned implementation scope

`ios/project.yml`, `ios/Vocal/VocalApp.swift`, app configuration, processing/
background failure boundaries, `ClientErrorOutbox.swift`, privacy manifest and
tests. XcodeGen is the source of truth; do not hand-edit generated project files.

## Work

1. Add pinned Sentry Cocoa through Swift Package Manager in XcodeGen. Define
   public build settings for enablement, DSN and environment; keep test/UI-fixture
   launches disabled unless using a fake transport or explicit smoke-test build.
2. Initialize early in the SwiftUI app before `ProductionAppGraph` construction,
   preserving the UIApplicationDelegateAdaptor and push/background callbacks.
   Verify crash-handler interactions and launch ordering with the pinned SDK.
3. Capture unexpected processing, background transfer, playback and storage
   failures at original boundaries. Preserve Swift cancellation and owner fences;
   never recapture each `ClientErrorOutbox.flush` attempt.
4. Scrub URL/request metadata, NSError userInfo, local paths, titles, account
   identifiers, and breadcrumbs. Do not send replay, screenshots, view hierarchy,
   profiling, attachments, or broad logs. Clear scoped context at account changes.
5. Configure bounded offline caching and test safe logout/deletion/disabled modes.
   Review collected diagnostics against the privacy manifest and App Store privacy
   answers; record publication work separately.
6. Add release/build identity. Prepare dSYM generation/upload via SEN-08 while
   retaining `ENABLE_USER_SCRIPT_SANDBOXING=YES`; prefer a controlled post-archive
   upload over weakening the project's script sandbox globally.

## Acceptance and tests

- [ ] Unit tests cover sanitizer, config, unexpected/expected error classification,
      session changes, duplicate capture, and SDK/transport failure isolation.
- [ ] XcodeGen regeneration remains reproducible and fixture launches stay offline.
- [ ] Authorized simulator tests preserve authentication, processing, playback,
      background callbacks and error presentation.
- [ ] A separate crash/relaunch smoke test verifies receipt with debugger detached;
      ordinary handled-error tests do not prove fatal crash capture.
- [ ] Simulator proof, release dSYM proof, physical-device/watchdog behavior and
      App Store rollout are reported separately.

From `ios/`, after required local configuration is available:

```sh
xcodegen generate --spec project.yml
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO
```

First verify that this existing device is iPhone 17 Pro / iOS 26.0. If unavailable,
record the blocker. Never choose another device, create a clone, or download a
runtime. Intentional crash tests must use an isolated test build/fixture on that
device under the implementation test scope, without damaging existing app data.
