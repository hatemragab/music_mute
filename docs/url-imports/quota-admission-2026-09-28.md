# Monthly quota admission — 2026-09-28

## Agreed behavior

Admission checks monthly used plus reserved seconds **before** the new file.
Any positive allowance remaining admits the complete song, including a song
longer than the remaining allowance. Once used plus reserved reaches or exceeds
the limit, new local jobs and URL acquisitions are rejected. Accepted files
finish normally; actual measured duration is counted, and remaining is clamped
to zero. Existing account access, per-file media caps and transfer protections
remain in force. No additional acquisition-attempt budget was introduced.

## Implementation

- `ProcessingUsageService.reserveForJob` checks existing usage atomically instead
  of requiring the new file to fit wholly within remaining monthly allowance.
- URL-import execution reserves a temporary per-file-cap hold before calling the
  private acquisition adapter. This is allowed even with one minute remaining.
- Job creation exchanges that hold for actual duration within the same MongoDB
  transaction. The full-cap hold is not a new minimum remaining allowance.
- Failure/recovery marks the import terminal and releases its hold atomically.
  `acquisitionReservedAt` fences late acquisition against concurrent recovery.
- Authoritative duration reconciliation adjusts accepted reservations even when
  they cross the monthly limit. Future admissions observe the adjusted total.
- Routes, payloads and error codes remain compatible; native clients already
  check remaining allowance against zero and accept over-limit usage counters.

## Local validation

- `pnpm run verify`: formatter, lint, TypeScript, secret/transfer checks,
  965 unit tests, 148 HTTP tests and compiled build passed.
- `pnpm run test:imports:integration`: 15 tests passed against isolated services,
  including pre-provider rejection at the limit, concurrent admission, one minute
  remaining accepting a four-minute import/local song, accounting adjustment,
  failure cleanup and crash recovery.
- `pnpm run test:processing:integration`: 15 tests passed. The former strict-fit
  reservation expectations were updated to the explicitly requested admission
  rule; the first run exposed one remaining old assertion, fixed before the pass.
- `git diff --check` and touched documentation format checks passed.

## Deployment package

The first build failed with BuildKit session deadline/cancellation errors during
fresh dependency installation. Release 84 remained running. The retry keeps the
release-84 package manifest: the only local manifest difference adds an integration
test entry point, and runtime/development dependency versions are identical. This
reuses cached dependency layers without changing source or dependency versions.

Retry archive: `/tmp/musicmute-quota-admission.tar`.
SHA256: `00ead1f1482ab952dc5077a47a0e3ba3cdd155736ba1e7e2a44945e7c79b08d1`.
Compared with release 84, only these production inputs differ:

- `backend/src/jobs/jobs.service.ts`
- `backend/src/processing-usage/processing-usage.service.ts`
- `backend/src/url-imports/import-processor.ts`
- `backend/src/url-imports/imports.service.ts`
- `backend/src/url-imports/media-import.schema.ts`

The allowlisted archive excludes dotenv files, credentials and user media.
There were zero active imports at the pre-deployment check. No commit or push,
client release, provider release or automatic replay of failed user imports.

## API review

The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-09-28. Endpoint authorization, compatible contracts, idempotent
request handling, documented error responses and existing problem responses were
preserved. The business quota policy change is explicitly user-authorized and
is documented for both `POST /jobs` and `POST /media-imports`.

## Live verification

- CapRover deployment succeeded: `img-captain-api:86`, container
  `6eb0d1b10545`, one of one replicas running. Failed build 85 never replaced 84.
- Public `GET https://api.music-mute.com/health/ready` returned HTTP 200 and
  `{"status":"ok"}` after deployment.
- All five changed compiled JavaScript modules have identical SHA256 hashes in
  the running container and the locally tested build.
- Executed deployed `ProcessingUsageService` against production MongoDB inside
  an explicitly aborted transaction with random synthetic identifiers. The test
  admitted a full URL-import hold with one minute remaining, rejected further
  local admission at the limit, exchanged the hold for a four-minute job,
  accepted an increased measured duration, settled full measured usage, and
  rejected the next import. The transaction was rolled back and read-back
  confirmed zero persistent fixture usage/reservation records.
- No provider calls, user-media transfers, or new S3/worker jobs were made by
  these deployed checks. This establishes deployed quota/accounting behavior,
  not a fresh full media-processing E2E or vendor-billing result.
- Adapter remains image 6; clients/workers were not redeployed. Failed historical
  imports were not automatically replayed.
