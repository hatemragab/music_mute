# Backend audio processing task tracker

Date: 2026-09-09. Status: **backend implementation complete and locally verified**.

- [Specification](../superpowers/specs/2026-09-09-audio-processing.md)
- [Implementation plan](../superpowers/plans/2026-09-09-audio-processing.md)

## Agreed scope

Voice-only MP3; input under 600 seconds and 30,000,000 bytes; private presigned
S3 transfers; permanent file/history/error retention; unlimited submissions;
FIFO after verified upload; one external Z440 job at a time; user cancellation;
safe persistent errors; manual failure retry at queue tail; personal-computer
shutdown recovery; backend FCM notifications. No Z440 or mobile implementation.

## Execution order

| ID    | Deliverable                                        | Dependencies        | Required acceptance                                                                   |
| ----- | -------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| AP-01 | Persistence, transitions and isolated transactions | —                   | Boundaries, strict schemas/indexes, aborted transactions, auth-only startup preserved |
| AP-02 | Worker-only authentication                         | AP-01               | User/worker credential separation, no public bypass, rotation/disabled behavior       |
| AP-03 | S3 grants and verified object identities           | AP-01               | Exact policy, pinned version/checksum, private bucket preflight, no mutation          |
| AP-04 | Upload reservation and FIFO enqueue                | AP-01, AP-03        | Owner/idempotency checks, verification race, durable enqueue order                    |
| AP-05 | Owner history and downloads                        | AP-04               | Pagination, isolation, no key/diagnostic leaks, state-checked GET grants              |
| AP-06 | Global claim, heartbeat and stages                 | AP-02, AP-04        | Concurrent sessions/API replicas produce one active assignment; FIFO                  |
| AP-07 | Cancel, failure log and manual retry               | AP-05, AP-06        | Stopped acknowledgment, transactional errors, tail retry, duplicate callbacks         |
| AP-08 | MP3 output and durable completion                  | AP-03, AP-06, AP-07 | Attempt-scoped result, verified object, cancel race, atomic ready/outbox              |
| AP-09 | Personal-PC shutdown recovery                      | AP-06, AP-07, AP-08 | Held slot on expiry, stopped reconciliation, adopt uploaded result, stale rejection   |
| AP-10 | FCM registration ownership                         | AP-01               | Token/account switch, logout cutoff, opt-out, private destinations                    |
| AP-11 | Notification dispatch and retry                    | AP-08, AP-10        | Durable targets, partial failure, crash/retry, no processing regression               |
| AP-12 | Regression and backend/worker handoff              | AP-01–AP-11         | Full backend gates, matching contracts, operations and separate live-proof items      |

Execute in the listed order. **Start with AP-01.** Tasks may have fewer logical
dependencies, but delegation and parallel editing are not required by this plan.

## Progress and evidence

- [x] AP-01 — strict schemas, limits, opt-in startup and replica transaction persistence.
- [x] AP-02 — explicit worker authentication, credential separation and rotation/disabled coverage.
- [x] AP-03 — exact S3 policies, version/checksum verification and private retention preflight; live AWS proof remains separate.
- [x] AP-04 — owner reservations, idempotency, upload verification and FIFO sequence allocation.
- [x] AP-05 — private owner history, stable cursor pagination and state-checked download grants.
- [x] AP-06 — one transactional global assignment, heartbeat deadlines and stage receipts.
- [x] AP-07 — cancellation/stopped acknowledgment, safe error logs and tail retries.
- [x] AP-08 — attempt-specific voice-only MP3 reservation and atomic ready/receipt/outbox completion.
- [x] AP-09 — retained slot on expiry, explicit stopped recovery, uploaded-result adoption and concurrent replay fixes.
- [x] AP-10 — current installation ownership, registration rotation/opt-out, session cutoff, stale claim rejection and bounded owner-filtered paging.
- [x] AP-11 — durable delivery targets, bounded retries, invalid-token cleanup and crash recovery with starvation regression.
- [x] AP-12 — API/operations handoff, independent review fixes and all local regression gates passed.

For each completed task record the changed files, actual validation commands,
results, and remaining limitations here. Do not copy earlier auth/starter test
results as evidence for this feature.

### Current implementation evidence

Final combined gate results on 2026-09-09:

| Command                               | Observed result                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run verify`                      | Passed: Prettier, zero-warning lint, typecheck, 319 unit tests, 33 HTTP tests, Nest build                        |
| `npm run test:processing:integration` | Passed: 19 tests across replica persistence, HTTP jobs, queue/recovery, push ownership and notification delivery |
| `npm run test:auth:integration`       | Passed: 17 tests, including compiled API and standalone device ownership behavior                                |
| `npm run test:integration`            | Passed: 1 external Redis/Mongo readiness and outage-recovery test                                                |
| `npm run build` repeated afterward    | Passed                                                                                                           |

Main implementation files are in `src/jobs/`, `src/worker/`, `src/processing/`,
`src/storage/`, `src/notifications/`, and `src/job-errors/`. Device ownership adds
`src/devices/device-installation-owner.schema.ts` and its service; Firebase messaging
reuses `src/auth/firebase.module.ts`. See the [API](../api/audio-processing.md) and
[operations handoff](../operations/audio-processing.md) for exact contracts.

Account-switch review coverage includes new account sign-in before push
registration, stale older claims, equal-time ambiguity, and bounded raw paging
through stale registrations. The auth integration now obtains a genuinely newer
emulator sign-in for its account-switch scenario.

- Full existing HTTP suite: `npm run test:e2e` passed 33 tests. Infrastructure integration passed 1; auth integration passed 17. These were run with processing/push routes composed into the app.
- Upload/history HTTP integration passed, including unknown-field refusal, cross-owner 404, no-store grants, stable pagination under inserts, and state surviving API restart.
- Coordinator integration passed concurrent claims with one global slot, FIFO selection, repeated claim, and expired lease refusal.
- Cancellation/failure integration passed held slot, stopped-only finalization, safe allowlisted errors, duplicate failure receipt, and new-job retry.
- Output integration passed repeated reservation/conflict, atomic rollback on injected outbox write failure, durable completion replay after restart, and output adoption after a storage outage.
- Recovery integration passed retained slot on restart, one interruption record, concurrent same-session reconciliation, expired replacement discovery, and terminal replacement replay.
- Cancellation race integration passed cancellation during output verification and disconnected cancellation requiring stopped reconciliation; both input and output objects remained retained.
- Independent worker lifecycle review identified three issues (concurrent recovery, expired replacement discovery, poll hint); each is fixed, and the extended recovery regression passes.
- Notification review fixes cover invalid-token deactivation before terminal delivery persistence and an orphaned eighth attempt that previously could starve later events; the isolated dispatcher suite passes 8 tests.
- Storage regression rejects the mutable S3 literal `null` version; the focused transfer suite passes 12 tests.
- `npm audit --omit=dev --json` reports 10 existing production-dependency findings (6 moderate, 4 high; no critical). Dependency remediation beyond the added matching-version AWS POST signer is not included in this feature.

- AP-01 red/green: input/state and processing-environment tests first failed on missing behavior; 35 tests then passed. Schema/startup checks also observed missing implementations before passing.
- `npm test -- src/jobs src/processing src/config`: 96 tests passed; `npm run typecheck` and `npm run build` passed.
- `node --test test/processing-persistence.integration.mjs`: 1 real replica-set integration test passed, covering atomic commit/rollback of processing records and no TTL indexes.
- Isolated helper red/green: standalone and replica-set tests first reported 1 failure for missing opt-in support, then `node --test test/helpers/isolated-services.test.mjs` passed 3 tests, including real commit/abort.
- Execution keeps the existing checkout/branch as requested. Storage and isolated-fixture work use explicitly separate file ownership; no source changes outside backend.

## Release acceptance

- [x] Formatter, lint, typecheck, unit/HTTP tests and repeat build pass.
- [x] Existing infrastructure and auth integration tests pass.
- [x] New isolated MongoDB replica-set processing/recovery/notification tests pass.
- [x] No automatic deletion/expiration of retained business data or S3 objects.
- [x] Worker shutdown does not release a slot or lose accepted job/input metadata.
- [x] Cancelled/stale attempts cannot publish results; ready status survives FCM failure.
- [x] User/worker API documentation matches the implemented handlers and DTOs.
- [ ] Real deployment's MongoDB transaction and S3 retention/privacy prerequisites verified separately.
- [ ] Authorized nonproduction AWS policy/integrity check completed separately; retain test objects.
- [ ] External Windows worker and real device notification/live workflow verified separately, outside backend implementation scope.

No commits, pushes, deployments, real-account creation, or live storage mutations
are included in task execution without an explicit separate request.
