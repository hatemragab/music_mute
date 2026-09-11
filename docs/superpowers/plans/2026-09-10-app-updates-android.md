# MusicMute Android App Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver optional/whole-app mandatory Android updates from private S3 using azhon/AppUpdate, with a Google Play distribution variant.

**Architecture:** Add an application-scoped update coordinator independent of authentication and an update gate outside the existing auth gate. Isolate download/install behavior behind a provider interface. Keep direct APK code out of Play artifacts and preserve existing local media/server job state.

**Tech Stack:** Existing Kotlin 2.2.20, Compose, coroutines, DataStore, HTTP transport and JVM tests; selected azhon/AppUpdate; official Google Play update API for Play delivery.

**Spec:** [Design and contracts](../specs/2026-09-10-app-updates-design.md).

## Global Constraints

- Read `android/README.md`, Gradle configuration and current application/processing/playback source before edits.
- Use **azhon/AppUpdate** for the direct flavor; no silent substitution. Verify the selected dependency actually resolves/builds with this project before integration.
- Check at launch/reconnect, every **15 minutes** while foreground/online, and due foreground entry; no background policy timer. Later defers **24 hours**.
- English-only release notes; existing UI labels remain localized EN/AR. Required gate covers playback, imports, notification/deep-link routes and back navigation.
- No known required policy + offline preserves normal existing offline access. Known required policy persists independently of account login; request failures do not clear it.
- Never sign out, delete audio, cancel cloud jobs or reset server leases as an update action.
- No device/UI test on Android without an explicit user exception. Unit tests, lint, builds and artifact inspection remain allowed.
- No implementation during planning; no commits, signing-key changes, uploads, store publication or deployment without authorization.

---

## File structure and interfaces

Base path `android/app/src/main/java/com/hatem/musicmute/updates/`:

- `UpdateModels.kt`: exact public wire models with nullable artifact/store fields.
- `UpdatePolicy.kt`: pure integer-build evaluation.
- `UpdateStore.kt`: atomic persisted snapshot/check/deferral state.
- `UpdateApiClient.kt`: public policy/download-grant calls using existing transport primitives without Firebase bearer tokens.
- `UpdateCoordinator.kt`: one scheduler/state owner with injected clock, connectivity and lifecycle.
- `UpdateGate.kt`: Compose root gate and optional prompt.
- `UpdateInstaller.kt`: provider interface and provider-independent state.
- `ApkValidator.kt`: whole-file SHA-256, package/build and signer checks before install handoff.

Flavor-specific `DirectUpdateInstaller.kt` under `src/direct/java/com/hatem/musicmute/updates/`; `PlayUpdateInstaller.kt` under `src/play/java/com/hatem/musicmute/updates/`. Each flavor supplies the same `createUpdateInstaller` factory signature. Direct can open the validated Play listing for source migration; it cannot claim native Play delivery eligibility merely because a listing exists.

```kotlin
enum class UpdateDecision { NONE, OPTIONAL, REQUIRED }
enum class UpdateTrigger { LAUNCH, RECONNECT, FOREGROUND, INTERVAL, RETRY, PROCESSING_REJECTED }
fun decideUpdate(installedBuild: Int, snapshot: UpdatePolicySnapshot): UpdateDecision
interface UpdateInstaller {
    val state: StateFlow<UpdateInstallState>
    suspend fun start(target: ReleaseTarget)
    suspend fun onForeground()
}
// UpdateInstallState is a sealed interface: Idle, Downloading(percent), Verifying,
// PermissionNeeded, AwaitingInstaller, StoreOpened, Failed(code).
```

`UpdatePolicySnapshot` and `ReleaseTarget` serialize the exact field names in the design. `UpdateCoordinator` exposes `StateFlow<UpdateUiState>`, `suspend fun check(trigger: UpdateTrigger)`, `suspend fun deferOptional()`, and `fun setForeground(active: Boolean)`. Define `UpdateUiState` with `decision`, `snapshot`, `checking`, and typed `failure`; never derive gate authority from installer progress.

## Task UPD-A01: Dependency compatibility and distribution variants

**Files:** Modify `android/app/build.gradle.kts`, `android/gradle/libs.versions.toml`, flavor manifests, existing build scripts that name non-flavored tasks, and `android/README.md`. Create flavor provider factories and `UpdateInstaller.kt` with buildable no-operation test providers until A04/A05.

**Interfaces:** Generate `BuildConfig.UPDATE_DISTRIBUTION` as `direct` or `play`. Both retain `com.hatem.musicmute`, existing release signing and integer build numbering. Do not create a new production key or change application ID.

- [ ] Add a build-verification expectation that the Play merged manifest contains no `REQUEST_INSTALL_PACKAGES`, and its dependency graph contains no azhon APK installer.
- [ ] Resolve and pin `io.github.azhon:appupdate:4.3.6` (the selected project's documented coordinate) through Maven Central. Confirm package APIs against the resolved source; if unavailable/incompatible, report the exact blocker before choosing another library/version.
- [ ] Add distribution flavor dimension `direct`/`play`; scope azhon to `directImplementation` and official `com.google.android.play:app-update:2.1.0` to `playImplementation`, verifying the official version at execution time. Put APK install permission/provider only in direct sources.
- [ ] Ensure generated build variants include existing `authE2e` behavior; update only relevant build/test scripts and documentation to use explicit variant tasks. Do not remove or alter auth fixture semantics.

```kotlin
flavorDimensions += "distribution"
productFlavors {
    create("direct") { dimension = "distribution" }
    create("play") { dimension = "distribution" }
}
```

- [ ] From `android/`, run `./gradlew :app:assembleDirectDebug :app:assemblePlayDebug :app:lintDirectDebug :app:lintPlayDebug`. Inspect both merged manifests and resolved dependencies, and document final pinned versions/licenses. Compilation does not prove Android installation behavior.

**Acceptance:** Both variants build, preserve identity/signing configuration, and the Play artifact contains no APK self-installer capability.

## Task UPD-A02: Policy state, offline persistence and scheduling

**Files:** Create models/policy/store/API/coordinator files and JVM tests under `android/app/src/test/java/com/hatem/musicmute/updates/`. Modify `VocalApplication.kt` to construct dependencies, not to embed decision logic.

**Interfaces:** Consume the public backend snapshot and grant APIs. `UpdateStore` persists one installation-wide atomic record; `UpdateCoordinator` owns exactly one foreground job and one in-flight check.

- [ ] Write failing pure evaluator tests for all shared fixtures and malformed snapshot rejection. Unknown fields can be ignored for forward compatibility; unsupported `schemaVersion`, invalid builds and unsafe destinations cannot replace a valid cache.
- [ ] Write fake-clock tests at 899999/900000 ms and 86399999/86400000 ms, launch/reconnect triggers, background cancellation, coalesced events, Retry-After, clock rollback and limited failure retry. Verify a new optional release does not bypass the 24-hour Later interval, but required always does.

```kotlin
assertEquals(UpdateDecision.REQUIRED, decideUpdate(9, snapshot))
assertEquals(UpdateDecision.OPTIONAL, decideUpdate(10, snapshot))
assertEquals(UpdateDecision.NONE, decideUpdate(12, snapshot))
```

- [ ] Implement integer build evaluation, atomic DataStore persistence and public transport. Store no signed URL or account identity in policy state. Preserve installed-version awareness after upgrades and ignore delayed lower policy revisions.
- [ ] Implement the foreground schedule using an injected clock/connectivity source. Check immediately on launch and reconnect; foreground entry checks only if due. Use 30-second/2-minute/baseline retry backoff for network failures without leaving a timer active in background.
- [ ] Add connectivity transitions with debouncing and one in-flight mutex. Set the last-attempt time when a request starts and last-success time only after valid data; keep failure retry state separate so a failed call neither creates a storm nor suppresses checks indefinitely.
- [ ] Persist a required snapshot before publishing required UI. On first offline start return allowed under existing auth rules; on cached required start remain required. A newer valid withdrawal revision clears the block; network failure cannot.
- [ ] Run `./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest` and focused coordinator/store tests. Include a process-recreation test with restored storage, not only in-memory state.

**Acceptance:** Timing/offline behavior is proven by deterministic tests and is independent of Firebase session status.

## Task UPD-A03: Whole-app gate, playback and local transfer pause

**Files:** Create `updates/UpdateGate.kt`, `updates/UpdateAdmission.kt`, their tests; modify `MainActivity.kt`, `VocalApplication.kt`, `ui/auth/AuthGate.kt`, `playback/{AudioPlaybackController,AudioPlaybackService}.kt`, `processing/{AudioPipelineCoordinator,ProcessingRepository,AudioUploadWorker,JobArtifactRepository,JobsApiClient}.kt`, relevant notification/import entry points and EN/AR string resources.

**Interfaces:** `UpdateAdmission.isBlocked(): Boolean` and `suspend fun requireAllowed()` expose one gate to UI and services. `ProcessingRepository.pauseForUpdate()` stops only local operations using existing `stopLocalTransfer`; it never calls cloud cancellation/deletion APIs. Keep this separate from auth/session teardown.

- [ ] Add tests that required policy blocks tab navigation/back, playback service commands, import/share intents and notification/deep-link entry. Optional prompt does not block normal app functions after Later.
- [ ] Add repository tests with fake cloud API: activating gate stops local transfers and preserves original input/job IDs; cloud cancel/delete calls remain zero; submitted job updates stay recoverable after installed build advances.
- [ ] Put the gate outside authentication in the root composition. Display version, English changelog, Update, Retry and typed errors. Do not use a dismissible library dialog as the sole enforcement mechanism.
- [ ] Stop current playback and guard remote-media commands against restart. Pause unsubmitted local uploads/source work without deleting inputs or using cancellation flags that would later cancel server jobs. Handle in-flight callbacks with existing ownership/epoch fences plus current update admission checks.
- [ ] Route `APP_UPDATE_REQUIRED` from processing transport into a provisional required state and trigger `PROCESSING_REJECTED` refresh; do not convert unrelated 403 errors into update requirements. Prevent retries of rejected submissions while blocked.
- [ ] Preserve queued navigation intents while blocked or discard them safely; never execute them behind the gate. After update, reconcile current auth/ownership and pending work before resuming UI.

```kotlin
gate.requireUpdate(snapshot)
repository.pauseForUpdate()
assertEquals(0, fakeCloud.cancelCalls)
assertEquals(0, fakeCloud.deleteCalls)
assertTrue(store.operation(operationId)!!.input != null)
```

Define the `gate`, `repository`, `fakeCloud`, `store` fixture in `UpdateGateTest.kt` using the production admission adapter; `requireUpdate` is a test fixture action that publishes a required coordinator snapshot, not a second production gate.

- [ ] Run JVM gate/repository/playback tests and both flavor lint/builds. Device/Compose instrumentation remains pending explicit Android authorization.

**Acceptance:** No normal app entry point escapes a known required gate; existing cloud work and local data survive.

## Task UPD-A04: Verified direct APK download and Android installation

**Files:** Create `src/direct/.../DirectUpdateInstaller.kt`, direct manifest/resources and tests; create main `updates/ApkValidator.kt` only if it introduces no installer dependency into Play, otherwise place it in direct. Reuse `UpdateApiClient` and provider-independent UI state.

**Interfaces:** `DirectUpdateInstaller` implements `UpdateInstaller`. It obtains a new `ReleaseDownloadGrant` by release ID, integrates azhon with auto-install disabled (`jumpInstallPage(false)` if confirmed in resolved API), and explicitly hands off installation only after verification.

- [ ] Test URL expiry/grant renewal, network interruption, storage shortage, checksum mismatch, wrong package/build/signer, cancellation and installer rejection through fake downloader/installer interfaces. The adapter must expose a pre-install verification boundary; verify this against the resolved azhon implementation in A01.
- [ ] Use HTTPS and the backend-selected release grant; do not forward Firebase credentials. Keep downloads in app-private/cache storage with unique release/build/hash filenames. Never interpret arbitrary intent extras as a download URL.
- [ ] Integrate azhon progress/completion callbacks into `UpdateInstallState`. If its default downloader cannot meet identity/resume requirements, use the documented custom downloader interface while retaining the selected library integration. Do not claim resume support without a tested byte-range implementation; restarting safely is acceptable.
- [ ] Recompute whole-file SHA-256; inspect package `com.hatem.musicmute`, newer expected build and compatible signer digest. Android's installer still performs its signature validation. Do not treat the library's MD5/cache check as artifact authorization.
- [ ] Request Android unknown-app-source permission when needed, then use a FileProvider URI with read grant for installer handoff. Handle return from Settings, denied permission, cancelled installer and unsupported handler without unlocking a required gate.
- [ ] On foreground return, re-read installed build and refresh policy; never infer successful installation from a clicked button or merely launching an intent. Refresh expired grants by release ID and reject withdrawn releases on retry.

```kotlin
installer.start(targetWithWrongChecksum)
assertEquals(0, fakeAndroidInstaller.launches)
assertEquals(UpdateInstallState.Failed("APK_CHECKSUM_MISMATCH"), installer.state.value)
```

- [ ] Run direct-flavor unit tests, lint and build. Record actual install/unknown-source permission/process-death behavior as unverified until an Android device is authorized. Do not install onto any currently connected device by default.

**Acceptance:** No APK installer intent launches before validation; cancelled/failed updates retain the gate; files and existing media are not deleted.

## Task UPD-A05: Play provider and source migration

**Files:** Create `src/play/.../PlayUpdateInstaller.kt` and tests; modify direct provider only for validated Play listing handoff. Update `android/README.md` with flavor build paths and signing/channel behavior.

**Interfaces:** Play provider consumes only `google_play` targets. Use official update availability/type checks; optional uses flexible flow when available, required uses immediate when available. A store-listing fallback is not an APK download fallback.

- [ ] Add fake Play-manager tests for update unavailable, flexible/immediate allowed, user cancellation, developer-triggered update in progress, download complete/restart, missing Play and incompatible server target.
- [ ] Implement provider resumption on foreground; preserve the application gate if user cancels or target is unavailable. Show Retry/store action rather than clearing a known required policy.
- [ ] Direct builds whose policy switches to Google Play open the verified package listing. Preserve data and require compatible signing/higher build before claiming migration success. Never force uninstall or reset local data.
- [ ] Confirm Play source code/dependency graph cannot instantiate a direct provider and its manifest has no installer permission. A remote policy changing source to direct must be rejected or resolved to the configured Play target, never activate a hidden self-installer.

```kotlin
assertEquals("google_play", resolveSource(distribution = "play", selectedSource = "direct_apk"))
```

Implement the pure source resolver in `UpdatePolicy.kt` with these exact inputs/outputs and test direct->Play plus invalid iOS combinations as well; it mirrors server channel selection and is a defensive check, not independent policy authority.

- [ ] Run `./gradlew :app:testPlayDebugUnitTest :app:lintPlayDebug :app:assemblePlayDebug` plus direct regression tests. Record real Play ownership/track/rollout/signing tests as unverified without an authorized Android target and published test artifact.

**Acceptance:** The future Play artifact uses Play delivery only, and the direct artifact has a documented, data-preserving migration path contingent on signer/store compatibility.
