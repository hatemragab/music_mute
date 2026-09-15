# B03: Implement structured worker events and exact 30-day visibility Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCAL REVIEWED — [independent re-review](../evidence/B03-review.md) approved both fixes with no remaining findings. See [implementation report](../evidence/B03-report.md) for validation and downstream limits.
**Goal:** Ingest bounded safe events before and after pairing, retain failures through successful retries, and expire detailed logs after 30 days.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B01, B02

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create backend/src/worker-events/ module, schema, ingestion service, query service, DTOs and worker-events.service.spec.ts.
- Create backend/test/worker-events.integration.mjs.
- Modify worker and installation controllers to use one ingestion service; reuse backend/src/job-errors/safe-job-error.ts patterns without making setup events require jobId.
- Modify backend/src/config/environment.ts for validated event/spool budget configuration.

## Interfaces

- Consumes WorkerEvent, owner scopes, event limits, and expiry semantics from contracts.md.
- Produces POST /worker/events, scoped installation event ingest, GET /admin/workers/:id/events and GET /admin/worker-installations/:id/events with identical filtered page shapes.

## Steps

- [ ] 1. Validate bounded structured events and allowlisted diagnostic fields. Reject credential-looking values and redact known secrets/URLs/paths before persistence; do not pass raw exceptions as diagnostic text.

- [ ] 2. Enforce 50-event/64-KiB batches, serialized event/diagnostic caps, category enums, positive sequences, and server-assigned owner/timestamps.

- [ ] 3. Create unique owner/eventId indexing. Identical retries succeed; conflicting payload reuse fails without overwriting the first event. Linking an installation to a worker preserves its original event identity.

- [ ] 4. Add server receivedAt plus exactly 30 days as expiresAt; use TTL and also filter expiry on reads. Do not trust a client timestamp to extend retention.

- [ ] 5. Use Redis byte/rate quotas and structured 429 Retry-After responses. Retain a final attempt result without deleting prior failure events.

- [ ] 6. Support category, operation, stage, status and time filters with cursor pagination and indexed joins. Never provide a public telemetry reader.

- [ ] 7. Represent stale setup as reporting_interrupted/outcome unknown. Keep current operational worker state separate from expired historical logs.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: TTL deletion is delayed
  Given a log expired one second ago but remains in MongoDB
  When an authorized admin lists or exports worker events
  Then the expired log is absent
  And a fresh event from the same worker remains visible
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm test -- src/worker-events/worker-events.service.spec.ts
npm run build
node --test test/worker-events.integration.mjs
```

## Completion evidence and limits

Redaction fixtures, duplicate/conflict behavior, quota tests, exact expiry boundary and paginated owner-isolation tests.

Do not reuse private audio_job_errors as a catch-all setup log table; its required job ownership is a different contract.
