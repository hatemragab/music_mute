# B01: Administrator identity, permissions and HTTP foundation Implementation Plan

> For agentic workers: when implementation is separately authorized, use superpowers:executing-plans to execute this task with review checkpoints. This file authorizes no execution now. Do not commit, push, publish, deploy or change real data.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Admit verified Google administrators without requiring a mobile profile, and enforce the shared permission matrix on every request.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** None.

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/src/admin/admin.module.ts, admin.types.ts, admin.decorators.ts, admin.guard.ts, admin-session.controller.ts, admin-access.schema.ts, admin-permissions.ts, admin-errors.ts, admin-rate-limit.service.ts within backend/src/admin/.
- Modify backend/src/auth/auth.guard.ts, auth.decorators.ts, auth-request.ts, firebase-identity.service.ts; backend/src/app.module.ts only at module/guard registration points.
- Create backend/src/admin/admin.guard.spec.ts, admin-permissions.spec.ts; backend/test/admin-auth.e2e-spec.ts and backend/test/helpers/admin-harness.ts.

## Interfaces

GET /admin/session -> AdminSession. AdminGuard attaches a server-derived AdminActor {uid,verifiedEmail,role,permissions,authTimeSec}; authorization decorator accepts permission names from contracts.md. All later controllers consume this actor; none accept actor UID or grants in a request body.

## Steps

- [ ] 1. Add HTTP fixture helpers in admin-harness.ts using Nest testing and existing Firebase verification doubles: createAdminHarness(), signInAs(role), request(method,path,body?), seedAdmin(), close(). Return real HTTP status/body/headers; never bypass the guard being tested. Keep emulator/production credentials out.

- [ ] 2. Write failing tests for anonymous, ordinary Google user, worker bearer, custom/password-provider token, disabled/revoked Google identity, stale auth time, and allowlisted Google UID with no mobile profile. Assert 401/403 and no protected data according to contracts.md.

- [ ] 3. Extract/reuse verified Firebase identity checks before the mobile-profile requirement. Introduce explicit admin-route metadata without marking it Public; preserve exact existing mobile/worker guard behavior and global rate limits.

- [ ] 4. Define role-to-permission mapping once. Read current active admin registration each request; deny unrecognized role, missing record, mismatched UID/email or removed access. Do not auto-register by email or startup side effects.

- [ ] 5. Apply no-store, bounded admin error envelopes and rate limits via existing infrastructure. Fresh-auth checks are per mutation class; UI receives ADMIN_REAUTH_REQUIRED. Do not log tokens, raw request bodies or identities during authentication failure.

- [ ] 6. Run focused admin and existing auth/worker guard tests, then HTTP admission tests. Record the exact failure-to-pass proof and compatibility results.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Given a verified Google UID with an owner registration and no mobile user record, GET /admin/session returns 200 and owner grants.
Scenario 2: Given an ordinary authenticated mobile user, the same route returns 403; a worker bearer returns 401.
Scenario 3: Removing access after one successful read makes the next read fail; a 301-second-old authTime cannot perform a fresh-auth mutation.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/admin src/auth/auth.guard.spec.ts src/worker/worker-auth.guard.spec.ts
npm run test:e2e -- test/admin-auth.e2e-spec.ts
```

## Completion evidence

- [ ] Admin routes have a distinct verified identity boundary and the exact role matrix; existing clients still authenticate as before.
- [ ] Attach changed-file list, exact validation commands/results and tested revision.
- [ ] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [ ] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
