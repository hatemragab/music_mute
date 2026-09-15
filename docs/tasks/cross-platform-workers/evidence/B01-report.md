# B01 runtime foundation execution report

2026-09-13. Local source and isolated fixtures only; no deployment.

## Implemented

- Strict nested runtime, qualification and boot DTOs: lowercase UUIDv4, bounded safe integers, lowercase SHA-256, allowlisted OS/architecture/activity/provider, bounded device strings and unique reason codes. Unknown keys and missing telemetry fail; unavailable memory stays null.
- Separate `audio_worker_runtime` observation model keyed by authenticated worker ID, with server receivedAt liveness index. No second active slot. Reported boot evidence remains distinct from current inventory and approved evidence.
- Immutable registration installation binding with a unique partial index. B02 must create the binding transactionally; runtime cannot register or pair an arbitrary installation.
- Permanent-auth `POST /worker/runtime` and `POST /worker/installation-ready`, no caller-supplied worker ID. Readiness validates matching installation/profile and credential binding, uses the existing transaction/lifecycle fence, and never enables a draining worker or modifies assignment ownership.
- Observations preserve boot evidence and both revisions. Readiness advances controlRevision while preserving managementRevision. Liveness uses server time.
- Identity returns protocol 3, media policy 2, and unsupported update capability. Non-v3 reports return HTTP 426 with WORKER_REINSTALL_REQUIRED and a safe reinstall instruction. No decoder/bridge was added.
- Checked-in synthetic protocol-v3 fixture and safe setup failure messages; runtime model/provider registered through existing processing composition.

## Test-first evidence

1. Added 16 DTO cases before implementation. After the expected missing-module failure, empty DTO scaffolds produced 2 failing acceptance tests (all fields rejected) and 14 passing rejection cases. Implemented validation: all 16 passed.
2. Added obsolete-protocol test before service behavior. Empty service resolved `{}`; rejection assertion failed. Implemented protocol rejection: 17 runtime tests passed.
3. Added native compiled integration before schema/persistence. Build passed; test failed with `StrictModeError: Field installationId is not in schema`. Implemented binding/schema/transactions; integration passed.
4. Self-review found the production public exception filter sanitizes HTTP 400 details. Added the real filter and expected 426 to the HTTP fixture: failed with `400 !== 426`. Changed protocol exception to 426; compiled HTTP test passed with reinstall reason preserved.

## Validation actually run from backend/

- `npm test -- src/worker/worker-runtime.service.spec.ts`: 17 passed.
- `npm test -- src/worker/worker-runtime.service.spec.ts src/worker/worker.controller.spec.ts`: 22 passed.
- `npm test -- src/worker/`: 11 files, 80 passed.
- `npm test`: 111 files, 824 passed. Existing schema tests emitted Mongoose validateSync deprecation warnings.
- `npm run typecheck`, `npm run lint`, and repeated `npm run build`: passed.
- `node --test test/worker-runtime.integration.mjs`: passed against fresh isolated Mongo replica set/Redis. Real schemas, transactions, controller, permanent authentication, DTO pipe and public exception filter prove binding rejection, foreign assignment preservation, server timestamps, boot evidence separation and revisions.
- `node --test test/infrastructure.integration.mjs`: passed; compiled API authenticated external Redis and recovered from isolated dependency outages.
- Scoped `npx prettier --check` for all 11 changed backend source/test files and `git diff --check`: passed after the final edits.

## Downstream gates and limits

- Readiness always returns `canClaim: false` and QUALIFICATION_APPROVAL_REQUIRED. Reported flags, report IDs and synthetic fixture hashes never become approved evidence.
- B05 must verify persisted qualification ownership and exact approved profile/OS/architecture/provider, fixture/model/runtime-lock hashes, build/media policy, service binding and execution evidence. The qualification DTO validates shape only; it is not approval.
- Existing coordinator fresh claims do not yet consume runtime, by execution direction. B05 owns that gate. This intermediate checkout is not a completed or deployable fleet-admission system.
- Before B05 consumes runtime, material changes (build/profile/model/lock/activity/service identity) must serialize eligibility recomputation through the lifecycle fence, or claims must fence the runtime row. Observation snapshot writes alone do not serialize these against claims. Pure telemetry must preserve managementRevision.
- B02 pairing, B03 event/log traffic, B04/B05 recipes/build policy, B06 removal of existing auth modes and update delivery remain downstream. No migration, backfill, compatibility constructor, temporary true qualification or arbitrary pairing was added.
- No new environment setting is necessary for fixed protocol/media constants and observation persistence. Runtime freshness configuration belongs with actual B05 admission enforcement; no unused setting implying enforcement was added.
- No hardware GPU, boot-service/reboot, signed recipe, public release or live-worker proof. F01 candidate recipes remain unavailable.
- Android and F01 work preserved. No commits, pushes, publication, deployment, real data changes or resets.

## Main files

`backend/src/worker/dto/worker-runtime.dto.ts`, `worker-runtime.schema.ts`, `worker-runtime.service.ts`, `worker-runtime.service.spec.ts`, `worker-registration.schema.ts`, `worker-identity.service.ts`, `worker.controller.ts`, `worker.controller.spec.ts`; `backend/src/processing/processing-persistence.module.ts`, `processing.module.ts`; `backend/test/worker-runtime.integration.mjs`; `worker/contracts/worker-protocol-v3.json`.
