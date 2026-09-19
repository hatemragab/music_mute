# Branch 4: account abuse and API limits

**Branch:** `hatem/account-abuse-api-limits`
**Create from:** updated collection after branch 3 merge
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** D1–D6
**Status:** `NOT_STARTED`
**Current checkpoint:** D1
**Evidence:** `../evidence/04-account-abuse-api-limits.md`

## Assignment

Record compact typed abuse signals, apply layered endpoint budgets, and give
authorized administrators manual account restriction controls. Do not implement
automatic scoring, automatic bans, or device enforcement.

## Prerequisites

- [ ] Confirm branch 3 is accepted/merged and fetch the new collection tip.
- [ ] Record exact ancestry and starting SHA.
- [ ] Read architecture 04/06 and provider constraints.
- [ ] Inventory every cost-creating public/admin route and existing UID/IP/global
      rate decorator/budget.
- [ ] Inventory admin permissions/audit and all account-state enforcement points.
- [ ] Run current rate-limit, guard, admin, and health tests as baseline.

## D1. Typed bounded events

- [ ] Add the accepted event type enum, severity, bucket, count, period, and safe
      metadata contract.
- [ ] Aggregate identical events atomically instead of inserting per request.
- [ ] Add 90-day detailed retention and compact twelve-month summaries.
- [ ] Prevent unbounded arrays, stack traces, request bodies, object keys, URLs,
      tokens, raw IP/email/UID/device identifiers.
- [ ] Add indexes only for account/type/date expiry and bounded admin filters.
- [ ] Test aggregation races, expiry, pagination, projections, and redaction.

**Exit:** repeated abuse produces bounded searchable evidence, not database growth.

## D2. Layered API budgets

- [ ] Map account/IP/endpoint/global budgets for create, upload grant, confirm,
      retry/cancel, download grant, deletion/recovery, and admin mutations.
- [ ] Reuse hashed Redis keys and the atomic multi-bucket script.
- [ ] Keep durable monthly quota checks in MongoDB after every Redis check.
- [ ] Return safe 429/503 behavior and valid `Retry-After` where appropriate.
- [ ] Fail closed for cost-creating operations when required Redis checks time out.
- [ ] Ensure safe reads follow explicit existing degraded-service rules.
- [ ] Test exact boundary, simultaneous last request, TTL, timeout, reconnect, and
      Redis reset without quota reset.

**Exit:** no cost-creating endpoint becomes unlimited when Redis or a client fails.

## D3. Manual account restrictions

- [ ] Add one revisioned active/expired/removed restriction record per account.
- [ ] Require reason, admin identity, audit, permission, and optional expiry.
- [ ] Enforce restriction on jobs, uploads, downloads, and user retry operations.
- [ ] Preserve authentication, status, deletion, and recovery access.
- [ ] Fence new worker ownership and define/test handling of in-flight work.
- [ ] Return safe user errors without detection internals.
- [ ] Do not create automatic restrictions from event counts.

**Exit:** authorized humans can restrict/restore one account safely and auditably.

## D4. Dashboard review and controls

- [ ] Add paginated filters for account, type, severity, and date.
- [ ] Show aggregate count, first/last time, and current restriction state.
- [ ] Add create/update/remove restriction forms with validation and confirmation.
- [ ] Handle fresh-auth, permission denial, stale revision, loading, empty, and
      backend failure states.
- [ ] Keep quota override and abuse restriction visually/semantically separate.
- [ ] Add accessible dashboard tests and update permission/API docs.

**Exit:** support can understand events and manually act without raw database access.

## D5. MongoDB and Redis cost protection

- [ ] Confirm every Redis security key has a bounded TTL and hashed identifier.
- [ ] Document/configure application expectations for 256 MB `noeviction` Redis
      without changing the VPS.
- [ ] Add sanitized readiness/alert signals for Redis memory/failures.
- [ ] Add bounded MongoDB cleanup and logical-size/operation alert hooks or operator
      instructions appropriate to Atlas Free.
- [ ] Review index/document sizes and query plans for all new schemas.
- [ ] Prove no abuse log, audit array, or grant record can grow without bounds.
- [ ] Update the provider console checklist without marking external steps complete.

**Exit:** the feature has a defensible memory/storage ceiling and documented outage
behavior.

## D6. Verification and handoff

- [ ] Run rate budget/key/throttler, admin guard/permission/audit, account-state,
      event/restriction, health, and HTTP E2E tests.
- [ ] Run isolated Redis/Mongo integration tests, including outage behavior.
- [ ] Run backend format/verify and relevant auth/dashboard integrations.
- [ ] Run the dashboard gate.
- [ ] Run docs/JSON/link/whitespace and sensitive-data pattern checks.
- [ ] Confirm device identity has no enforcement role and automatic bans are absent.
- [ ] Update progress/evidence/changelog and prepare the PR.

**Exit:** reviewed PR is ready against the collection branch. Stop before branch 5.
