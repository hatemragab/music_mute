# B07: User search and processing-only suspension Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Give authorized support staff account visibility and reversible processing suspension without changing account deletion/auth state.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B03](../backend/B03-administrator-access-management.md), [B06](../backend/B06-processing-settings-admission.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin-users/admin-users.module.ts, admin-users.controller.ts, admin-users.service.ts, admin-users.presenter.ts, dto/admin-user.dto.ts and admin-users.service.spec.ts.
- Modify backend/src/users/user.schema.ts, user-identity-fence.service.ts and shared admission checks; preserve users.presenter.ts public output.
- Create backend/test/admin-users.e2e-spec.ts, backend/test/admin-users.integration.mjs.

## Interfaces

GET /admin/users, GET /admin/users/:id, suspend-processing/resume-processing routes. Processing restriction fields are independent of status active|disabled|deleting; an admin revision maps to the API revision.

## Steps

- [ ] 1. Write tests for exact UID/email and escaped prefix search, pagination/filter consistency, users.read restrictions and no personal expansion for viewers.

- [ ] 2. Add nullable/default processing restriction metadata and revision without rewriting existing records. Missing suspension means false; public user response does not leak operator notes.

- [ ] 3. Implement bounded indexed list/detail with existing timestamps and job counts. Do not invent last-login, IP, location or device/version adoption fields without a real persisted source.

- [ ] 4. Implement fresh-auth, reason-required suspension/resumption via existing identity/admission fences. Suspended active users may authenticate and read results; disabled/deleting accounts remain disabled/deleting even after resume.

- [ ] 5. Audit state changes atomically and prevent a concurrent account deletion from being reversed or bypassed. No admin hard-delete, Firebase disable action, password change or impersonation endpoint.

- [ ] 6. Test repeated operation IDs, stale revision, deletion race, ongoing processing completion and new create/retry rejection.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Support suspension leaves user.status active, login working and historical result access intact.
Scenario 2: Resume on a deleting account does not clear deletion state or restore admission.
Scenario 3: A viewer gets 403 for user search, even when it can list opaque user IDs on jobs.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin-users src/users
npm run test:e2e -- test/admin-users.e2e-spec.ts
npm run build
node --test test/admin-users.integration.mjs
npm run test:deletion:integration
```

## Completion evidence

- [ ] Account tools expose approved metadata and processing-only restrictions with deletion/auth invariants preserved.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
