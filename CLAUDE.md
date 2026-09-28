# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

MusicMute: AI vocal-isolation service. Mono-repo of independent components; there is **no root package install** — every component owns its dependencies and commands, and all commands run from the component directory.

| Dir                           | What it is                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `backend/`                    | NestJS 11 API, raw WebSockets, Mongo worker scheduling and BullMQ URL imports (Node 24, pnpm 10, ESM). |
| `worker/`                     | Machine supervisor (Node) + isolated Python processing child.                                          |
| `android/`                    | Kotlin/Jetpack Compose app (`com.hatem.musicmute`).                                                    |
| `ios/`                        | Swift/SwiftUI app; `project.yml` (XcodeGen) is source of truth.                                        |
| `dashboard/`                  | React 19 + Vite admin console (npm, not pnpm).                                                         |
| `web-client/`                 | React 19 + Vite end-user browser app (npm, not pnpm).                                                  |
| `video_providers/videoscale/` | Private SaaS audio adapter, contract, tests and deployment docs (Python).                              |
| `docs/`                       | Contracts, security reviews, task packages, validation records.                                        |

## Commands

### backend/ (pnpm; Node >=24 <25)

```sh
pnpm install --frozen-lockfile
pnpm run start:dev            # needs external MongoDB 8 + Redis 7.4 via .env.local; API never starts them
pnpm run verify               # format:check + oxlint + tsc + secrets scan + vitest unit + e2e + build
pnpm test                     # all unit tests (vitest)
pnpm vitest run src/auth/foo.spec.ts                      # single unit test
pnpm vitest run --config ./vitest.config.e2e.ts test/foo.e2e-spec.ts   # single e2e test
```

Opt-in integration suites spawn real `mongod`/`redis-server` (must be on PATH) with isolated ports; they never touch Atlas/S3/production: `pnpm run test:integration`, `test:auth:integration`, `test:processing:integration`, `test:worker:integration` (also builds `../worker`), `test:imports:integration`, `test:deletion:integration`, `test:dashboard:integration`. Local auth/device/deletion writes need a MongoDB **replica set** (transactions).

### worker/ (pnpm + uv)

```sh
pnpm install --frozen-lockfile
uv venv .venv --python 3.13
uv pip sync --python .venv/bin/python ../tools/worker-gpu-feasibility/requirements-mps-base.lock.txt
pnpm run verify               # protocol:check + format + lint + typecheck + vitest + engine tests + build
pnpm vitest run tests/foo.test.ts    # single test
pnpm run protocol:sync        # regenerate protocol/v1/ from backend after an intentional protocol change
```

CLI binary is `mw` (`dist/src/cli/main.js`); runtime entry is `mw run --config /abs/runtime.json`.

### dashboard/ (npm)

```sh
npm ci
npm run dev                   # needs .env.local with VITE_API_ORIGIN + VITE_FIREBASE_*
npm run format:check && npm run lint && npm run typecheck
npm test                      # vitest; single: npx vitest run src/path/file.test.tsx
npm run test:e2e              # Playwright + Chrome; needs local mongod/redis-server
npm run build
```

### web-client/ (npm)

```sh
npm ci --ignore-scripts
npm run dev                   # public VITE_API_ORIGIN + VITE_FIREBASE_* in ignored .env.local
npm run format:check && npm run lint && npm run typecheck
npm test && npm run build && npm run test:server && npm run test:e2e
npm run package:caprover      # allowlisted source archive for app.music-mute.com
```

`web-client/tasks/` records Android-to-web parity, browser adaptations, deployment
evidence and remaining real-identity testing. The installed-Chrome browser tests
use synthetic/mock fixtures. The separate `dashboard/` remains administrator-only.

### android/ (JDK 17, SDK 36)

```sh
./gradlew :app:assembleDirectDebug :app:assemblePlayDebug \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest
./gradlew :app:testDirectDebugUnitTest --tests "com.hatem.musicmute.SomeTest"   # single test
```

Flavors: `direct` and `play`; plus an `authE2e` variant with a checked-in synthetic Firebase fixture. Local API override: `-PauthApiUrl=http://127.0.0.1:3000` + `adb reverse`.

### ios/ (macOS, Xcode 26+)

```sh
xcodegen generate --spec project.yml    # only after project.yml changes
export IOS_SIMULATOR_UDID="<authorized iPhone 17 Pro / iOS 26 simulator>"
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_UDID" \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
```

Only that one simulator is authorized for runtime/UI checks; do not substitute devices or clones.

## Architecture

Request path: **native apps / end-user web / dashboard → TLS proxy → NestJS API → MongoDB, Redis, S3, Firebase Auth**. Workers claim jobs from the API over authenticated HTTPS; a WebSocket hint channel only _wakes_ reconciliation and never carries job authority. Local uploads and result downloads use signed S3 grants. URL-import audio travels from SaaS through a private adapter to NestJS validation and S3; it never travels through the worker control pipe.

- `backend/src/`: feature modules — `auth`/`users`/`devices` (identity), `admin*` (dashboard APIs), `jobs`/`processing`/`processing-usage` (durable jobs and policy-controlled processing), `url-imports` (server-side link acquisition), `worker-fleet`/`worker-hints` (machine enrollment, claiming, leases), `storage` (presigned grants), `rate-limits` (shared Redis counters), `infrastructure` (Mongo/S3), `http` (global policies).
- `web-client/`: standalone end-user app. Public Firebase Web SDK and API settings are read at runtime; signed media bytes transfer directly between the browser and S3. The root entry page is public, while authenticated routes carry noindex headers.
- `worker/src/`: Node supervisor (`runtime`, `agent`, `enrollment`, `platform`, `cli`). The Python child (`worker/engine/`) does inference only — it never receives backend or S3 credentials. macOS LaunchAgent / Windows Service; Linux and CUDA disabled.
- Wire contract: **root-mounted routes, snake_case JSON/query names, no version prefix**. `docs/api/client-contract.md` + `backend/openapi.yaml` are canonical; mobile clients adapt idiomatic local names at the HTTP layer.
- `worker/protocol/v1/` is _generated_ from the backend's canonical protocol. Edit the backend source, then `pnpm protocol:sync` in worker; `protocol:check` fails on drift.
- Processing availability follows current backend configuration, account policy and worker capacity; do not assume submissions are globally disabled.

### URL imports and provider swaps

Read [provider architecture](video_providers/README.md),
[provider AGENTS](video_providers/AGENTS.md) and the selected provider's README.
Vendor endpoints/credentials live only in a private adapter. NestJS's
`AudioAcquisitionClient` uses the uniform binary contract and generic
`AUDIO_ACQUISITION_API_URL` / `AUDIO_ACQUISITION_API_KEY`.
Save included metadata as sanitized nullable MongoDB `extra_data`; no paid
enrichment. Preserve audio-only validation, bounded scratch and cleanup.
Swap providers by deploying a contract-compatible adapter and updating env,
not by adding vendor branches to NestJS. No extraction fallback, migration
bridge or old-device compatibility layer. Current VideoScale support is YouTube
only. Record local checks separately from live deployment evidence.

## Rules that bite

From `backend/AGENTS.md` and component guides — these are enforced boundaries, not style preferences:

- Backend is ESM: relative imports need `.js` suffixes; use `import type` for types (notably Mongoose `Connection`, which is not an ESM runtime named export). Tests run through SWC decorator metadata, so DI/validation behave like the real build.
- Reuse the existing Mongo worker-claim scheduler and separate BullMQ import queue; do not add a second scheduler. Do not commit, push, deploy, create cloud resources, or touch real data without a direct request.
- Never read or print real dotenv values, AWS keys, or connection URIs. Firebase config files (`google-services.json`, `GoogleService-Info.plist`), keystores, and `.env*` are local-only and git-ignored — never force-add. `pnpm run verify` includes a tracked-file credential scan.
- The web app's `PUBLIC_*` values are browser-visible identifiers, not backend secrets; never copy API service credentials into that app. Read `web-client/README.md` and root `AGENTS.md` before web edits.
- Production DB changes are limited to collections/indexes declared by Mongoose schemas; no automatic index drops or document migrations.
- Env keys validate centrally in `backend/src/config/`; new keys must update the safe examples and docs.
- Report which commands actually ran and distinguish local proof from Docker/Atlas/S3/VPS validation — they are separate boundaries. Skipped checks get reported as skipped, not passed.
- pnpm: never `--force` or `--legacy-peer-deps`; preserve lockfiles.
