# B13: Release preview, atomic publication, withdrawal and download Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Let release managers preview and publish valid platform/channel updates without stranding users or losing audit history.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B02](../backend/B02-audit-operation-receipts.md), [B11](../backend/B11-release-model-public-policy.md), [B12](../backend/B12-apk-upload-verification.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create or reuse backend/src/releases/release-publication.service.ts, release-download.service.ts, admin-update-policy.controller.ts, dto/update-policy.dto.ts and associated *.spec.ts.
- Extend app-updates.controller.ts and admin-releases.controller.ts; use existing app-policy transaction persistence.
- Create backend/test/admin-publication.e2e-spec.ts, backend/test/admin-publication.integration.mjs.

## Interfaces

GET /admin/update-policy, POST preview, release publish/withdraw, and public POST /app-updates/releases/:id/download. Both current policy revision and release revision participate in publication; content and selected target are updated atomically.

## Steps

- [ ] 1. Create channel fixtures for Android direct+Play and iOS with optional/required/no-update states. Test preview is read-only and includes representative installed-build decisions.

- [ ] 2. Validate complete target availability, verified APK metadata, store URL/app identity, positive build numbers and minimum <= target for every activated channel. Store publication requires explicit current availability attestation; syntax checking is not distribution proof.

- [ ] 3. Publish immutable content, policy selections, legacy projection, revisions, operation receipt and audit in one MongoDB transaction. Stale drafts/policies return conflict with no partial writes.

- [ ] 4. Withdraw through a valid replacementPolicy, explicitly permitting audited minimum lowering/recovery. Do not delete APKs, mutate published changelogs or promise an installed-app downgrade.

- [ ] 5. Issue fresh 60-minute public download grants only for active published verified direct releases; use fixed stored object version and omit URLs from policy/audit. Recheck current publication state; denied withdrawn downloads cannot reveal object identity.

- [ ] 6. Run concurrent publish/withdraw, audit-failure rollback, unknown-response receipt/read-back and both Android channels' compatibility tests.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Two publishers with one expected policy revision produce one winning transaction.
Scenario 2: Withdrawal preserves release history and APK object while changing the active policy.
Scenario 3: A Play-distributed app never receives a direct APK fallback, even when direct source is preferred.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/releases/release-publication.service.spec.ts src/releases/release-download.service.spec.ts
npm run test:e2e -- test/admin-publication.e2e-spec.ts
npm run build
node --test test/admin-publication.integration.mjs
```

## Completion evidence

- [ ] Publication is previewable, atomic and reversible at the policy level without claiming to downgrade installed binaries.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
