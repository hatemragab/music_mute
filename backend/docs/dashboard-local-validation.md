# Dashboard backend local validation

This file records local evidence and its limits. The B18 local backend handoff gate passed on 2026-09-11. The dashboard target is React + TypeScript + Vite; the corrected task plans and `docs/tasks/full-dashboard/execution.md` record that decision. Backend routes, permissions and behavior remain the handoff authority for the dashboard implementation.

## Current dashboard backend evidence

The latest compiled isolated workflow exercised owner access grant, worker registration/claim/drain/stopped recovery, support media grant, APK verification, release publication and withdrawal. The latest health/alert native fixture also passed with two independent API service instances, a durable out-of-order observation fence, active-episode deduplication, resolution and recurrence. These are synthetic local MongoDB/Redis/storage/verifier checks and do not prove live Firebase, S3, Android toolchain, Windows worker or production behavior.

The final gate passed formatting, lint, TypeScript checking, 684 unit tests across 87 files, 136 HTTP tests across 25 files and a Nest build. The compiled dashboard integration passed 55 native tests. The route matrix covers 45 admin routes, anonymous/ordinary/password/revoked/worker credentials, all five roles, fresh-auth boundaries, validation, rate limits, no-store headers and redaction. The connected workflow passed 36 API requests and produced 13 audit events through a plain `main` startup. Thirty-two normalized synthetic response examples are recorded in [`test/fixtures/dashboard-contracts/workflow.json`](../test/fixtures/dashboard-contracts/workflow.json).

The separate curl gate used `/usr/bin/curl` to probe all 45 admin routes and execute the 36-request connected workflow against a uniquely named database on the configured local MongoDB replica set `rs0`. It batch-inserted two synthetic users and produced 43 documents across 26 collections. MongoDB MCP read-back confirmed the collection/document inventory. The exact owned fixture database was removed afterward; existing `musicmute` data was untouched.

The backend gate must include, at minimum:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
node --test test/admin-alerts.integration.mjs
npm run test:dashboard:integration
npm run test:dashboard:curl
npm run test:auth:integration
npm run test:processing:integration
npm run test:deletion:integration
```

All commands above passed on 2026-09-11. Do not infer hosting readiness, live cloud access, outbound notifications, mobile installation, or external Windows-worker execution from these local fixtures.

## React dashboard handoff checks

Before React dashboard work starts, compare its typed contracts against [dashboard-api.md](dashboard-api.md) and its navigation/actions against [dashboard-permissions.md](dashboard-permissions.md). The client must use the returned permission list, opaque cursors, revisions and operation receipts; keep one-time worker keys and signed URLs in transient UI state. Browser media semantics apply to the React web dashboard: playback starts from an explicit user action, and an issued signed URL cannot be revoked instantly.

No hosting files, DNS, reverse proxy, Firebase project, S3 bucket, production database, worker machine or app installation is changed by this documentation or by the isolated validation workflow.

## Private APK upload and verification (B12)

The API reserves a private object key below `app-releases/` and an exact byte
length and SHA-256 checksum. The presigned POST is valid for 15 minutes. Only the
selected upload for a direct Android draft can be verified. Completion pins an
S3 object version, downloads that exact version, verifies the file checksum and
ZIP limits, then invokes the configured Android tools. No APK content executes.

APK inspection is synchronous with a 90-second cancellation deadline. Verification
uses its own CAS lease, outside the short admin transaction. Reservation, lease
selection, and final outcome are separately audited transactions. Final artifact
metadata, audit event, and receipt commit together. An expired lease may be
reclaimed against the same pinned version; the prior token cannot complete after
replacement. Status polling is read-only and may report `verifying` until a
subsequent completion call recovers an expired lease. A crash does not publish an
unverified release. Rejected uploads require a new reservation.

Configure these non-secret settings explicitly for APK verification:

| Key                         | Requirement                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `APK_AAPT2_PATH`            | Absolute path to the trusted installed `aapt2` executable.                                                                         |
| `APK_APKSIGNER_PATH`        | Absolute path to the trusted installed `apksigner` executable; its Java runtime must also work.                                    |
| `APK_EXPECTED_PACKAGE_ID`   | Maintained Android application ID; the upload cannot choose it.                                                                    |
| `APK_TRUSTED_SIGNER_SHA256` | One to ten lowercase 64-character certificate SHA-256 fingerprints, comma-separated; configure from approved release certificates. |
| `APK_MAX_MIN_SDK`           | Highest accepted APK minimum SDK, default 26, integer 1–100. Raising it is an explicit compatibility decision.                     |

Absent verifier tools, package ID, or signer configuration fails verification
closed. Tool stdout/stderr is capped at 1 MiB combined. Child process groups are
killed on timeout; temporary APK files are cleaned on success or failure. ZIP64,
encrypted entries, duplicate/path-traversal names, overlapping entries, missing
manifests, excessive entry count, excessive expansion, and malformed directories
are rejected before Android inspection. Artifact size is capped at 256 MiB.
The verifier also reads the compiled manifest tree because current `aapt2`
badging omits `versionCodeMajor`. Nonzero major codes exceed the API's supported
build range and are rejected even when the low version code matches the draft.

Run from `backend/`:

```sh
npm test -- src/releases/apk-verifier.service.spec.ts src/releases/apk-environment.spec.ts src/releases/release-upload.service.spec.ts src/releases/release-artifact-storage.service.spec.ts
npm run test:e2e -- test/admin-release-uploads.e2e-spec.ts
npm run build
node --test test/apk-verifier.integration.mjs test/release-upload.integration.mjs
```

The APK integration test creates a temporary synthetic RSA key and signed APK;
it never reads maintained signing keys or app binaries. By default it uses Android
Build Tools 35.0.0 and platform 35 below `ANDROID_HOME` (or the standard macOS SDK
location). `TEST_APK_AAPT2_PATH`, `TEST_APK_APKSIGNER_PATH`, and `TEST_ANDROID_JAR`
can select installed test tools. Missing tools are reported as a skipped test and
must not be counted as native verification proof. The lifecycle integration test
uses an isolated MongoDB replica set and synthetic storage/verifier adapters.

Local native tool and replica-set tests do not establish container/hosting tool
availability, live private-S3/IAM/CORS behavior, production signer compatibility,
publication, store availability, or device installation. This task does not
install hosting tools, modify cloud resources, upload live artifacts, or perform
mobile installation.
