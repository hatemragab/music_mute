# Android Play-only updates: implementation and validation

Date: 2026-10-08. Source implementation, validation and the approved API/dashboard
deployment are complete. Final Android policy-supersession and downloaded-update
recovery fixes are validated. API image 128 was deployed before dashboard image
35 to preserve legacy Android/iOS policy compatibility.

## Behavior

- Android binaries are uploaded only in Play Console. The dashboard records the
  Google Play version, build and English changelog without receiving a binary.
- Required Play updates accept an offered build at or above the minimum supported
  build. Optional updates require the selected target build. With installed build
  10, minimum 12, target 15 and offered build 14, the required immediate update is
  allowed; only an actual installed build of 14 clears the gate to optional.
- Play installs updates through its immediate or flexible flow. Flexible downloads
  retain a restart action across deferral and foreground recovery. Activity result
  launchers and install listeners are bound to the Activity lifetime. Pending Play
  responses use the latest policy, and transient failures retain downloaded
  restart readiness only while the build still meets that policy. Consent is not
  installation proof.
- The Android direct flavor, installer dependency, install-package permission,
  download-grant client and APK-only states are removed. The Play flavor and
  `UPDATE_DISTRIBUTION = "play"` remain.
- Historical direct APK records remain readable and read-only. New draft and
  policy writes reject direct distribution. The APK upload/completion routes
  return `400 INVALID_REQUEST`; APK grant, redirect and landing routes return
  `404 RESOURCE_NOT_FOUND` without storage URLs or a redirect header.
- Historical Android policy is preserved during unchanged iOS-only release
  operations when there is no Play target. Android publication still requires a
  real Play target meeting the minimum. Existing macOS policy fields survive
  mobile policy publication. Mac binary uploads retain their existing hash worker
  in a Mac-specific source file.
- Processed audio grants and private historical APK objects are retained. No
  release was published, minimum changed, existing job cancelled, data migrated
  or storage object deleted by this implementation.

## Local checks

| Component               | Checks and outcome                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                 | Full `pnpm run verify` passed, including format, lint, TypeScript checks, tracked-secret scan, transfer benchmark tests, 1,672 unit tests, 223 HTTP tests and the production build.                                                                  |
| Backend integration     | Isolated release/publication/admission tests: 3 passed. Compiled dashboard workflow and plain production-profile startup: 1 passed. Owned local MongoDB/Redis and synthetic storage/auth were used.                                                  |
| Dashboard               | Format, ESLint, TypeScript checks, production build and 187 unit tests passed.                                                                                                                                                                       |
| Dashboard browser       | 8 focused installed-Chrome cases passed, covering Play draft creation, platform switching, historical direct records, publication without an artifact, withdrawal and compiled retired-route contracts. Synthetic auth and local services were used. |
| Dashboard deployment    | Fresh production build and 19 packaging/runtime/Docker script tests passed.                                                                                                                                                                          |
| Android                 | 393 Play Release JVM tests in 63 suites passed with no failures, errors or skips. Release lint has no errors/fatals and 186 warnings. Fresh Play bundle, AuthE2e Kotlin and instrumentation Kotlin compilation passed.                               |
| Android release checker | 35 Python tests and local bundle inspection passed. Version 1.0.0/build 20, target SDK 36, 8 native libraries aligned to 16 KiB. No live checker or device test ran.                                                                                 |
| Review                  | Diff whitespace checks passed. Independent review found the matching API is required before dashboard deployment for legacy Android/iOS policy compatibility.                                                                                        |

The initial broader backend verification found stale APK installer/package tests;
they were removed or corrected. A later HTTP run had one `socket hang up` in the
unchanged authentication test. Its focused 10-test rerun and complete 222-test
HTTP rerun passed, followed by a successful complete `pnpm run verify` run on
the final source.

Additional final checks passed: OpenAPI unique-key parsing and all 1,543 internal
references, 82 release/controller HTTP cases, and an isolated historical edit/
withdraw receipt replay test. Real Mongo command monitoring observed zero new
writes during either successful replay. Changed replay bodies return 409.
Mutation response read models retain the historical source for these read-only
replays; new draft/proposal/publication inputs remain Play/App Store only.

## Build and deployment artifacts

Archives were checked against current source byte-for-byte. Both exclude dotenv,
dependencies, generated output and tests. Retired APK ingest/egress runtime files
are absent from the API archive, and APK upload code is absent from the dashboard
archive.

| Artifact               |             Size | SHA-256                                                            |
| ---------------------- | ---------------: | ------------------------------------------------------------------ |
| `app-play-release.aab` | 11,677,634 bytes | `e1e0823ea2738e051c2889c658c9758c81b01c323aac7d1b8314a084def9586f` |
| `api.tar`              |  2,548,224 bytes | `233829e7ef244e7fbc61e58fb00fcc9f6969cdb4645c97a0b409f70bf8d469cb` |
| `freshdashboard.tar`   |  1,368,576 bytes | `421f9b0d210d8daf6273fa368816316d8b6cd52b986806996b03adf145da12ee` |

The AAB is at `android/app/build/outputs/bundle/playRelease/app-play-release.aab`.
The existing version/build settings were preserved; this artifact has not been
submitted to Play Console.

## Current-source refresh

Shared settings/authentication work changed the repository after the original
package seal. It was preserved and the current components were revalidated.
The latest API package has 369 current-source inputs and the dashboard package
has 146; both were byte-compared against source. Six relevant isolated backend
integrations passed. Two initially observed missing compiled modules while
another build replaced `dist`; both passed when that build finished. Android
source fingerprints were unchanged throughout its fresh 393-test/lint/bundle run.

## Deployment and live verification

After explicit approval, CapRover CLI deployed the sealed API archive, followed
by the sealed dashboard archive. Both builds and deployments completed
successfully. CapRover read-back reports API `img-captain-api:128` and dashboard
`img-captain-dashboard:35`, with neither building. Full application configuration
and environment digests match their snapshots from before deployment.

| Live check                                                                 | Result                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| API `/health/live` and `/health/ready`                                     | HTTP 200                                                                                                          |
| Android policy with `distribution=direct`                                  | HTTP 400, `INVALID_REQUEST`                                                                                       |
| Retired APK landing, grant and redirect routes with a synthetic release ID | HTTP 404, `RESOURCE_NOT_FOUND`; no HTML, URL or redirect header                                                   |
| Unauthenticated admin policy read                                          | HTTP 401, `UNAUTHENTICATED`                                                                                       |
| Dashboard `/healthz`, `/releases` and `/update-policy`                     | HTTP 200, CSP and HSTS headers present                                                                            |
| Dashboard runtime configuration                                            | HTTP 200, `no-store`, correct HTTPS API origin                                                                    |
| Deployed release draft, history and policy JavaScript                      | Play-only draft helper and fixed listing; retired historical labels; no APK upload path or direct policy controls |
| Deployed macOS hash worker                                                 | HTTP 200 and SHA-256 identical to the local build                                                                 |
| Rendered production `/releases`                                            | Google administrator sign-in boundary displayed                                                                   |

Production browser verification covered loading and the authentication boundary;
authenticated release mutations were tested against the compiled local backend
with synthetic auth. No production release or policy mutation was performed.

The existing Play policy still returns HTTP 503 `DEPENDENCY_UNAVAILABLE` because
the minimum lacks a usable Play target. That operator-owned state was preserved.
An operator must select a real available Play release through the audited release
workflow after the binary is available to the intended audience on Play.

Google Play account ownership, signing compatibility, track availability and an
actual installed update/restart remain separate release acceptance checks. The
local tests and bundle do not establish these facts. See the
[Play release guide](google-play-release.md).

API preflight used the [official Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-08, including rules 101 (OpenAPI), 104 (security), 118 (snake_case),
151 (documented response statuses), 176 (Problem JSON) and 187 (deprecation).
Retiring direct distribution is the expressly requested compatibility break.
