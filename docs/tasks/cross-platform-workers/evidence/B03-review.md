# B03 independent task review

Date: 2026-09-14. Scope: B03 current source and its report inventory, with named
authority/HTTP/admin call-site checks. Reviewed prerequisite changes and unrelated
Android/F01 files were not attributed to B03. No production source was changed.

## Spec compliance

**Needs fixes:** two required diagnostic-reporting cases are unavailable. The
retained-history, transactional authority, privacy, body/quota and timeline design
otherwise matches the task and root's explicit boundary rulings.

## Strengths verified in source

- `backend/src/worker-events/worker-events.service.ts:47` reauthenticates setup
  credentials inside the append transaction and writes authorizationFence;
  `:63` writes the existing worker control fence and installation fence for
  permanent ingestion. Canonical installation/event identity is preserved across
  pairing. `:130` compares original-payload keyed fingerprints, acknowledges exact
  retained retries without renewal, and `:140` checks occurrence age only for new
  records. `:178` sets exactly first receipt plus 30 days.
- `backend/src/worker-events/worker-event-policy.ts:148` rejects unknown fields,
  bounds serialized input and uses fixed allowlists; unsafe diagnostic prose is
  redacted before persistence while original-input HMAC detects conflicts.
- `backend/src/http/configure-http.ts:18` installs a 65,536-byte noninflating JSON
  parser before the common parser. The native test at
  `backend/test/worker-events.integration.mjs:274` covers exact wire size,
  whitespace overflow and chunked overflow.
- `backend/src/rate-limits/weighted-quota-script.ts:5` checks all rate/byte
  buckets before writes and uses constant-space expiring counters. Existing
  ordinary reservations are preserved. Concurrent admission/nonconsumption is
  exercised in the native event test.
- `backend/src/worker-events/worker-events-query.service.ts:107` applies strict
  server expiry to pages and reporting queries; `:161` bounds page reads and
  `:174` selects the highest sequence in the latest reported operation.
  Signed cursors bind owner and filters. Reporting is separate from operational
  worker state; no permanent event tombstones or extra public readers were added.
- `backend/src/worker-events/worker-events.controller.ts:72` and `:81` require
  workers.read. Existing viewer/support membership is intentional. AuthModule
  remains before WorkerEventsModule in `backend/src/app.module.ts:26`; both new
  admin routes appear in the independent route inventory and compiled workflow.

## Important findings

### P1 — Keep permanent diagnostic ingestion available while processing is disabled

`backend/src/worker-events/worker-events.controller.ts:50-54` applies WorkerOnly
without the existing WorkerCleanup marker. Consequently
`backend/src/worker/worker-auth.guard.ts:45-49` rejects every POST /worker/events
when AUDIO_PROCESSING_ENABLED=false before credential authentication. A paired
worker whose setup token has expired cannot flush startup/update/repair failures
during a processing outage. This contradicts the required independent reporting
and repair channel. The report's processing-gate note does not approve this gap.

Use the established processing-independent authenticated control-route mechanism
(as `backend/src/worker-releases/worker-releases.controller.ts:142-145` does),
retaining all current credential and transaction fences. Add meaningful HTTP
coverage with processing disabled: valid permanent diagnostics succeed, missing,
setup-only, invalid and revoked credentials fail without persistence, and
revocation still wins against in-flight ingestion. Existing event integration
configuration at `backend/test/worker-events.integration.mjs:79` enables processing
throughout, so its current green result does not cover this case.

### P2 — Accept the approved safe setup/GPU failure vocabulary

`backend/src/worker-events/worker-event-policy.ts:52-79` omits the setup reason
codes explicitly required by `docs/tasks/cross-platform-workers/contracts.md:107`,
including GPU_UNAVAILABLE_IN_SERVICE, PREBOOT_UNLOCK_REQUIRED,
CPU_ONLY_UNSUPPORTED and DRIVER_ACTION_REQUIRED. An otherwise valid failure
event carrying one of these codes returns INVALID_EVENT; putting it in diagnostic
instead redacts the reason. Required setup failures therefore cannot reach the
timeline using the shared contract vocabulary, and one such event rejects its
whole batch.

Extend the strict fixed allowlist with the approved shared codes and keep the
safe API vocabulary documentation consistent. Add a table-driven check for all
contract codes plus representative HTTP persistence/readback, while preserving
unknown-code rejection and arbitrary diagnostic redaction. Do not accept free
text or add compatibility decoders.

## Named integration checks and validation

- Current-credential/revocation race risk: inspected WorkerRegistryService
  describeInstallation/state/fence and the event native revocation tests; both
  worker control and installation writes serialize persistence against revocation.
- Processing-disabled diagnostic risk: inspected WorkerAuthGuard and the existing
  WorkerUpdateController marker; the source directly demonstrates P1.
- Approved vocabulary drift risk: compared the shared contract's setup codes to
  event validation. Ran one focused Node source-policy probe in backend/ using
  prepareEventBatch with a valid startup/service failure carrying
  GPU_UNAVAILABLE_IN_SERVICE. Observed HTTP exception status 400, code
  INVALID_EVENT. No existing reported test answered this case.
- Admin guard-order/permission risk: inspected AppModule order, event controller
  metadata, dashboard route inventory and workflow wiring. No extra role change
  or public reader is required.
- No broad suites were rerun. Implementer's reported validation is preserved as
  reported evidence, not claimed as independently executed. Its pre-existing
  Mongoose validateSync deprecation warnings remain validation noise rather than
  a newly attributed B03 defect.
- Native GPU/OS/spool/dashboard-app/deployment proof remains outside this backend
  task. F01 Mac evidence files are outside this review.

## Task quality

**Needs fixes.** The implementation has cohesive policy/ingestion/query boundaries
and substantive isolated tests, but the two missing reporting cases must be
addressed before B03 is marked complete. No other actionable B03 issue was found
in this bounded review.

## Fix round 1 independent re-review

Date: 2026-09-14. **Spec compliance: approved for B03. Task quality: approved.**
Both important findings above are addressed; those findings describe the initial
reviewed state and are superseded by this verdict. No new actionable regression
was identified in the bounded fix.

- **P1 addressed:** `backend/src/worker-events/worker-events.controller.ts:56`
  adds WorkerCleanup to the event method while retaining class WorkerOnly. This
  changes only processing-toggle admission; existing current-credential identity
  checks and transactional worker/installation fences remain intact. The new HTTP
  case at `backend/test/worker-events.integration.mjs:274` disables processing,
  accepts the permanent token after setup expiry (fixture expiry at `:207`),
  rejects the expired setup endpoint and missing/setup-only/invalid/revoked
  permanent-route credentials, and checks rejected permanent events were not
  persisted. The race case at `:672` now exercises real HTTP with processing
  disabled: revocation after snapshot authentication returns 401 and stores no
  event. No processing/claim route was opened by this method-specific marker.
- **P2 addressed:** `backend/src/worker-events/worker-event-policy.ts:53` contains
  all 14 approved setup/GPU codes from shared contracts.md:107. Strict membership
  validation and diagnostic redaction remain unchanged. The table at
  `backend/src/worker-events/worker-events.service.spec.ts:21` asserts every code
  survives as both code and fixed safe diagnostic; unknown-code rejection remains
  at `:79`. `backend/test/worker-events.integration.mjs:336` verifies representative
  code/diagnostic HTTP persistence and administrator readback, plus redaction of
  private prose in the same accepted batch. API documentation describes the
  processing-independent channel and exact added vocabulary.
- **Evidence checked:** B03-report.md:245-263 records behavioral red/green for
  these precise gaps and the final focused runs: 41 unit tests, 15 native event
  integration tests, 83 HTTP tests, build, format, lint, typecheck and diff checks.
  These are implementer-executed results; this reviewer inspected the assertions
  and production fixes without rerunning answered tests or broad suites.
- **Remaining findings:** none within this fix scope. Prior backend validation
  limits remain: this approval does not establish native GPU/boot/spool/installer,
  dashboard application or deployment proof. F01/W02 artifacts were not reviewed.

Only this review report was appended during re-review; no production code, test,
configuration, credential, deployment or task-ledger mutation was made.
