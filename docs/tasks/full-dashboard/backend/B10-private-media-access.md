# B10: Audited playback and download grants for user media Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Allow Owner and Support to play/download verified inputs/results through short-lived private S3 grants.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B02](../backend/B02-audit-operation-receipts.md), [B07](../backend/B07-user-search-processing-suspension.md), [B08](../backend/B08-job-search-detail-attempts.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-jobs/admin-media.controller.ts, admin-media.service.ts, dto/admin-media-grant.dto.ts and admin-media.service.spec.ts.
- Reuse backend/src/storage/storage-transfers.service.ts and account deletion/identity fences; add safe disposition signing options without changing existing mobile grant behavior.
- Create backend/test/admin-media.e2e-spec.ts, backend/test/admin-media.integration.mjs.

## Interfaces

POST /admin/jobs/:id/media-grants with asset=input|result, purpose=play|download, reason, operationId -> MediaGrant. Requires media.read + jobs.read and fresh Google authentication.

## Steps

- [ ] 1. Test role/reauthentication first, then absent/deleted jobs, pending uploads, unverified output, missing pinned version, deletion-in-progress and arbitrary key/URL injection.

- [ ] 2. Select stored verified inputObject or result identity only after authorization. Pin exact version and verify availability; never accept an object key, version, bucket or filename from request data.

- [ ] 3. Issue 300-second GET grants with sanitized inline/attachment disposition and correct MIME/size. Preserve Range support; use the existing private client. No API media-byte proxy, bucket listing or storage-policy changes.

- [ ] 4. Audit grant issuance transactionally under account/job fences; keep URL out of receipts/audit/logs. If deletion starts before grant issuance, deny; document that an already issued S3 URL is not instantly revocable.

- [ ] 5. Return 410 for verified objects that are no longer available; report unsupported browser codec through the future UI without transcoding original files. Input and vocals result grants remain distinct.

- [ ] 6. Verify response no-store, bounded rate limits, operation ambiguity handling and stored-document redaction with a fake signer plus isolated persistence. Record real browser/S3 range proof as a later owner-configured integration prerequisite.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Support can obtain a verified result grant; Worker Manager and Viewer get 403.
Scenario 2: A raw object key in the body is rejected, and no grant is signed during account deletion.
Scenario 3: A download uses attachment disposition and expires after 300 seconds; no audit event contains its URL.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-jobs/admin-media.service.spec.ts src/storage/storage-transfers.service.spec.ts
npm run test:e2e -- test/admin-media.e2e-spec.ts
npm run build
node --test test/admin-media.integration.mjs
```

## Completion evidence

- [ ] Approved administrator audio access is private, bounded, attributable and distinct from ordinary job metadata.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
