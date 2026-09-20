# F integration evidence

Date: 2026-09-20
Branch: `codex/worker-integration`
Deployment: NOT_RUN; all evidence is local and no CapRover or production service was changed.

## Checkpoint status

| Checkpoint                                 | Status    | Evidence                                                                                                                                                                                                                                                                                                                                                                                            | Remaining gate                                                                                                                                                                                                           |
| ------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 complete product flow                   | SIMULATED | The compiled Nest API, isolated MongoDB replica set and Redis, authenticated job creation, one immutable S3 PUT for input, capability-matched claim, native worker processing, output PUT, exact-version completion and result download passed with installed CoreML and DirectML services against real configured S3.                                                                              | The real Android/iOS app initiation and result-consumption path remains NOT_RUN, so this is not yet a complete product-flow proof.                                                                                       |
| F2 ownership and recovery                  | SIMULATED | Two machines raced one queued job and exactly one owner won; same-request claim replay, wrong-owner rejection, cancellation fencing, lease-expiry recovery, stale-operation rejection and revoked-machine authentication passed against real isolated transactions. Existing focused suites cover session replacement, bounded retry, lost PUT response and supervisor/runtime recovery.            | A live installed-service/backend interruption sequence is still required on both hosts.                                                                                                                                  |
| F3 cancellation, deletion and policy races | SIMULATED | Cancellation versus an owned attempt, cleanup scheduling/cancellation, idempotent finalization, usage/outbox behavior and policy revision fences pass focused and integration coverage.                                                                                                                                                                                                             | Account deletion versus real inference/output publication and installed-service policy-change races remain NOT_RUN.                                                                                                      |
| F4 real platform services                  | PASS      | The installed Windows `LocalService` completed a real DirectML job and the installed Mac `_musicmute` LaunchDaemon completed a real CoreML job through the compiled local backend and versioned S3 using whole-object transfers. Native packaging, service identities, provider selection, job completion, result download and exact test-object cleanup are proven on both declared MVP platforms. | Logged-out and authorized reboot acceptance remain later release-readiness gates; one later Windows ephemeral-backend attempt ended `completion-uncertain` after backend exit and is not counted as a second clean pass. |
| F5 security and resilience                 | SIMULATED | Revoked credentials, forged machine ownership, stale attempts, grant/header/checksum validation, malformed and oversized protocol frames, path/archive safety, log redaction and native package safety pass focused suites.                                                                                                                                                                         | End-to-end backend restart, offline reconnect and installed-service grant misuse remain NOT_RUN.                                                                                                                         |
| F6 evidence reconciliation                 | PASS      | This report reconciles the passing real-S3 orchestration with the still-simulated engine and blocked host-service gates. Linux and CPU-only execution remain unsupported for the MVP.                                                                                                                                                                                                               | F1–F5 must reach their own release gates before the integration branch can exit.                                                                                                                                         |

## Real S3 acceptance

`pnpm run test:worker:integration:s3`: PASS, one test.

The test loads credentials without printing them, uses a unique isolated MongoDB database and Redis process, performs whole-object signed PUTs only, verifies the bucket's private/versioned preflight, completes and downloads the pinned result, and deletes only the exact reservation keys read back from that run's MongoDB records. A post-run S3 listing found zero recent integration objects.

The first live run found two production-path defects that fixture storage had hidden:

- five-second S3 metadata aborts were too short for the observed connection, so bounded preflight and object-verification calls now allow 30 seconds;
- `verifyUploadedVersion` spread the enriched worker reservation into `outputObject`, leaking `measuredDurationSeconds` and `grantExpiresAt` into a strict MongoDB embedded object. It now constructs only `key`, `versionId`, `bytes`, `sha256` and `contentType`, with a regression test using the enriched runtime shape.

Two failed diagnostic runs left four exact object versions before the cleanup defect was corrected. Those four explicit key/version pairs were removed, verified absent, and the final test removed its own two versions automatically.

## Local validation

- backend format, lint and typecheck: PASS;
- backend unit suite: PASS, 110 files and 753 tests;
- backend production build: PASS;
- isolated compiled API/worker integration: PASS;
- real-S3 compiled API/worker integration: PASS;
- worker protocol, format, lint, typecheck, TypeScript tests, Python tests and build: PASS; the TypeScript suite contains 31 files and 112 tests;
- S3 cleanup verification: PASS; each accepted platform run removed its two exact versioned integration objects.

## Honest stop condition

The integration branch is not complete. F1, F2, F3 and F5 remain `SIMULATED`;
F4 passes because both declared MVP platforms completed real installed-service
jobs through the compiled local backend and real S3. No deployment, feature
enablement, logout or reboot was performed.
