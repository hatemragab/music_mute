# AppUpdate integration plan

**Goal:** Use azhon/AppUpdate 4.3.6 for the direct Android update prompt and download orchestration, retaining MusicMute's verified installation path.

**Architecture:** The direct flavor opens AppUpdate's built-in prompt using the backend target and required/optional decision. A custom BaseHttpDownloadManager delegates to the existing bounded HTTPS transport and verifies the APK before AppUpdate receives a completion event. MusicMute retains permission handling and installer handoff. The Compose gate remains responsible for blocking content, errors, permission recovery, and Play updates.

**Scope:** Work in the current repository. Preserve the existing build.gradle.kts edit. No new dependencies, backend/dashboard changes, release publication, commits, or device installation. Android UI testing is blocked by the user's iPhone-only device restriction; run JVM tests, lint, and both flavor builds.

## Tasks

- [x] Add regression tests for the AppUpdate HTTP adapter: progress, verified completion, rejection, cancellation and no early success.
- [x] Implement the secure adapter using `BaseHttpDownloadManager`, `DownloadStatus`, the existing `UpdateDownloadClient`, and `ApkVerifier`. Never enable the library default transport or expose an unverified APK through its notification.
- [x] Add an Activity-bound AppUpdate download client with required/optional dialog configuration, listener cleanup, cancellation, and no automatic library installation. Fetch grants on each attempt; pass the target metadata into the client before starting.
- [x] Connect the direct-flavor prompt through UpdateGate; keep the Play implementation unchanged. On dismiss defer optional updates only. On failure return to the existing actionable retry UI.
- [x] Restore the library Activity/service manifest entries and scope them to the direct build. Document the ownership of dialog, transport, validation and install.
- [x] Override the library's fallback strings in English and Arabic for the direct flavor.
- [x] Run targeted regression tests, all direct/Play JVM tests, lint, direct/Play debug assembly, and `git diff --check`. Inspect merged manifests and review the final diff.

## Acceptance

- AppUpdate shows target version, changelog, and forced-update progress.
- Builds below the backend minimum stay blocked throughout dismissal, failure, and cancellation.
- Downloads reject redirects, oversized bodies, invalid checksums, wrong package/build/signers before any completion notification or installation.
- Failed and cancelled attempts can retry without a stale singleton, Activity reference, or signed URL.
- Play builds contain no direct APK update service or permission.

## Validation result

The direct suite passed 199 tests and the Play suite passed 179 tests. Both debug
APKs assemble; both lint tasks complete without errors. The merged direct
manifest includes only non-exported AppUpdate components; Play has no AppUpdate
components or REQUEST_INSTALL_PACKAGES permission. Independent review findings
about prompt-return ordering, pending-grant cancellation and retained-APK
verification cancellation were fixed and covered by regression tests.

Device/UI installation remains unverified under the iPhone-only device restriction.
