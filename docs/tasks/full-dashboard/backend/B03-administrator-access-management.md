# B03: Owner bootstrap and administrator access management Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Let owners manage role-bound access while preventing self-promotion and removal of the final owner.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B01](../backend/B01-admin-identity-permissions.md), [B02](../backend/B02-audit-operation-receipts.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin/admin-access.controller.ts, admin-access.service.ts, dto/admin-access.dto.ts, admin-access.service.spec.ts.
- Create backend/src/operations/admin-command.ts, admin-command.spec.ts; modify backend/src/operations/cli.ts and operations-cli.module.ts.
- Create backend/test/admin-access.e2e-spec.ts, backend/test/admin-access.integration.mjs; document private bootstrap arguments in backend/docs/dashboard-api.md.

## Interfaces

GET/POST /admin/access and PATCH /admin/access/:uid. One admin_access collection is authoritative for administrator permissions. Roles are the four names in scope.md; changing a record requires its revision.

## Steps

- [ ] 1. Write role-matrix tests and simultaneous attempts to demote/deactivate two remaining owners. Every change uses shared owner-membership fencing so snapshot write skew cannot remove the last owner.

- [ ] 2. Implement verified Google identity directory lookup for new email entries, normalize email safely and bind UID. Reject unverified/no-Google identity, duplicate UID, client-provided UID mismatch, unknown roles and wildcard/domain grants.

- [ ] 3. Implement fresh-auth owner-only create/update with audit and receipts. Deactivation preserves history and revokes next-call admission. No frontend-only role authority and no automatic conversion of every previous admin into an owner.

- [ ] 4. Create explicit trusted bootstrap dry-run/apply operation: privately supplied existing Google identity, empty-store precondition, no automatic startup seed, no hardcoded owner email, and refusal to overwrite existing access.

- [ ] 5. Write compatibility instructions for existing allowlist records: inspect read-only and propose a dry-run migration mapping; apply requires separate explicit authorization. Do not auto-migrate records while starting the API.

- [ ] 6. Run auth/access HTTP tests, concurrent-owner integration and operations command tests. Do not bootstrap a real owner during implementation validation.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Support cannot grant itself owner and receives 403 before directory lookup or mutation.
Scenario 2: Concurrent final-owner demotions result in one accepted write and one LAST_OWNER_REQUIRED/REVISION_CONFLICT.
Scenario 3: Dry-run bootstrap writes nothing; apply against a nonempty collection refuses.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin/admin-access.service.spec.ts src/operations/admin-command.spec.ts
npm run test:e2e -- test/admin-access.e2e-spec.ts
npm run build
node --test test/admin-access.integration.mjs
```

## Completion evidence

- [ ] One owner-controlled permission registry replaces conflicting planned foundations without changing live administrators.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
