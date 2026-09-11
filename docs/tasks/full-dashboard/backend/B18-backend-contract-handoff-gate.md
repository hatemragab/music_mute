# B18: Backend integration, API documentation and frontend handoff gate Implementation Plan

> Implemented and validated locally on 2026-09-11. No commit, push, publication, deployment, production-data mutation or live owner bootstrap is implied.

**Status:** IMPLEMENTED AND VALIDATED LOCALLY\
**Goal:** Verify all administration APIs as one system before dashboard implementation begins.\
**Architecture:** Extend existing NestJS feature services and shared lifecycle authority; keep controllers thin and permission checks server-side.\
**Tech Stack:** NestJS, strict TypeScript ESM, Mongoose/MongoDB transactions, existing Firebase/S3/Redis services, Vitest and compiled-node isolated integrations.\
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** [B03](../backend/B03-administrator-access-management.md), [B05](../backend/B05-worker-admin-controls.md), [B06](../backend/B06-processing-settings-admission.md), [B07](../backend/B07-user-search-processing-suspension.md), [B08](../backend/B08-job-search-detail-attempts.md), [B09](../backend/B09-admin-job-cancel-retry.md), [B10](../backend/B10-private-media-access.md), [B11](../backend/B11-release-model-public-policy.md), [B12](../backend/B12-apk-upload-verification.md), [B13](../backend/B13-publish-withdraw-update-policy.md), [B14](../backend/B14-outdated-client-admission.md), [B15](../backend/B15-overview-statistics.md), [B16](../backend/B16-health-dashboard-alerts.md), [B17](../backend/B17-csv-exports.md).

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly.

## Files and responsibility

- Create backend/docs/dashboard-api.md, dashboard-local-validation.md, dashboard-permissions.md and backend/test/dashboard-contract.e2e-spec.ts.
- Create backend/test/dashboard-contract.integration.mjs, backend/test/dashboard-curl.integration.mjs and backend/test/fixtures/dashboard-contracts/ fixture JSON files with synthetic data only.
- Modify backend/package.json with test:dashboard:integration, test:dashboard:curl and scoped validation scripts; update backend/README.md only for API/local usage. Do not change hosting or deployment files.

## Interfaces

Freeze contracts.md route inventory against implemented Nest routes and tested JSON fixtures. Typed frontend fixtures consume the finalized API shapes; API-only proof includes auth/permissions, admin media grants, lifecycle races, publication and exports.

## Steps

- [x] 1. Build an endpoint-to-permission matrix test covering every admin route, anonymous/user/worker credentials and all five roles. Add unknown-property/body/cursor/rate-limit tests and no-store/redaction assertions.

- [x] 2. Create compiled-node integration entrypoints using isolated Mongo replica-set/Redis/Firebase helpers and fake S3 signing/verifier where appropriate. Add a curl-driven run against a uniquely named database on the connected local MongoDB replica set. Record which tests use real local APK tools and which use doubles.

- [x] 3. Exercise owner grant -> worker registration -> queued job -> drain/recovery -> support suspension/media grant -> release verification/publication/withdrawal -> CSV/audit in fixture-only flows. Assert no privilege escalation, duplicate processing or lost audit.

- [x] 4. Write full public/admin API docs with route/method/auth/query/body/required flags/success/error JSON, concurrency/retry semantics, permissions and source references. Include existing-plan mapping and mobile/Windows protocol prerequisites without implementing them.

- [x] 5. Run scoped formatter first, npm run verify, dashboard compiled integration and relevant existing auth/processing/deletion suites. Verify repeat builds emit dist/main.js and start compiled Node with isolated test config; do not use production databases or owner accounts.

- [x] 6. Record a handoff report with implemented route count, exact commands/results, fixture coverage, local-runtime blockers and contract discrepancies. Backend gate passes only when implemented backend acceptance is proven; missing fleet client deployment, live S3 CORS or mobile dialog proof remains separate.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: Every documented endpoint has a permission test and an observed response fixture.
Scenario 2: Forbidden requests never mint a URL, reveal key material or mutate a record.
Scenario 3: Compiled API startup and repeat build pass independently of transformer-only tests.
```

## Validation

Run from `backend/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm run verify
npm run test:dashboard:integration
npm run test:dashboard:curl
npm run test:auth:integration
npm run test:processing:integration
npm run test:deletion:integration
npm run build
npm run build
```

## Completion evidence

- [x] Backend work is reviewable and validated; D01 may begin. No deployment or source commit is implied.
- [x] Record changed-file scope, exact validation commands/results and current branch in the execution and local-validation records.
- [x] Review changed backend scope for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
