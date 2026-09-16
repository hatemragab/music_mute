# B02: Atomic audit events and safe operation receipts Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Make privileged changes attributable and recoverable after ambiguous network responses without storing secrets.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B01](../backend/B01-admin-identity-permissions.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin/admin-audit.schema.ts, admin-audit.service.ts, admin-audit.controller.ts, admin-operation.schema.ts, admin-operations.service.ts, admin-operations.controller.ts.
- Create backend/src/admin/admin-audit.service.spec.ts, admin-operations.service.spec.ts; backend/test/admin-audit.e2e-spec.ts and backend/test/admin-audit.integration.mjs.
- Modify backend/src/admin/admin.module.ts and register schema indexes through the existing awaited initialization pattern.

## Interfaces

GET /admin/audit and GET /admin/operations/:operationId from contracts.md. AdminAuditService.record(actor,event,session) participates in the caller transaction. Operation receipts key actor+route+operationId and contain only safe resource/result metadata.

## Steps

- [ ] 1. Specify fixtures with concurrent repeats, same ID/different request, actor mismatch, and audit insert failure. Test unknown-field rejection instead of accepting arbitrary event payloads.

- [ ] 2. Implement strict allowlisted audit fields, bounded reasons, cursor pagination and indexes on time+ID, resource+time, actor+time. No TTL and no media filenames, raw keys/digests, URLs or whole payload snapshots.

- [ ] 3. Implement transaction-coupled operation reservation and completion. Non-secret mutations may recover their prior result; in-flight returns OPERATION_IN_PROGRESS; mismatched request fingerprints return conflict. Receipts never persist raw request bodies or temporary grants.

- [ ] 4. Scope receipt reads to initiating actor or owner. Key operations record successful identity/revision only; a repeated key creation ID never reveals another raw key or reexecutes issuance.

- [ ] 5. Expose owner-only audit reads with exact filters and safe error handling. Test malformed cursor/date/filter bounds and denied roles.

- [ ] 6. Run isolated transaction tests for rollback and duplicate requests using existing local helpers. Verify stored documents contain no seeded secret marker or presigned URL.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: An audit insert failure rolls back the state mutation in the same MongoDB transaction.
Scenario 2: Two concurrent requests with one operationId produce one event and one state change.
Scenario 3: A non-owner cannot read another actor's receipt; no receipt contains a signed URL.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin/admin-audit.service.spec.ts src/admin/admin-operations.service.spec.ts
npm run test:e2e -- test/admin-audit.e2e-spec.ts
npm run build
node --test test/admin-audit.integration.mjs
```

## Completion evidence

- [ ] All subsequent write tasks can reuse one audited transaction/receipt convention and safe ambiguous-response handling.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
