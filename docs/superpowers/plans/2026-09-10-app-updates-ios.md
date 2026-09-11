# MusicMute iOS App Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional and whole-app mandatory iOS update prompts with English changelogs and the same offline/timing rules as Android.

**Architecture:** An application-owned Swift update coordinator checks public policy independently of authentication. A root SwiftUI gate owns enforcement and interacts with playback/processing through a small admission boundary. Installation is handed off to the App Store.

**Tech Stack:** Existing Swift/SwiftUI, Foundation/URLSession, atomic local persistence and XCTest; no third-party updater or IPA installation mechanism.

**Spec:** [Design and contracts](../specs/2026-09-10-app-updates-design.md).

## Global Constraints

- Read `ios/README.md`, `ios/project.yml`, `VocalApp.swift`, current auth, processing and playback source before editing.
- Launch/reconnect checks, **15-minute** foreground/online checks, due foreground entry, no background polling; optional Later defers **24 hours**.
- English-only changelog; preserve EN/AR UI localization and accessibility.
- Whole-app required gate includes local playback, navigation, imports and notification taps. Do not logout, delete files, cancel submitted cloud jobs or modify server worker state.
- Offline with no known required policy preserves existing auth/offline behavior; known required state persists and request failures do not clear it.
- Device/UI tests only on **iPhone 17 Pro, iOS 26.0**, UDID **$IOS_SIMULATOR_UDID**. Report absence rather than substituting.
- Plan-only turn; no code changes, commits, store publication or deployment authorized here.

---

## File structure and interfaces

Create `ios/Vocal/Updates/{UpdateModels,UpdatePolicy,UpdateStore,UpdateAPIClient,UpdateCoordinator,UpdateGateView,UpdateAdmission,StoreUpdateLauncher}.swift` and `ios/VocalTests/{UpdatePolicyTests,UpdateCoordinatorTests,UpdateGateTests,StoreUpdateLauncherTests}.swift`.

```swift
enum UpdateDecision: Equatable { case none, optional, required }
enum UpdateTrigger { case launch, reconnect, foreground, interval, retry, processingRejected }
func decideUpdate(installedBuild: Int, snapshot: UpdatePolicySnapshot) throws -> UpdateDecision
protocol UpdatePolicyFetching: Sendable {
  func fetchPolicy() async throws -> UpdatePolicySnapshot
}
@MainActor protocol StoreUpdateOpening {
  func open(_ url: URL) async throws
}
```

`UpdateModels.swift` mirrors the spec JSON exactly. `UpdateCoordinator` is `@MainActor ObservableObject`, exposes published `decision`, `snapshot`, `checking`, `failure`, and methods `check(trigger:) async`, `deferOptional() async`, `setForeground(_:)`. Inject installed-build reader, clock, reachability, store and API into it; production reads the real bundle integer build and rejects invalid release metadata.

## Task UPD-I01: Policy decoding, persistence and foreground scheduling

**Files:** Create models/policy/store/API/coordinator files and `UpdatePolicyTests.swift`, `UpdateCoordinatorTests.swift`. Integrate construction in `ios/Vocal/VocalApp.swift`; adjust `ios/project.yml` only if project generation does not include new sources automatically.

**Interfaces:** Public `GET /app-updates/policy?platform=ios&distribution=app_store`, no Firebase bearer. Store an atomic installation-wide snapshot and reminder/check times, independent of account settings.

- [ ] Add table-driven decision tests using the shared fixtures: below minimum, optional, equal/newer build, no release, malformed target, invalid URL and unsupported schema. Old optional JSON fields do not break decoding; malformed critical fields never overwrite good state.

```swift
XCTAssertEqual(try decideUpdate(installedBuild: 9, snapshot: snapshot), .required)
XCTAssertEqual(try decideUpdate(installedBuild: 10, snapshot: snapshot), .optional)
XCTAssertEqual(try decideUpdate(installedBuild: 12, snapshot: snapshot), .none)
```

- [ ] Write fake-clock tests at 899/900 seconds and 86399/86400 seconds. Cover first offline start, known required cache, policy withdrawal, concurrent launch/reconnect, clock rollback and suppressed optional prompt across a newer optional release.
- [ ] Implement bounded public URLSession transport, strict platform/store source validation and atomic persistence. Do not reuse an authenticated transport that fails before login or leaks a bearer to an external destination.
- [ ] Implement one cancellable foreground timer and one in-flight request. Network path changes trigger checks after debounce; cancel timers on background. Retry failures at 30 seconds/2 minutes/normal interval, honor Retry-After and retain last valid state.
- [ ] Hook `scenePhase` and reachability at application scope. Do not add independent policy timers to individual tabs or `AccountView`. An app upgrade re-evaluates cached policy using the installed bundle build.
- [ ] Run `UpdatePolicyTests` and `UpdateCoordinatorTests` on the exact designated simulator using the V02 command. If unavailable, run allowed static/build checks and record the simulator blocker without substituting a device.

**Acceptance:** The iOS coordinator makes the same decisions as Android/backend fixtures and obeys agreed timing/offline behavior before login.

## Task UPD-I02: Whole-app gate and non-destructive local pause

**Files:** Create `UpdateGateView.swift`, `UpdateAdmission.swift`, `UpdateGateTests.swift`; modify `VocalApp.swift`, `Playback/AudioPlayer.swift`, `Processing/{ProcessingRepository,AudioPipelineCoordinator,BackgroundTransferCoordinator,JobArtifactRepository,JobsAPIClient,NotificationDelegate}.swift`, source/import entry points and EN/AR `Localizable.strings`.

**Interfaces:** `@MainActor UpdateAdmission` exposes `isBlocked` and `requireAllowed() throws`. Add a dedicated `pauseForUpdate()` operation to local processing orchestration; it must preserve cloud job IDs/input records and never call cloud cancellation/deletion or auth teardown.

- [ ] Write gate tests proving required state replaces the whole root content, blocks back/sheet dismissal, prevents notification navigation/imports, stops active playback and rejects remote-play commands.
- [ ] Write processing tests that pause only local transfers/preparation, preserve input and submitted-job records, and make zero cloud cancellation/deletion calls. Continue accepting safe server-state synchronization without exposing gated screens.
- [ ] Place `UpdateGateView` outside the existing authentication routing. Required UI includes version, English changelog, Update and Retry, with safe offline/network errors. Optional UI offers Later and Update; Later persists exactly 24 hours.
- [ ] Separate update pause from `setSession(nil)` and sign-out cleanup, because those have broader account effects. Fence delayed local callbacks against update admission, preserve account ownership and avoid marking cloud jobs cancelled.
- [ ] Convert only typed `APP_UPDATE_REQUIRED` transport errors into provisional required state plus fresh policy check. A 403 for disabled account or email verification remains its original auth policy error.
- [ ] Handle background URLSession callbacks and notification completion while blocked without starting playback, opening tabs or issuing new processing submissions. When upgraded, reconcile before restoring pending navigation/local work.

```swift
await coordinator.check(trigger: .launch)
XCTAssertEqual(coordinator.decision, .required)
XCTAssertEqual(cloud.cancelCalls, 0)
XCTAssertEqual(cloud.deleteCalls, 0)
XCTAssertNotNil(await store.operation(id: operationID))
```

Use the existing store/repository test patterns to build the `cloud` and `store` fixture; if an async value cannot be used inside an XCTest autoclosure, await it into a local variable before asserting.

- [ ] Run focused gate/processing/playback tests and build. Add root UI scenarios to V02; no alternate simulator or device is permitted.

**Acceptance:** Required state blocks all normal use without deleting media or cancelling work already accepted by the server.

## Task UPD-I03: App Store handoff and return behavior

**Files:** Create `StoreUpdateLauncher.swift`, `StoreUpdateLauncherTests.swift`; integrate with `UpdateGateView.swift` and coordinator lifecycle. Update `ios/README.md` with store prerequisites and proof boundaries.

**Interfaces:** `StoreUpdateOpening.open(_:)` receives only a validated `https://apps.apple.com/...` target from current policy. The launcher exposes failure to UI; it never owns gate state or pretends to install the app.

- [ ] Write launcher tests for approved Apple host, credentials in URL, lookalike host, unsupported scheme, missing handler and open failure. Reject query/URL formats that cannot be associated with the configured app listing; don't guess the real App Store ID.
- [ ] Implement explicit user-tap handoff through `UIApplication.open`, preserving the gate while external UI is shown. Retry remains available when the store cannot open.
- [ ] On return, read installed build and check current policy when due; after an Update action allow an immediate check. Returning without installing remains required. A newer policy withdrawal can unlock after valid refresh.
- [ ] Document that iOS release management stores version/build/English notes/App Store URL; APK upload applies only to Android. There is no arbitrary S3 IPA updater in this scope.
- [ ] Run `StoreUpdateLauncherTests` on the designated simulator and unsigned build validation. Record real App Store update/install as unverified until the app has an available listing and appropriate real-store validation is separately authorized.

**Acceptance:** Store handoff cannot bypass the mandatory gate, and the iOS implementation never claims an installation merely because it opened a URL.
