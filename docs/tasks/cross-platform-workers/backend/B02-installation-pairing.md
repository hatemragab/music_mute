# B02: Implement scoped installation sessions and code approval Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCAL IMPLEMENTATION REVIEWED — no critical or important finding. See [report](../evidence/B02-report.md) and [review](../evidence/B02-review.md) for exact evidence and downstream limitations.
**Goal:** Allow pre-Python setup reporting and administrator-approved code pairing with retry-safe secret handling.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B01

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create backend/src/worker-installations/ module, controller, schemas, DTOs, service, presenter and installation-pairing.service.spec.ts.
- Modify backend/src/admin-workers/ integration points and backend/src/admin/admin-permissions.ts for the required admin actions.
- Create backend/test/worker-installations.integration.mjs and add module registration to backend/src/app.module.ts.
- Retire normal manual registration entry points after dashboard D01 replaces them; preserve audited idle credential rotation.

## Interfaces

- Consumes installation/pairing routes and limits in contracts.md, existing transaction/audit helpers and B01 runtime storage.
- Produces code request/approval/status/renewal APIs, permanent installation-to-worker binding, and receipts. A reporting token never authenticates normal worker routes.

## Steps

- [ ] 1. Implement immutable installationId/token digest registration with exact-binding idempotency; test conflicting retries, duplicate IDs and database race ordering.

- [ ] 2. Enforce public admission, bounded reporting-token expiry/renewal, per-session ownership, body limits, and non-secret receipts. Persist no raw capability or worker secret.

- [ ] 3. Bind pairing codes to a successful profile/service report and a fixed workerKeySha256. Apply 15-minute expiry, one-use approval, and rate limits without revealing whether arbitrary codes exist.

- [ ] 4. Require fresh authorized admin approval; atomically create registry/control binding and attach installation history. Do not set claim readiness from the admin click alone.

- [ ] 5. Make lost approval responses recoverable through installation status and permanent-token readiness. Race approval/rejection/expiry/duplicate submissions and assert exactly one worker identity.

- [ ] 6. Stop accepting changed credential digests after a code is issued. Expired reporting sessions cannot change existing worker bindings or bypass recovery.

- [ ] 7. Keep installation details private to worker administrators; redact codes, tokens, digests, personal hostnames, and raw hardware identifiers from lists/logs.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Approval response is lost
  Given a code was approved and one worker was created
  When the installer retries authenticated status
  Then it receives the same assigned worker ID
  And can authenticate with its already protected permanent secret
  And no second worker or secret-reveal response is created
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/worker-installations/installation-pairing.service.spec.ts
npm run build
node --test test/worker-installations.integration.mjs
```

## Completion evidence and limits

HTTP role/token-scope matrix, replay/expiry race outcomes, one identity after lost-response recovery, and no-secret response fixtures.

An attacker can create junk provisional requests; admission budgets and 30-day record cleanup must remain independent of job privileges.
