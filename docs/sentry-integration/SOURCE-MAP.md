# Study source map

Paths below are repository-relative. These files were inspected directly or
through focused searches on 2026-09-24. Findings describe this dirty worktree.

## Repository evidence

| Area                  | Existing source                                                                                                                                                       | Consequence for implementation                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Backend bootstrap     | `backend/src/main.ts`, `backend/src/app.module.ts`, `backend/package.json`, `backend/Dockerfile`                                                                      | ESM, dynamic AppModule import, immediate startup exit, independent Docker start command               |
| Backend config        | `backend/src/config/environment.ts`, `backend/src/config/environment.module.ts`                                                                                       | Early Sentry bootstrap must respect local-only dotenv loading and validation                          |
| Backend HTTP          | `backend/src/http/configure-http.ts`, `backend/src/http/public-exception.filter.ts`                                                                                   | Preserve response mapping; CORS currently lacks trace headers                                         |
| Existing reports      | `backend/src/client-errors/client-errors.service.ts`, `backend/src/worker-fleet/telemetry/worker-diagnostic-sanitizer.ts`                                             | Preserve typed operational records; existing regex scrubbing is not a complete Sentry event sanitizer |
| Worker entry/runtime  | `worker/src/cli/main.ts`, `worker/src/runtime/worker-runtime.ts`, `worker/src/agent/machine-supervisor.ts`                                                            | Multiple commands, caught terminal failures, signals, simultaneous slots                              |
| Worker child/config   | `worker/src/agent/child-process.ts`, `worker/src/runtime/runtime-config.ts`, `worker/src/enrollment/runtime-config-builder.ts`                                        | Restricted child environment and strict runtime config; no credential forwarding                      |
| Worker engine         | `worker/engine/musicmute_engine/child.py`, `worker/engine/musicmute_engine/pipeline.py`                                                                               | Typed ProcessingFailure wrapping retains causes locally; reporting needs original Python boundary     |
| Worker packaging      | `worker/package.json`, `worker/src/platform/macos/release-builder.ts`, `worker/src/platform/windows/release-builder.ts`, `worker/src/platform/release-tree-filter.ts` | No production Node dependencies today; release assembly requires explicit dependency handling         |
| Worker dependencies   | `tools/worker-gpu-feasibility/requirements-mps-base.lock.txt`, `tools/worker-gpu-feasibility/requirements-directml.lock.txt`                                          | Isolated Python 3.13 MPS / Python 3.12 DirectML qualification must survive dependency additions       |
| Android entry/build   | `android/app/src/main/java/com/hatem/musicmute/VocalApplication.kt`, `android/app/build.gradle.kts`, `android/gradle/libs.versions.toml`                              | Kotlin/Compose, AGP 8.13.2, direct/play flavors and authE2e build type                                |
| Android reporting     | `android/app/src/main/java/com/hatem/musicmute/processing/ClientErrorOutbox.kt`, `android/app/src/main/java/com/hatem/musicmute/processing/MediaPreparationWorker.kt` | Owner-fenced durable reports, coroutine cancellation, background processing                           |
| iOS entry/build       | `ios/project.yml`, `ios/Vocal/VocalApp.swift`, `ios/Vocal/Processing/ProcessingAppDelegate.swift`                                                                     | SwiftUI graph, push/background callbacks, XcodeGen source of truth                                    |
| iOS reporting/privacy | `ios/Vocal/Processing/ClientErrorOutbox.swift`, `ios/Vocal/Resources/PrivacyInfo.xcprivacy`                                                                           | Typed outbox and explicit owner purge; current manifest declares no collected data types              |
| Dashboard entry       | `dashboard/src/main.tsx`, `dashboard/src/app/app.tsx`, `dashboard/package.json`                                                                                       | React 19/Router 8; separate render and async failure boundaries                                       |
| Dashboard requests    | `dashboard/src/app/query-client.ts`, `dashboard/src/api/api-client.ts`                                                                                                | Automatic query retries and operation-receipt recovery must not duplicate issues or mutations         |
| Dashboard deployment  | `dashboard/src/config.ts`, `dashboard/vite.config.ts`, `dashboard/vite-environment.ts`, `dashboard/server.mjs`, `dashboard/Dockerfile`                                | Runtime config precedence, public-variable allowlist, static serving, HTTPS CSP                       |
| Verification          | `worker/README.md`, `backend/README.md`, `android/README.md`, `ios/README.md`, `dashboard/README.md`                                                                  | Existing component-specific commands; no Flutter commands apply                                       |

No Sentry/Crashlytics/OpenTelemetry/Bugsnag integration was found in the searched
application source directories. This is source evidence, not an inventory of
external services or deployed binaries.

## Official documentation consulted

The documentation sites returned Markdown; where the web reader could not parse
it, the same official URLs were retrieved directly. SDK versions and options
must be pinned and rechecked during implementation. The examples below are
references, not authorization to run a wizard over the working tree.

- [Sentry NestJS setup](https://docs.sentry.io/platforms/javascript/guides/nestjs/): dedicated SDK, root setup, custom-filter integration, and default HttpException behavior. Keep the existing filter and explicitly classify actionable handled failures.
- [Sentry Node setup](https://docs.sentry.io/platforms/javascript/guides/node/): early runtime initialization. Verify the compiled ESM launch path before enabling instrumentation.
- [Sentry Python setup](https://docs.sentry.io/platforms/python/) and [Python options](https://docs.sentry.io/platforms/python/configuration/options/): child-process SDK setup, collection controls, and shutdown options. Disable locals and automatic broad logging.
- [Sentry Android setup](https://docs.sentry.io/platforms/android/) and [Gradle configuration](https://docs.sentry.io/platforms/android/configuration/gradle/): SDK/build plugin setup, variant controls, mapping/native symbol uploads, and optional source collection. Review automatic build-upload features individually.
- [Sentry iOS setup](https://docs.sentry.io/platforms/apple/guides/ios/) and [dSYM upload](https://docs.sentry.io/platforms/apple/guides/ios/dsym/): early startup and matching symbol files. SDK examples enable optional collection that this plan deliberately leaves disabled.
- [Sentry React setup](https://docs.sentry.io/platforms/javascript/guides/react/): render/error integration; the retrieved router guidance lists v7/v6 integrations, requiring a Router 8 compatibility check here.
- [JavaScript collection options](https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/): granular collection settings, hooks, and changing version defaults. Configure explicitly and test serialized envelopes.
- [Vite source maps](https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/uploading/vite/): upload plugin, build credentials, and source-map cleanup. Public production servers must not expose map files.
