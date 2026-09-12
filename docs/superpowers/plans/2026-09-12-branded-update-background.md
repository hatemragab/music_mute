# Branded required-update background

**Goal:** Replace the blank screen behind the required-update dialog with MusicMute branding.

**Approved design:** Existing waveform logo, theme-aware green background, and localized “A new version is ready” / “Update MusicMute to continue” copy. Keep the background mounted throughout required download, verification, permission, installation, and error recovery. Optional updates continue over normal content.

**Architecture:** Render a stateless Compose background in `UpdateGate` when `blocksContent` is true. AppUpdate already uses a translucent activity, so the host background remains visible without changing the library theme or installation behavior. Reuse existing resources and Material tokens; add no dependencies.

## Tasks

- [x] Create `codex/branded-update-background` in an isolated worktree and carry the existing AppUpdate integration into it without changing the original checkout.
- [x] Inspect the gate and native library theme to confirm the blank Surface is the cause.
- [x] Add `RequiredUpdateBackground.kt`, English/Arabic resources, and replace the empty Surface. Include light/dark and Arabic/font-scale previews.
- [x] Extend `UpdateGateTest` across installation states to guard required blocking and optional content access.
- [x] Run direct/play unit tests, lint, and debug builds; review the diff and native manifest packaging.
- [ ] Commit the required integration separately from the background fix, push the branch, and open a PR targeting main.

## Validation boundaries

Android device/UI tests are not run: the authorized device is an iOS simulator. Compose previews are supplied for visual review; Android compilation and unit tests do not prove device rendering. No release upload or production policy change is part of this PR task.

## Results

`./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest :app:lintDirectDebug :app:lintPlayDebug :app:assembleDirectDebug :app:assemblePlayDebug --console=plain` passed. Direct: 200 tests; Play: 180 tests; no failures. Lint: zero errors, 58 direct / 40 Play warnings. `git diff --check` passed. Focused independent source review found no actionable issues. No Android visual verification was performed.
