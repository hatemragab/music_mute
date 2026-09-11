# B12: Private APK upload and bounded binary verification Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Verify uploaded signed APK identity and integrity before any release can become publishable.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B11](../backend/B11-release-model-public-policy.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create or reuse backend/src/releases/release-upload.service.ts, apk-verifier.service.ts, release-artifact-storage.service.ts, release-upload.controller.ts and corresponding *.spec.ts.
- Modify backend/src/config/environment.ts and existing storage client wiring only for validated local verifier settings; do not edit real environment files.
- Create backend/test/admin-release-uploads.e2e-spec.ts, backend/test/apk-verifier.integration.mjs; document local verifier requirements in backend/docs/dashboard-local-validation.md.

## Interfaces

Release upload reservation/complete/status routes in contracts.md; ArtifactState awaiting_upload|verifying|verified|rejected. Reservation -> private S3 form grant; verifier consumes the server-selected immutable object identity and returns package/version/build/signer/checksum metadata.

## Steps

- [ ] 1. Write tests for >256 MiB, wrong checksum/size, truncated/unsigned/tampered APK, wrong application ID, version/build mismatch, untrusted signer, invalid object version, malformed archive and verifier timeout.

- [ ] 2. Reserve unique immutable S3 keys under app-releases/ and exact expected size/checksum. Grant expiry is 15 minutes; browser uploads directly and finalizes by upload ID. Never accept caller-selected buckets/keys or proxy arbitrary upload bytes through the API.

- [ ] 3. Pin the exact S3 version after upload; do not trust metadata alone or a later mutable key. Verify SHA-256 by reading bounded artifact bytes before extracting package/build/signer with trusted installed Android inspection tools.

- [ ] 4. Use explicit executable paths, argument arrays without shell interpolation, isolated temporary directories, archive/output limits, process cancellation and a 90-second deadline. Reject tool unavailability instead of marking an upload verified. Clean temporary files without touching user media.

- [ ] 5. Coordinate completion/status with a bounded verification lease and idempotent completion receipts. Same completion may return verifying; stale completion cannot overwrite the selected version. Successful metadata becomes immutable.

- [ ] 6. Run fixture-signed APK and tampered APK tests locally if verifier tools exist. Record missing tools as a blocker. Hosting/container tool installation and cloud bucket/IAM/CORS changes are excluded; do not claim packaged-host compatibility from unit mocks.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: A matching hash with a wrong signer remains rejected and cannot be published.
Scenario 2: Two completion calls verify one pinned object version; a replacement at the same key cannot change the verified binary.
Scenario 3: Timeout kills the verifier process, marks a safe failure and leaves no temporary artifact behind.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/releases/release-upload.service.spec.ts src/releases/apk-verifier.service.spec.ts src/releases/release-artifact-storage.service.spec.ts
npm run test:e2e -- test/admin-release-uploads.e2e-spec.ts
npm run build
node --test test/apk-verifier.integration.mjs
```

## Completion evidence

- [ ] Only verified immutable APKs can reach publication, with local tool availability distinguished from hosting proof.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
