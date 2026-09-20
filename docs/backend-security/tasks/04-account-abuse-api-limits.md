# Branch 4: account abuse and API limits

**Branch:** `hatem/account-abuse-api-limits`
**Create from:** updated collection after branch 3 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** D1–D6
**Status:** `READY_FOR_REVIEW`
**Current checkpoint:** D6 complete
**Evidence:** `../evidence/04-account-abuse-api-limits.md`

## Assignment

Record compact typed abuse signals, apply layered endpoint budgets, and give
authorized administrators manual account restriction controls. Do not implement
automatic scoring, automatic bans, or device enforcement.

## Prerequisites

- [x] Confirm branch 3 is accepted/merged and fetch the new collection tip.
- [x] Record exact ancestry and starting SHA.
- [x] Read architecture 04/06 and provider constraints.
- [x] Inventory every cost-creating public/admin route and existing UID/IP/global
      rate decorator/budget.
- [x] Inventory admin permissions/audit and all account-state enforcement points.
- [x] Run current rate-limit, guard, admin, and health tests as baseline.

## D1. Typed bounded events

- [x] Add the accepted event type enum, severity, bucket, count, period, and safe
      metadata contract.
- [x] Aggregate identical events atomically instead of inserting per request.
- [x] Add 90-day detailed retention and compact twelve-month summaries.
- [x] Prevent unbounded arrays, stack traces, request bodies, object keys, URLs,
      tokens, raw IP/email/UID/device identifiers.
- [x] Add indexes only for account/type/date expiry and bounded admin filters.
- [x] Test aggregation races, expiry, pagination, projections, and redaction.

**Exit:** repeated abuse produces bounded searchable evidence, not database growth.

## D2. Layered API budgets

- [x] Map account/IP/endpoint/global budgets for create, upload grant, confirm,
      retry/cancel, download grant, deletion/recovery, and admin mutations.
- [x] Reuse hashed Redis keys and the atomic multi-bucket script.
- [x] Keep durable monthly quota checks in MongoDB after every Redis check.
- [x] Return safe 429/503 behavior and valid `Retry-After` where appropriate.
- [x] Fail closed for cost-creating operations when required Redis checks time out.
- [x] Ensure safe reads follow explicit existing degraded-service rules.
- [x] Test exact boundary, simultaneous last request, TTL, timeout, reconnect, and
      Redis reset without quota reset.

**Exit:** no cost-creating endpoint becomes unlimited when Redis or a client fails.

## D3. Manual account restrictions

- [x] Add one revisioned active/expired/removed restriction record per account.
- [x] Require reason, admin identity, audit, permission, and optional expiry.
- [x] Enforce restriction on jobs, uploads, downloads, and user retry operations.
- [x] Preserve authentication, status, deletion, and recovery access.
- [x] Fence new worker ownership and define/test handling of in-flight work.
- [x] Return safe user errors without detection internals.
- [x] Do not create automatic restrictions from event counts.

**Exit:** authorized humans can restrict/restore one account safely and auditably.

## D4. Dashboard review and controls

- [x] Add paginated filters for account, type, severity, and date.
- [x] Show aggregate count, first/last time, and current restriction state.
- [x] Add create/update/remove restriction forms with validation and confirmation.
- [x] Handle fresh-auth, permission denial, stale revision, loading, empty, and
      backend failure states.
- [x] Keep quota override and abuse restriction visually/semantically separate.
- [x] Add accessible dashboard tests and update permission/API docs.

**Exit:** support can understand events and manually act without raw database access.

## D5. MongoDB and Redis cost protection

- [x] Confirm every Redis security key has a bounded TTL and hashed identifier.
- [x] Document/configure application expectations for 256 MB `noeviction` Redis
      without changing the VPS.
- [x] Add sanitized readiness/alert signals for Redis memory/failures.
- [x] Add bounded MongoDB cleanup and logical-size/operation alert hooks or operator
      instructions appropriate to Atlas Free.
- [x] Review index/document sizes and query plans for all new schemas.
- [x] Prove no abuse log, audit array, or grant record can grow without bounds.
- [x] Update the provider console checklist without marking external steps complete.

**Exit:** the feature has a defensible memory/storage ceiling and documented outage
behavior.

## D6. Verification and handoff

- [x] Run rate budget/key/throttler, admin guard/permission/audit, account-state,
      event/restriction, health, and HTTP E2E tests.
- [x] Run isolated Redis/Mongo integration tests, including outage behavior.
- [x] Run backend format/verify and relevant auth/dashboard integrations.
- [x] Run the dashboard gate.
- [x] Run docs/JSON/link/whitespace and sensitive-data pattern checks.
- [x] Confirm device identity has no enforcement role and automatic bans are absent.
- [x] Update progress/evidence/changelog and prepare the PR.

**Exit:** reviewed PR is ready against the collection branch. Stop before branch 5.
