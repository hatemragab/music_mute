# MusicMute App Updates Implementation Plan

> Dashboard execution is owned by the [full dashboard task package](../../tasks/full-dashboard/README.md). Its approved stack is React + TypeScript + Vite, Tailwind CSS + shadcn/ui, React Router, TanStack Query and Firebase Web Authentication. The full package supersedes the older dashboard source map, minimal UI scope, equal-access authorization and hosting steps below. Hosting is excluded; implementation remains paused until the user requests resumption and B18 passes.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a private release dashboard, S3-backed Android updates, whole-app forced updates on both mobile platforms, and a future Google Play update destination.

**Architecture:** Extend the existing NestJS policy and processing guard, preserving legacy clients. Build an independently authorized dashboard and independent native update coordinators. Use immutable release artifacts and transactional publication rather than mutable download links.

**Tech Stack:** Existing NestJS/TypeScript/MongoDB/Redis/AWS SDK/Firebase, Kotlin/Compose, Swift/SwiftUI; new React/Vite dashboard, azhon/AppUpdate direct flavor, official Google Play updater Play flavor.

**Spec:** [App updates design](../specs/2026-09-10-app-updates-design.md).

## Global Constraints

- Read the spec and the relevant subsystem plan before implementing a task.
- User requested a plan only. Do not start implementation in the planning turn.
- No commits, pushes, deployment, cloud mutation, release publication or data deletion without explicit user instruction.
- Preserve all pre-existing edits and untracked work. Do not create a clean checkout that silently omits the current untracked native/backend source.
- Execute inline with `superpowers:executing-plans` unless the user chooses delegated execution. Do not spawn agents merely to prepare this plan.
- Check at launch, reconnect, every **15 minutes** foreground/online and due foreground entry; no background polling. Later defers **24 hours**.
- Whole-app forced gate; offline opens without a known required policy; existing server jobs survive. Changelogs **English only**.
- S3 private; APK validation before publish and before install. Google admin allowlist is backend-enforced and expandable.
- Device/UI tests only on **iPhone 17 Pro, iOS 26.0**, UDID **$IOS_SIMULATOR_UDID**. Android device proof requires a separate explicit exception.

---

## File ownership and sequencing

| Plan                                             | Owned responsibility                                                    | First independent acceptance boundary                  |
| ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| [Backend](2026-09-10-app-updates-backend.md)     | Authentication, release/policy API, S3, verification, backend packaging | Rejected admin requests; policy contract fixture tests |
| [Dashboard](2026-09-10-app-updates-dashboard.md) | `dashboard/`; authenticated release management                          | Browser login/admission with a mocked API              |
| [Android](2026-09-10-app-updates-android.md)     | `updates/`, flavor config and native integration                        | JVM policy/timing tests and both flavor builds         |
| [iOS](2026-09-10-app-updates-ios.md)             | `Updates/` and SwiftUI integration                                      | Swift decision/timing tests                            |
| This plan                                        | Contract fixtures, final integration and evidence                       | Full consistency/verification handoff                  |

Shared backend files belong to the backend plan; dashboard packaging integration is completed in V01 after D03. Coordinate edits if execution is delegated later. Re-read current versions immediately before editing.

Execution order: B01/B02 and A01 first; then B03/B04, D01/D02, A02, I01; then B05/B06, D03, A03/A04/A05, I02/I03; finally V01–V03. These are dependency groups, not permission to delegate.

## Task UPD-V01: Cross-component verification and deployable package

**Files:** Create `docs/contracts/app-updates-v1.json`, `backend/test/app-updates.integration.mjs`, `docs/validation/app-updates-2026-09-10.md`. Modify `backend/Dockerfile`, `backend/scripts/package-caprover.mjs`, `backend/src/deployment/caprover-package.spec.ts`, `backend/src/http/configure-http.ts`, and dashboard/native contract tests from subsystem plans.

**Interfaces:** Consume `UpdatePolicySnapshot` and endpoint definitions from the spec. Produce a shared fixture array with `{name, installedBuild, snapshot, expectedDecision}`, consumed by backend, dashboard, Android and iOS tests. Fixtures contain no real account, signed URL or production bucket.

- [ ] Add fixtures for below-minimum, optional, current, newer-than-server, no release, policy withdrawal, source migration and invalid target. Use this exact representative vector:

```json
{
  "name": "below-minimum",
  "installedBuild": 9,
  "snapshot": {
    "schemaVersion": 1,
    "revision": 8,
    "platform": "android",
    "distribution": "direct",
    "minimumBuild": 10,
    "target": {
      "id": "release-12",
      "versionName": "1.2.0",
      "buildNumber": 12,
      "changelogEn": "Improved processing.",
      "source": "direct_apk",
      "storeUrl": null,
      "artifact": {
        "bytes": 1024,
        "sha256Hex": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "signerSha256Hex": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    },
    "checkedAt": "2026-09-10T12:00:00Z"
  },
  "expectedDecision": "required"
}
```

- [ ] Add integration scenarios using isolated MongoDB replica-set/Redis helpers: allowlisted admin publishes; revision changes once; device below minimum gets `APP_UPDATE_REQUIRED`; an existing result remains present; newer valid policy withdraws the block. Assert no publication calls cancellation APIs.
- [ ] Run the new integration test before wiring missing behavior and observe a meaningful failure; implement only the cross-component fixes it exposes. Keep S3 emulator/adapter results labelled simulated until real S3 validation is authorized.
- [ ] Build dashboard assets into the backend image and serve `/admin/` with deep-link fallback confined to that path. Never rewrite `/api/v1/*`, health, or missing asset requests to HTML. Add focused CSP rules for Firebase login without weakening API security headers globally.
- [ ] Extend the CapRover allowlist to include dashboard source/manifests/lockfile and verifier setup files. Exclude secrets, dotenvs, signing keys, local APKs, node_modules and local build output. Preserve root `captain-definition`, port 80 and `backend/...` archive shape.
- [ ] Run backend `npm run verify`, `npm run test:auth:integration`, `npm run test:processing:integration`, and `npm run build && node --test test/app-updates.integration.mjs` from `backend/` against isolated services only.
- [ ] Run dashboard `npm run verify` and `npm run test:e2e` from `dashboard/`; the dashboard task must define both scripts. Web browser tests do not replace mobile device tests.
- [ ] Run Android commands from its plan and the iOS simulator command from V02. Inspect the Play APK merged manifest to prove no APK-installer permission; inspect dependency artifacts to prove azhon is absent from Play.
- [ ] Run `npm run package:caprover` only as a local packaging check after ensuring its output cannot overwrite another writer's artifact. Inspect the archive using the existing package tests. Docker build, if locally available, is a separate local check; do not upload/deploy it.

**Acceptance:** All four clients share the same decision fixtures; backend enforcement and existing-job continuity pass; dashboard production files and verifier are present in the inspected package. Record skipped/unavailable tooling, not invented success.

## Task UPD-V02: Allowed UI validation and external-proof ledger

**Files:** Create `ios/VocalUITests/AppUpdateUITests.swift`; modify `ios/project.yml` only if test inclusion requires it. Update `docs/validation/app-updates-2026-09-10.md` and the task tracker.

**Interfaces:** Inject a deterministic policy server/clock only through Debug/test configuration. Production must not accept runtime URLs or clock overrides from user input. Tests consume fixtures from V01.

- [ ] Verify the exact simulator exists; do not create/download/substitute another runtime. Example check: `xcrun simctl list devices available` and inspect the specified UDID.
- [ ] Add UI checks for launch-required gate, disabled underlying navigation, optional Later suppression, offline allowed startup, required-cache relaunch, foreground/reconnect coalescing and an existing server job surviving the UI gate. Use accelerated injected clocks rather than waiting 15 minutes/24 hours.
- [ ] From `ios/`, run:

```sh
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath /tmp/musicmute-app-updates-ios \
  test CODE_SIGNING_ALLOWED=NO \
  -only-testing:VocalTests/UpdatePolicyTests \
  -only-testing:VocalTests/UpdateCoordinatorTests \
  -only-testing:VocalTests/UpdateGateTests \
  -only-testing:VocalTests/StoreUpdateLauncherTests \
  -only-testing:VocalUITests/AppUpdateUITests
```

- [ ] Record Android installation permission, installer cancellation, signed upgrade/data preservation, process-death recovery and real Google Play eligibility as **unverified** until the user authorizes an Android target. Never route them to a different simulator/device by convenience.
- [ ] Record real App Store installation, production Firebase Google sign-in and private-S3 transfer proof separately. Simulator mocks do not establish these outcomes.

**Acceptance:** Available iOS proof is attached; all remaining device/store/service gaps are explicit. A blocked external proof does not get marked passed because local tests passed.

## Task UPD-V03: Bootstrap and operational readiness handoff

**Files:** Create `docs/validation/app-updates-rollout.md`; update `docs/tasks/app-updates.md` with actual task evidence. No deployment files are mutated in this task.

**Interfaces:** Consume verified package and policy revisions; produce an ordered operator runbook with no real credentials or personal email in source.

- [ ] Document required runtime values: private administrator bootstrap email, approved signer digests, dashboard origin/Firebase web settings, S3 bucket/CORS/versioning and verifier tool paths. Record configured/unconfigured status without exposing values.
- [ ] Document two Android artifact outputs, current signing certificate and the future Play app-signing compatibility check. An upload certificate is not automatically the Play app-signing certificate.
- [ ] Sequence rollout: backend feature disabled -> authorized admin bootstrap -> publish-capable dashboard -> native bootstrap releases -> confirm users can obtain replacement -> activate optional policy -> explicitly publish a forced minimum only when available to every affected channel.
- [ ] Include recovery through a newer policy revision, retained last-good APK, refreshed download grants and an operator path to restore a valid target. Never require uninstall/data loss as an automatic recovery.
- [ ] State the app cannot learn a new policy while fully offline and older binaries without the gate cannot gain it remotely. Existing backend guards still restrict processing.
- [ ] Stop before production deployment, S3/CORS/IAM changes, administrator bootstrap or public release publication unless the user explicitly authorizes those actions. Present the concrete reviewed package/runbook when authorization is requested later.

**Acceptance:** The user can see exactly which local checks passed and which operational prerequisites remain. No production actions are implied by marking planning complete.
