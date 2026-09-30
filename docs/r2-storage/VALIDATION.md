# R2-only migration validation — 2026-09-30

This record covers the local `hatem/r2-storage-migration` worktree. The owner
approved breaking storage identities and fresh MongoDB. Checks below are recorded
only after execution, including the final backend rerun and compiled integrations.
No commit, push, publication, deployment, cloud configuration, real data deletion or billable
R2 test is part of this record. See [setup and architecture](README.md).

## Verification boundaries

| Boundary         | Evidence and limitation                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local fixtures   | Unit tests, SDK signing, local HTTP/browser fixtures and isolated MongoDB/Redis exercise the changed contracts without real R2 credentials.                                                      |
| Native simulator | Only the existing iPhone 17 Pro / iOS 26.0 simulator, `3CC14436-EC3C-4419-A079-C84951E5FA07`, is authorized. Simulator fixtures are separate from live Firebase/R2 proof.                        |
| Android          | JVM tests, lint and builds provide local source/build evidence; no Android device/UI target is substituted.                                                                                      |
| Cloud/live       | Not run. No real R2 PUT/GET/HEAD/list/delete, bucket CORS/permissions verification, real vendor import, authenticated cloud processing, installer publication or billing measurement is claimed. |

## Local checks executed

Commands run from their component directory unless otherwise stated. Backend
build-producing checks were serialized because they share `dist`. Focused results
below overlap the aggregate suite and must not be added to its test count.

| Component                        | Command                                                                                                                                                                     | Result                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend final aggregate          | `pnpm run verify`                                                                                                                                                           | Passed: format, lint, typecheck, 5 scanner tests + tracked scan, 8 benchmark tests, 1,022 unit tests, 158 e2e tests and build. This final run includes the cleanup-stage changes. |
| Backend compiled integrations    | Exact command below                                                                                                                                                         | Passed: 27 tests across 14 files against local fixtures/MongoDB/Redis, including shared retry protection, late PUT cleanup stages and account-purge waiting.                      |
| Backend worker focus             | `pnpm exec vitest run src/worker-fleet --reporter=dot`                                                                                                                      | Passed: 110 tests in 15 files.                                                                                                                                                    |
| Backend storage focus            | `pnpm exec vitest run src/storage/storage-transfers.service.spec.ts src/storage/storage-preflight.service.spec.ts src/infrastructure/storage.module.spec.ts --reporter=dot` | Passed: 49 tests in 3 files.                                                                                                                                                      |
| R2 integration opt-in gate       | `MUSICMUTE_R2_INTEGRATION=false node --test test/worker-fleet-r2.integration.mjs`                                                                                           | 1 skipped as intended. No cloud calls; this proves the gate, not a successful real transfer.                                                                                      |
| Worker/service integration gates | `node --test test/worker-fleet-r2.integration.mjs test/worker-fleet-macos-service.integration.mjs test/worker-fleet-windows-service.integration.mjs`                        | 3 skipped as intended without explicit opt-in. No cloud/service acceptance claimed.                                                                                               |
| Read-only diagnostic syntax      | `node --check video_providers/videoscale/inspect-live-job.mjs` (repository root)                                                                                            | Passed. The diagnostic was not executed against a database or bucket.                                                                                                             |
| Benchmark CLI help               | `node backend/scripts/benchmark-audio-transfers.mjs --help` (repository root)                                                                                               | Passed without network access. The script requires explicit bounded writes and a dedicated test bucket.                                                                           |
| Actual SDK local signing         | Local `getSignedUrl` invocation with synthetic credentials/account endpoint                                                                                                 | Passed: signed Content-Length, Content-Type, Host, If-None-Match, checksum and metadata; no object version parameter or hoisted checksum. Signing made no storage request.        |
| Provider comment-only syntax     | Python AST parsing of `video_providers/videoscale/service.py`                                                                                                               | Passed. Only a comment/log label changed; no provider acquisition or paid vendor test was run.                                                                                    |

After the aggregate/integration runs, the final owner-filter optimization was
checked with `pnpm run typecheck`,
`pnpm exec vitest run src/storage/storage-cleanup.service.spec.ts` (12 passed),
`pnpm run build` and `node --test test/storage-cleanup.integration.mjs` (1 passed).
All exited 0. The focused tests overlap the aggregate count.

Final compiled local integration command, from `backend/`:

```sh
node --test --test-concurrency=1 \
  test/storage-cleanup.integration.mjs \
  test/processing-persistence.integration.mjs \
  test/processing-usage.integration.mjs \
  test/job-actions.integration.mjs \
  test/account-deletion-request.integration.mjs \
  test/account-deletion.integration.mjs \
  test/account-recovery.integration.mjs \
  test/url-imports.integration.mjs \
  test/url-import-runtime.integration.mjs \
  test/url-import-admission.integration.mjs \
  test/admin-media.integration.mjs \
  test/release-upload.integration.mjs \
  test/dashboard-contract.integration.mjs \
  test/worker-fleet.integration.mjs
```

### Web and dashboard

| Directory     | Executed commands                                                                                                                              | Result                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-client/` | `npm ci --ignore-scripts`; `npm run lint`; `npm run typecheck`; `npm test`; `npm run build`; `npm run test:server`; `npm run test:e2e`         | Passed: 130 unit tests, 9 server tests, 6 installed-Chrome fixture tests, static checks and build.                                                       |
| `web-client/` | `npm run format:check`                                                                                                                         | Final full check passed after formatting README and the two touched task docs. Earlier docs-only failures were fixed.                                    |
| `dashboard/`  | `npm ci --ignore-scripts`; `npm run format:check`; `npm run lint`; `npm run typecheck`; `npm test`; `npm run build`; `npm run test:deployment` | Passed: 98 unit tests, 11 deployment tests, formatting/static checks and build.                                                                          |
| `dashboard/`  | `npx playwright test --config /tmp/musicmute-r2-apk-upload.config.mjs`                                                                         | Passed: 1 isolated installed-Chrome APK redirect fixture test. Temporary config started only local dashboard Vite, avoiding concurrent backend rebuilds. |

Browser storage/API traffic was synthetic and intercepted. These results do not
prove real Firebase authentication, bucket CORS, R2 uploads or live processing.
The isolated APK redirect check is not the full dashboard browser suite.

### Native clients

Android, from `android/`:

```sh
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-17.0.2.jdk/Contents/Home \
  ANDROID_HOME=/Users/hatemragap/Library/Android/sdk \
  ./gradlew :app:testDirectDebugUnitTest :app:lintDirectDebug \
  :app:assembleDirectDebug :app:assemblePlayDebug
```

Passed: all 316 normal DirectDebug JVM tests, DirectDebug lint, and direct/play
debug builds. A missing genuine Firebase config was temporarily replaced with an
ignored synthetic `app/google-services.json` using checked-in test settings and
the normal application ID; it was removed afterward. No Android device/UI run or
real Firebase success is claimed. An earlier authE2e variant had one unrelated
installer/listing application-ID mismatch; that run is not recorded as passed.

Native iOS, from `ios/`:

```sh
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath /tmp/musicmute-r2-client-tests \
  -parallel-testing-enabled NO \
  -only-testing:VocalTests/UploadRecoveryTests \
  -only-testing:VocalTests/JobsAPIClientTests \
  -only-testing:VocalTests/ProcessingMediaPolicyTests \
  -only-testing:VocalTests/AudioPipelineCoordinatorTests \
  -only-testing:VocalTests/JobActionsTests \
  test CODE_SIGNING_ALLOWED=NO
```

Passed: 48 focused tests; app/test targets compiled. Only the existing authorized
iPhone 17 Pro / iOS 26 simulator was used. A missing genuine Firebase plist was
temporarily replaced with ignored synthetic `GoogleService-Info.plist` and then
removed. Touched Swift files were formatted; recursive SwiftLint exited 0 with
baseline warnings in untouched `Vocal/Auth/AuthAPIClient.swift`. This is focused
simulator evidence, not a full native UI journey or real authentication/storage.

### Worker / CLI

From `worker/`:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm run test:packaging
pnpm run format:check
pnpm run protocol:check
pnpm test -- --reporter=dot
node scripts/test-package.mjs
```

Passed: 549 tests with 17 skipped; 85 test files passed and 5 skipped (90 total).
Packaging passed 11 tests; format, lint, typecheck, protocol and build passed.
The packed consumer CLI smoke check passed (343 packed files); its production
dependency audit reported 0 vulnerabilities. Nothing was published. Hardware,
service-acceptance and engine execution are separate: aggregate `pnpm verify`
and `test:engine` were not run, and skipped tests are not passing device proof.

### Final documentation/tooling checks

Passed after final documentation edits:

- From `backend/`, `pnpm exec prettier --check ../docs/r2-storage/VALIDATION.md ../docs/r2-storage/README.md openapi.yaml`.
- The existing scanner's `scanTrackedFiles` plus `scanText` on all 8 files returned
  by `git ls-files --others --exclude-standard`: no secret findings. Only file
  names/rules or the count were reported; file contents were not printed.
- Local Markdown link resolution in this guide and `README.md`: 2 links checked,
  none missing.
- From the repository root, `git diff --check`: passed.

These checks do not make storage API calls.

## Main changed files

| Group                    | Main files / resulting behavior                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                  | `backend/src/config/environment.ts`, `backend/src/infrastructure/storage.module.ts`, `backend/src/storage/object-identity.ts`, `immutable-upload-grant.ts`, `storage-transfers.service.ts`, `storage-preflight.service.ts`, `storage-cleanup*.ts`: R2-only required configuration, explicit backend credentials, S3-compatible SDK, signed create-only uploads, quoted ETag/checksum identity, cached storage observations and exact-key cleanup. |
| Backend jobs/releases    | `backend/src/jobs/job.schema.ts`, `job-actions.service.ts`, `job-deletion.service.ts`; processing cleanup, account deletion cleanup, release schemas/upload/download/artifact services: fresh ETag identities, protected references and unchanged authorization/accounting/publication checks.                                                                                                                                                    |
| Native + web             | Android `ObjectStorageUploader.kt` and processing repository; iOS `ObjectStorageUploadFile.swift`, background coordinator/repository and project references; web `server.mjs`, upload preparation/component: generic names, exact four upload headers, existing progress/recovery, opaque backend URLs and explicit R2 CSP origin.                                                                                                                |
| Worker / CLI             | `worker/src/runtime/{contracts,transfers,control-plane-client,worker-runtime}.ts`, enrollment client/qualification uploader and service-acceptance fixtures; backend worker DTO/services: ETag input/output/qualification contracts, streaming integrity/recovery and no permanent storage credentials.                                                                                                                                           |
| Dashboard                | `dashboard/src/features/releases/apk-upload*.ts*`: strict checksum metadata/create-only headers and synthetic upload coverage; browser never receives storage credentials.                                                                                                                                                                                                                                                                        |
| Deployment / environment | `backend/.env.local.example`, `.env.production.example`, `backend/package.json`, `backend/config/worker-installation-catalog.json`: generic required runtime configuration, opt-in R2 integration script and intentionally empty unverified artifact entries. Docker/CapRover/CI were searched; no extra storage service or baked secret was introduced.                                                                                          |
| Docs                     | `docs/r2-storage/README.md`, this record, `backend/openapi.yaml`, `docs/api/client-contract.md`, component READMEs/agent guides, storage architecture/operator runbooks and worker source maps; historical AWS evidence is marked as earlier-provider evidence, not rewritten as R2 proof.                                                                                                                                                        |
| Tests/tools              | Storage/config/cleanup/release/worker specs and isolated integration fixtures, native/web/dashboard tests, `backend/scripts/benchmark-audio-transfers*.mjs`, credential scanner tests and `video_providers/videoscale/inspect-live-job.mjs`.                                                                                                                                                                                                      |

The retained `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` packages and
`x-amz-*` protocol headers are intentional S3-compatible tooling. Upstream
owner-hosted model URLs remain unchanged; model weights are not mirrored to R2.

## Environment changes

| Previous storage setting                                         | New setting                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AWS_REGION`                                                     | `STORAGE_REGION=auto`                                                                                              |
| `S3_BUCKET` / `AWS_S3_BUCKET`                                    | `STORAGE_BUCKET=music-mute`                                                                                        |
| `AWS_ACCESS_KEY_ID`                                              | `STORAGE_ACCESS_KEY_ID` (backend only)                                                                             |
| `AWS_SECRET_ACCESS_KEY`                                          | `STORAGE_SECRET_ACCESS_KEY` (backend only)                                                                         |
| AWS profile / SDK default credential chain / `AWS_SESSION_TOKEN` | Removed; explicit R2 S3 API credentials required.                                                                  |
| Regional bucket endpoint assumption                              | `STORAGE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, account root without bucket/path/trailing slash. |
| Provider detection / AWS fallback                                | `STORAGE_PROVIDER=r2`, the only accepted provider.                                                                 |
| `S3_TRANSFER_ACCELERATION_ENABLED`                               | Removed.                                                                                                           |
| `PUBLIC_MEDIA_ACCELERATION_ENABLED`                              | Removed.                                                                                                           |
| Default AWS browser media origin                                 | Required exact R2 HTTPS account origin in web-server `PUBLIC_MEDIA_ORIGIN`.                                        |

Safe examples contain placeholders. No actual Account ID, access key, secret,
provider credential, database URI with credentials or personal media was committed
or published by this task.

## Cleanup contract checked

General exact-key cleanup stores durable `firstDeletedAt` in
`StorageCleanupTask`; job-deletion cleanup stores `cleanupFirstDeletedAt` in the
job schema. After the recorded grant deadline plus a one-hour settlement window,
the first exact-key DELETE is recorded. A second exact-key DELETE two hours later
must succeed before cleanup completes. Retry/restart and replica contention retain
the durable stage, rather than turning an uncertain first DELETE into completion.
Both DELETE operations are free R2 operations and require no HEAD/list polling.

Reference checks protect shared retry inputs and currently accepted successful
inputs/outputs until their owning jobs release them. Cleanup settlement extensions
and lifecycle races must not erase current references or accept stale completion.
Manual retry after committed input cleanup requires a new input/key. Account purge
waits for pending cleanup and then removes completed key records as before;
long-term object-key tombstones are not introduced.

The settlement/recheck horizon is application policy, not a universal provider
limit for an external PUT started before URL expiry. Local race fixtures cannot
prove that an arbitrarily slow external transfer can never finish later. Real
bounded late-PUT/cleanup acceptance remains a separate opt-in integration check.

## Remaining manual setup and live proof

- Supply backend-only R2 S3 API credentials and the exact account-root endpoint;
  keep `music-mute` private, Standard, without a public `r2.dev` URL/domain.
- Configure actual browser CORS origins and exact GET/PUT/signed upload headers;
  configure the browser server's required `PUBLIC_MEDIA_ORIGIN`. No cloud/CORS
  configuration was inspected or changed here.
- The owner recreates MongoDB themselves. No database reset, old-record migration,
  source-object copy, source AWS deletion or live data change was executed.
- Runtime release entries and qualification fixture remain empty until real R2
  objects with verified ETag/size/type/SHA-256/signature are republished/promoted.
  Installer/update/qualification is intentionally unavailable before publication.
  APK releases also need publication through the existing trusted verification
  flow after the fresh database setup.
- Validate real checksum/overwrite rejection, URL expiry, browser ranged playback,
  native/worker transfers, cleanup races, installation and APK verification using
  bounded synthetic assets and explicit opt-in dedicated test-bucket credentials.
- `MUSICMUTE_R2_INTEGRATION=true pnpm run test:worker:integration:r2` uses a private
  dedicated bucket matching `music-mute-test-<suffix>`. It never loads
  `.env.production`. Without opt-in it skips. PUT/HEAD/GET/storage usage can be
  billable; it has not been run with real credentials in this record.
- MongoDB reset does not stop charges for any old AWS objects/resources. Their
  cleanup is a separate owner decision; this implementation does not administer
  them or claim current billing totals.

## Final record status

All reported implementation suites above passed within their stated local/fixture
boundaries; explicit opt-in skips are listed separately. Final documentation
formatting, secret/link scanning and whitespace checks passed. Live R2
configuration and the manual setup above remain unverified.
