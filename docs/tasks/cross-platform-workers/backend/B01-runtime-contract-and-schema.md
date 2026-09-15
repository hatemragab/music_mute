# B01: Add the new worker runtime contracts and persistence Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** FOUNDATION IMPLEMENTED AND LOCALLY VALIDATED; approved recipe/claim admission remains B05 (see [execution report](../evidence/B01-report.md)).
**Goal:** Introduce the new development worker identities, boot/profile readiness, and protocol-v3 fixtures directly.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** None; begin after implementation authorization.

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create backend/src/worker/worker-runtime.schema.ts, worker-runtime.service.ts, dto/worker-runtime.dto.ts and worker-runtime.service.spec.ts.
- Modify backend/src/worker/worker.controller.ts, worker-identity.service.ts, worker-registration.schema.ts and DTOs; register models in the current Nest module composition.
- Create worker/contracts/worker-protocol-v3.json and backend/test/worker-runtime.integration.mjs.
- Modify backend/src/config/environment.ts and safe example configuration only.

## Interfaces

- Consumes WorkerRuntimeReport and QualificationReport; existing WorkerSelectorDto fields remain unchanged.
- Produces validate/store/readRuntime(workerId, report), runtime schema, stable wire fixtures, and POST /worker/runtime plus installation-ready support. Require protocol version 3; do not add protocol-2 compatibility.

## Steps

- [ ] 1. Write DTO fixtures for valid reports and invalid enums, unsafe integers, wrong digests, duplicate IDs, oversized device strings, and unknown fields.

- [ ] 2. Store runtime observations separately from registration desired state and assignment ownership. Add the minimal indexes needed for worker joins and liveness; do not create a second active-slot model.

- [ ] 3. Add authenticated report endpoints, binding workerId from auth rather than the request body. Validate installation binding before accepting readiness.

- [ ] 4. Keep boot qualification separate from current liveness, and GPU recipe qualification separate from reported hardware inventory. Missing telemetry remains null.

- [ ] 5. Return the required protocol/media versions and update capability. Reject obsolete clients with a clear upgrade/reinstall reason; do not implement an old-client bridge.

- [ ] 6. Add managementRevision/controlRevision regression tests ensuring runtime/log events do not invalidate unrelated admin writes, while claim-affecting readiness changes use a lifecycle fence.

- [ ] 7. Run compiled-node integration with isolated MongoDB/Redis and the new worker contract fixtures.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Another worker tries to submit readiness
  Given token A belongs to worker A
  When A submits installation B in a readiness report
  Then the API rejects the binding
  And worker B and its assignment remain unchanged
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/worker/worker-runtime.service.spec.ts
npm run typecheck
npm run build
node --test test/worker-runtime.integration.mjs
```

## Completion evidence and limits

Valid/invalid wire fixtures, cross-worker rejection, strict protocol-v3 admission, and compiled startup proof. All commands run from backend/ unless a task explicitly says otherwise.

Breaking development changes are permitted. Use isolated fresh fixtures; do not reset real development state without authorization.
