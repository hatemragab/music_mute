# B03 structured event ingestion local implementation report

Date: 2026-09-14. Local implementation and bounded validation completed for
independent review. No commit, push, deployment, publication, live service access,
real environment/credential access, migrations, backfills, legacy adapters or
operational data changes. Existing prerequisite and unrelated Android work was
preserved. The task status and ledger remain root-owned.

## Implemented contract

- New installation and permanent event POST controllers call one ingestion
  service. The canonical owner is the server-resolved installation ID under both
  authentication scopes. Unique installation/event ID indexing preserves original
  identity and dates; canonical keyed original-payload fingerprints distinguish
  conflicts even when both unsafe diagnostics redact to the same safe marker.
- Setup authentication checks current expiry/revocation and writes the same
  installation authorization fence in the persistence transaction. Permanent
  ingestion rechecks current registration/binding and writes both worker control
  and installation fences. Expired setup tokens stay expired while permanent
  credentials can flush retained events. No caller-supplied ownership is accepted.
- Actual event HTTP JSON body limit is 65,536 bytes before controller execution,
  including whitespace and chunked bodies; compressed encoding is refused.
  Other route body limits and parser error mapping remain unchanged. Bounds are
  1–50 events, 4,096 serialized UTF-8 bytes/event, 1,024 diagnostic UTF-16 code units,
  exact lowercase UUIDv4 IDs, canonical UTC and safe integer counters. Structured
  fields, stages, components and reason codes are allowlisted. Arbitrary diagnostic
  prose, URLs, paths and credential values become `[redacted]` before persistence;
  only fixed reason-code diagnostics survive. Public errors never echo inputs.
- Server receipt controls exactly 30*24*60*60 seconds of retention. TTL uses zero
  seconds on expiresAt; every available event reader independently applies
  expiresAt > server time. Identical retries cannot renew an expired-but-present
  row. Prior failures survive later successful attempts. Operational registry,
  qualification, control and credential reservations are not historical event
  rows and are unaffected by event expiry.
- New-event occurrence admission requires receipt-30days < occurredAt <= receipt.
  Explicit EVENT_CLOCK_AHEAD/EVENT_TOO_OLD responses include UTC serverTime.
  Expired exact retries may acknowledge while the row exists. After physical TTL
  removal, identical old payloads cannot recreate visible history. Per root's
  recorded ruling, changed payloads reusing deleted IDs are outside retained
  idempotency history; no permanent per-event tombstones were introduced.
- Existing security Redis gets bounded atomic weighted admission: constant-space
  counters, one per fixed-window budget, with no per-byte member allocation.
  Event rate and byte budgets succeed/fail together. Existing ordinary sliding
  reservations are unchanged. Defaults are 60 batches/minute, 2 MiB/setup/24h,
  20 MiB/permanent/24h, anchored at first admitted batch. All four new settings
  (including 300-second reporting staleness) have central validation and safe
  example values. Authenticated retries and subsequently rejected batches consume
  already-admitted traffic budgets; rejected multi-budget calls consume neither.
- Unchanged progress uses server receipt admission and the same operation,
  category, stage, code and sanitized details: minimum five seconds. Exact event
  retries and terminal records bypass this progress rule. Changed progress data
  remains admissible. All batch validation, conflicts, clock and progress failures
  roll back new event writes; 429 replies carry RATE_LIMITED plus Retry-After.
- Admin installation and worker pages require existing workers.read permission.
  Existing owner/worker_manager/support/viewer roles qualify; release_manager,
  public, setup and permanent worker credentials do not. Worker pages resolve the
  registry installation binding and use the same query/presenter. Missing binding
  fails explicitly. No public, detail or export event reader was introduced.
- Page filters are category, operationId, stage, status and inclusive server
  receipt from/to; default 50, max 100. Signed opaque cursors bind owner and filters,
  ordered by descending receivedAt/ObjectId. Schema indexes support scoped date,
  operation, category/status and operation-sequence queries.
- Reporting is explicitly scoped as most_recently_reported_operation, exposes its
  operationId, and is independent of page filters/cursor. Latest server receipt
  selects the operation; highest sequence within it selects its reported status,
  with receipt/ObjectId deterministic ties. Late lower-sequence progress cannot
  undo terminal success/failure. Server receipt controls staleness; a stale
  nonterminal observation becomes reporting_interrupted/outcome unknown. No
  visible history is unknown. This summary is not authoritative current setup or
  worker operational state, and distinct event IDs may share a sequence.

## Files and exported interfaces

New production files:

- backend/src/worker-events/worker-event-policy.ts: EventInput/EventDetails,
  EVENT_CATEGORIES/EVENT_STATUSES/EVENT_STAGES/EVENT_CODES, immutable retention/body
  constants, strict preparation, privacy policy, fingerprinting, clock admission,
  safe exception type and reporting derivation.
- backend/src/worker-events/worker-event.schema.ts: WorkerEvent and indexes.
- backend/src/worker-events/worker-events.service.ts: ingestSetup(id, bearer, body,
  actualBytes), ingestWorker(identity, body, actualBytes), transactional append.
- backend/src/worker-events/worker-events-query.service.ts: forWorker/forInstallation
  returning items, nextCursor, reporting and serverTime.
- backend/src/worker-events/worker-events.controller.ts and worker-events.module.ts:
  four scoped routes and feature composition.
- backend/src/rate-limits/weighted-quota-script.ts: atomic bounded fixed-window
  byte/rate counter admission.

Modified production/support files:

- backend/src/rate-limits/rate-budget.service.ts adds reserveWeighted and
  WeightedRateBucket without changing ordinary reserve semantics.
- backend/src/http/configure-http.ts enforces wire boundary and captures bytes;
  backend/src/http/public-exception.filter.ts preserves only the dedicated safe
  event exception codes/server UTC through existing generic input sanitization.
- backend/src/config/environment.ts; backend/.env.local.example and
  backend/.env.production.example; backend/src/app.module.ts (AuthModule remains
  before worker feature imports).
- backend/docs/api/worker-events.md and backend/README.md document APIs, exact
  vocabularies, quotas, retention and client handoffs.

Tests and independent route inventory:

- New backend/src/worker-events/worker-events.service.spec.ts and
  backend/test/worker-events.integration.mjs.
- Updated backend/src/config/environment.spec.ts,
  backend/src/rate-limits/rate-budget.service.spec.ts,
  backend/test/dashboard-contract.e2e-spec.ts,
  backend/test/fixtures/dashboard-contracts/routes.json,
  backend/test/helpers/dashboard-runtime.mjs,
  backend/test/helpers/auth-fixtures.ts (new model stub only).

All four routes:

| Method | Route | Interface |
| --- | --- | --- |
| POST | /worker-installations/:id/events | {events} -> {acceptedEventIds,duplicateEventIds,serverTime} |
| POST | /worker/events | Same request/receipt, permanent current identity |
| GET | /admin/worker-installations/:id/events | Scoped filters -> {items,nextCursor,reporting,serverTime} |
| GET | /admin/workers/:id/events | Same page, registered installation resolved server-side |

Routes are prefixed /api/v1. Full schemas, enum values and configuration bounds are
in backend/docs/api/worker-events.md and exported policy types.

## W03 / I01 / D01 / D03 handoff

W03/I01 must read server UTC and correct local clock offset before first event
submission. Retain original accepted/uncertain event payloads. Only an explicit
atomic rejection proving nonpersistence permits clock correction/rebatching. Keep
rejections and dropped counts inspectable locally; do not silently lose logs.
After setup expires, use the permanent endpoint with the same event IDs and
installation identity. Never renew setup capability merely to flush events.

Coalesce unchanged progress before batching while preserving first/last relevant
observations and every failure/terminal event. Server admission uses receipt time,
not occurredAt. A mixed batch containing repeated unchanged progress can reject
atomically; split/coalesce it after explicit rejection and obey Retry-After. This
does not delete accepted failures. Event vocabularies are explicit allowlists:
coordinate new stages/reason codes with the backend rather than sending arbitrary
error prose or native exception strings.

D01/D03 must retain filters with nextCursor, show the reporting summary's operation
scope, and keep actual operational readiness/installation state separate. Reads
can lose expired rows between pages, by design. Setup-era rows may retain null
workerId; canonical installation ownership supplies the worker timeline join.

The existing RATE_LIMIT_HASH_SECRET remains stable across instances; changing it
invalidates retained event fingerprints and cursors. There is no compatibility
decoder/key fallback. Permanent event HTTP routes follow the existing WorkerOnly
processing-enabled gate, as other normal permanent worker routes do.

## Red/green and commands actually run

Initial policy/native tests were written before implementation; their first runs
failed because the new source/compiled event modules did not exist (not counted as
behavioral assertion proof). After implementation, policy assertions passed. Exact
occurrence-age boundary test then failed on the missing helper and passed after
shared clock admission was factored out. Late spool ordering has direct behavioral
red/green: the native terminal-then-lower-sequence-progress test observed unknown
instead of succeeded before the query fix; the same test now passes.

From backend/:

- npm test -- src/worker-events/worker-events.service.spec.ts
  src/rate-limits/rate-budget.service.spec.ts src/config/environment.spec.ts:
  3 files, 90 tests passed (14 event policy, 5 rate, 71 environment).
- npm run test:e2e -- test/dashboard-contract.e2e-spec.ts: 77 tests passed,
  including new independent route metadata, roles and guard checks.
- npm run verify was run once. Its format/lint/typecheck/secrets stages passed;
  116 unit files/889 tests passed. Its HTTP stage initially had 15 failures because
  the shared fake-auth composition omitted the new WorkerEvent model stub. Added
  that stub only; no production auth bypass. Existing Mongoose validateSync
  deprecation warnings occurred in broad unit tests.
- After that fixture fix and final reporting-order fix, npm run test:e2e passed
  all 25 files/166 tests. npm run build passed (native compiled ESM output).
- Final node --test test/worker-events.integration.mjs
  test/dashboard-contract.integration.mjs: 14 tests passed. The dashboard runtime
  exercised both new admin pages (38 connected workflow requests, 13 audit events)
  and plain compiled main startup. Event native test includes 12 nested cases:
  authority/privacy/rollback; exact and chunked wire size; 50/51 bounds, age,
  future-clock rollback, TTL lag/deletion; concurrent identical retries; filtered
  owner/cursor isolation/stale status; concurrent weighted atomicity; stale guard
  identity revocation; worker revocation after snapshot; setup revocation after
  snapshot; unchanged progress/exact retry/terminal behavior; late lower-sequence
  spool ordering; Redis fail-closed nonpersistence.
- Scoped Prettier formatting was applied only to owned touched source/tests/docs.
  Final npm run format:check, npm run lint, npm run typecheck and git diff --check
  passed after all source/test changes. Build was run more than once and continued
  emitting the API entry point.

Native tests used helper-owned isolated MongoDB replica sets and Redis. The TTL
lag case drops only its test-owned TTL index so expired rows remain available for
read-filter assertions; it deletes only synthetic test event rows to simulate
physical TTL cleanup. Firebase identities, native profile/boot evidence and worker
credentials are synthetic fixture data, not real account/device proof.

## Remaining limits

Independent review is still requested. No native OS/GPU/service boot, installer or
spool implementation, dashboard application changes, mobile/device run, real S3,
production database, external Redis, live deployment, publication or distribution
proof is claimed. The complete legacy processing/admin integration suites were
not rerun in this bounded B03 task. No automatic cleanup of operational metadata
or credential reservations was introduced. Detailed events alone receive TTL.

## Fix round 1 — independent review P1/P2

2026-09-14. Addressed only the two findings in B03-review.md. The earlier report's
processing-enabled gate limitation is superseded by this fix. No authority fence,
retention ruling, quota, summary-ordering rule or existing administrator permission
changed. No new migration, adapter, agent, deployment or external state operation.

P1: PermanentWorkerEventsController.ingest now uses the existing WorkerCleanup
authenticated control-route marker in addition to WorkerOnly. Reporting is
available while AUDIO_PROCESSING_ENABLED=false, including after setup capability
expiry. Current permanent digest, registered installation binding, revocation and
both transaction fences remain unchanged. Missing credentials, setup-only tokens,
invalid tokens and revoked permanent credentials are rejected without events.
The existing worker revocation-after-snapshot test now runs through real HTTP
with processing disabled; revocation still aborts persistence after initial
authentication. This is reporting availability, not processing/claim enablement.

P2: EVENT_CODES now includes every required shared setup/GPU reason:
CPU_ONLY_UNSUPPORTED, GPU_PROVIDER_UNAVAILABLE, GPU_UNAVAILABLE_IN_SERVICE,
GPU_QUALIFICATION_FAILED, DRIVER_ACTION_REQUIRED, UNSUPPORTED_OS_ARCH,
DEPENDENCY_RECIPE_UNAVAILABLE, INSUFFICIENT_DISK, INSUFFICIENT_MEMORY,
MODEL_INTEGRITY_FAILED, PREBOOT_UNLOCK_REQUIRED, STARTUP_INSTALL_FAILED,
REPORTING_UNAVAILABLE and UPDATE_SIGNATURE_INVALID. These exact codes also remain
fixed safe diagnostic values. Unknown codes still reject and arbitrary diagnostic
prose still redacts. No free-text vocabulary or compatibility decoder was added.

Files changed in this fix round:

- backend/src/worker-events/worker-events.controller.ts: availability marker only.
- backend/src/worker-events/worker-event-policy.ts: 14 fixed approved codes.
- backend/src/worker-events/worker-events.service.spec.ts: table-driven assertions
  for every required code as both code and safe diagnostic.
- backend/test/worker-events.integration.mjs: disabled-processing permanent spool,
  expired setup, missing/invalid/setup-only/revoked denial, disabled HTTP revocation
  race, representative safe-code persistence/readback and unsafe-text redaction.
- backend/docs/api/worker-events.md: availability and approved vocabulary.
- This report: appended scoped evidence; no task/ledger/status edits.

Behavioral red/green was observed before changing production code: all 14 new
reason-code cases failed with INVALID_EVENT; the new disabled-processing HTTP
case returned 503 instead of 201; required-code HTTP ingest returned 400 instead
of 201. Following the two production changes, the same cases passed.

Commands run from backend/ after the fix:

- npm test -- src/worker-events/worker-events.service.spec.ts
  src/worker/worker-auth.guard.spec.ts: 2 files, 41 tests passed (28 event policy,
  13 existing authentication guard tests).
- npm run build: passed.
- node --test test/worker-events.integration.mjs: 15 tests passed, including
  14 nested cases and their parent, against helper-owned isolated replica-set
  MongoDB and Redis.
- npm run test:e2e -- test/worker-auth.e2e-spec.ts
  test/dashboard-contract.e2e-spec.ts: 2 files, 83 tests passed (6 worker auth,
  77 administrator route contracts).
- Scoped Prettier formatting, npm run format:check, npm run lint,
  npm run typecheck and git diff --check: passed.

No unchanged broad suites were repeated. Native GPU/OS/boot, local spool and
installer UI, dashboard application and live deployment proof remain outside this
backend fix. Ready for scoped independent re-review.
