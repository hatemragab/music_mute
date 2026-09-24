# Sentry implementation and release gates

Updated 2026-09-24 after integrating the `hatem/add-sentry` worktree into
`mac-os-cli-ultra-speed-worker`. This records source integration and Sentry
account setup, not a production deployment.

## Account setup

Organization: `vchat-9f`. Dedicated team: `#musicmute`. Six projects exist:
`musicmute-backend`, `musicmute-worker-cli`, `musicmute-worker-engine`,
`musicmute-android`, `musicmute-ios`, and `musicmute-dashboard`.
Each project has its own public DSN. Project-level server-side data scrubbing and
default scrubbers were on, and **Prevent Storing of IP Addresses** was enabled
and visually verified for all six. No organization-wide privacy settings were
changed. Sentry may still derive coarse geography from an ingestion request;
review that against the final privacy notice before release.

## Current integration

| Surface | Implementation | Runtime enable and disable |
| --- | --- | --- |
| Backend | `@sentry/nestjs` 11.0.0; 500 response and startup boundaries, generic messages, code frames, ten events per process minute | Production enabled by default; `SENTRY_ENABLED=false` disables; optional `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` |
| Worker CLI | `@sentry/node` 11.0.0; terminal `run` failure, bounded flush, locked offline production dependency in Mac/Windows release tree | Installed release enabled by default; `MUSICMUTE_SENTRY_ENABLED=false` disables; local runs require explicit `true` |
| Worker engine | `sentry-sdk` 2.70.0; unexpected child failure, no user media/locals; private Python runtime requirement in release builder | Inherits enablement, engine DSN, and release from packaged Node worker; local child disabled by default |
| Android | `sentry-android` 8.58.0; manual Application startup, no auto-init, scrubbed events | Release enabled by default; `-PsentryEnabled=false` disables at build time; debug/authE2e disabled |
| iOS | Sentry Cocoa 9.29.1 via XcodeGen/SPM; early SwiftUI app initialization and crash-data privacy manifest | Release build setting `MUSICMUTE_SENTRY_ENABLED=YES`; Debug `NO`; override to `NO` before building to disable |
| Dashboard | `@sentry/react` and `@sentry/node` 11.0.0; browser render/global errors and server fatal errors, runtime browser config | Production server enabled by default; `SENTRY_ENABLED=false` disables both; local Vite default off |

All SDKs omit user identity, requests, bodies, headers, query strings, extras,
breadcrumbs, and user-provided error messages at the capture boundary where
supported. Replay, tracing, profiling, screenshots, view hierarchies, and
automatic session tracking were left off. Existing worker and mobile diagnostic
outboxes remain separate; expected input/cancellation errors are not sent.
Errors are best effort and do not alter processing or API responses.

## Release artifacts

- Backend Docker build accepts `--build-arg SENTRY_RELEASE=musicmute-backend@<revision>`
  and BuildKit secret `--secret id=sentry_auth_token,src=<secure-token-file>`.
  With both, it injects Debug IDs and uploads source maps before copying the
  final build. It fails if an upload fails. Without a token, the application
  builds but Sentry will not have those source maps.
- Dashboard Docker build accepts the same secret and a component-specific
  `SENTRY_RELEASE=musicmute-dashboard@<revision>`. The Vite plugin uploads
  hidden source maps and deletes them from the served `dist` after a successful
  upload. The server process and browser share this release.
- Worker release builders install `@sentry/node` from their locked production
  dependency graph offline with a link-free hoisted runtime tree, and require
  `sentry-sdk` in the private Python root.
  The MPS/DirectML lock inputs pin it. With `SENTRY_AUTH_TOKEN` in the release
  builder environment, the builders inject/upload CLI source maps before
  creating the immutable manifest. Node and Python have distinct release names.
- iOS archived dSYMs can be uploaded with
  `SENTRY_AUTH_TOKEN=... SENTRY_CLI=sentry-cli ios/scripts/upload-sentry-dsyms.sh <MusicMute.xcarchive>`.
  The script uploads only dSYMs and excludes source bundles. Android currently
  does not minify release bytecode, so a ProGuard mapping upload is not needed.

No upload token was created or stored, and no source maps or dSYMs have been
uploaded. The current CapRover build path does not supply BuildKit secrets or
component release arguments; connect an approved release runner before
production rollout. Do not put a token in Docker build args, Gradle properties,
Xcode settings, runtime config, or tracked files.

## Validation so far

- Backend verification passed, including lint, typecheck, secret scan, build,
  all 808 unit tests, and 140 end-to-end tests. A synthetic `integration-test` error was
  flushed and verified at [MUSICMUTE-BACKEND-1](https://vchat-9f.sentry.io/issues/7753178183/).
- Worker lint/build/typecheck and 276 unit tests passed, with two skipped.
  A synthetic error was verified at
  [MUSICMUTE-WORKER-CLI-1](https://vchat-9f.sentry.io/issues/7753178473/).
  A temporary offline install resolved the locked production Node dependency,
  imported `@sentry/node`, and left no links in the 7,053-entry runtime tree.
- Both Python sanitizer tests passed, and the pinned SDK initialized in a
  temporary Python 3.13 environment. A synthetic event was verified at
  [MUSICMUTE-WORKER-ENGINE-1](https://vchat-9f.sentry.io/issues/7753200644/).
  The first synthetic event had no traceback and Sentry flagged its empty
  stack frame list; the sanitizer now omits an empty stacktrace. The full engine suite was blocked by
  missing `audio_separator` in the available local virtual environment;
  it had one dependency import error after 64 other tests ran.
- Android direct and Play release Kotlin compilation, direct JVM unit tests,
  and direct lint passed. An existing local Firebase config was linked only
  during verification and the link was removed afterward. Android device/UI
  testing remains outside the permitted device target.
- XcodeGen resolved Sentry Cocoa, strict Swift formatting passed, and the
  `VocalTests` suite passed on the specified iPhone 17 Pro / iOS 26.0 simulator:
  167 passed, 1 skipped. A first test attempt failed because XcodeGen ran
  before the ignored local Firebase plist was linked; rerunning generation
  with that local input fixed the runner.
- Dashboard lint/typecheck/production build, all 68 browser unit tests, and
  11 deployment tests passed. A synthetic server error was verified at
  [MUSICMUTE-DASHBOARD-1](https://vchat-9f.sentry.io/issues/7753199195/).
  The browser stack sanitizer now limits paths to built JavaScript assets.

## Remaining release gates

1. Validate live error receipt for dashboard browser, Android, and iOS
   using safe synthetic failures; Android device runtime validation needs an
   explicit exception to the current iPhone-only device rule.
2. Supply a narrowly scoped Sentry upload token through an approved secret
   store, run exact-build source-map and dSYM uploads, and verify readable
   source frames/debug identifiers in Sentry.
3. Build an actual Mac and Windows worker release with the private Python roots,
   run the installed worker, and verify release manifest and reporter startup.
4. Review crash diagnostics and derived geography in the Android/iOS privacy
   disclosures, then set alert ownership, retention, and budget before rollout.
5. Deploy to a canary only after a separate deployment request; check issue
   routing, rollback, and production health there. SEN-10 tracing stays later.
