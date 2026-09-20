# Backend security and cost branch roadmap

**Collection:** `codex/backend-security-cost-hardening`
**Implementation checkpoints:** 32
**Current implementation status:** Branches 1–3 merged; Branch 4 D1–D6 ready for review

## 1. Sequential branch contract

| Order | Branch                                | Accepted predecessor            | Main output                                               | Task                                            |
| ----: | ------------------------------------- | ------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
|     1 | `hatem/account-quotas-admin-controls` | Collection documentation        | Monthly account policy, usage, overrides, admin UI        | [01](tasks/01-account-quotas-admin-controls.md) |
|     2 | `hatem/media-s3-cost-protection`      | Branch 1 merged into collection | Unified media, transfer, storage, and bandwidth limits    | [02](tasks/02-media-s3-cost-protection.md)      |
|     3 | `hatem/job-queue-retries-refunds`     | Branch 2 merged into collection | Bounded queue, picker, retries, settlement, refunds       | [03](tasks/03-job-queue-retries-refunds.md)     |
|     4 | `hatem/account-abuse-api-limits`      | Branch 3 merged into collection | Typed abuse records, manual restrictions, endpoint limits | [04](tasks/04-account-abuse-api-limits.md)      |
|     5 | `hatem/account-deletion-cleanup`      | Branch 4 merged into collection | Fifteen-day recovery and permanent idempotent cleanup     | [05](tasks/05-account-deletion-cleanup.md)      |

All PRs target the collection branch. A branch starts from the updated remote
collection tip, never independently from `main` or the old parent commit.

## 2. Checkpoints

### A. Account quotas and administrator controls

- [x] **A1:** Inventory and remove/replace the conflicting allowance and settings paths.
- [x] **A2:** Add one revisioned standard-plan policy and effective-policy resolver.
- [x] **A3:** Add atomic UTC-month processing usage, reservations, settlement, and summaries.
- [x] **A4:** Add one audited per-account replacement override with optional expiry.
- [x] **A5:** Replace backend/dashboard quota contracts and show effective usage clearly.
- [x] **A6:** Remove legacy quota controls and pass unit, integration, dashboard, and build gates.

### B. Media and S3 cost protection

- [x] **B1:** Replace all conflicting media policies with 20 minutes and 50,000,000 bytes.
- [x] **B2:** Enforce idempotent daily/monthly upload grants and confirmed monthly bytes.
- [x] **B3:** Preserve exact-key S3 verification and close abandoned/cancelled cleanup gaps.
- [x] **B4:** Enforce retained-output accounting and successful/temporary retention rules.
- [x] **B5:** Enforce download grants, estimated bytes, signed-URL age, and service ceiling.
- [x] **B6:** Update Android, iOS, dashboard, and public policy contracts without local duplicates.
- [x] **B7:** Pass storage/concurrency/client tests and finish the provider handoff checklist.

### C. Job queue, retries, and refunds

- [x] **C1:** Replace old admission/retry assumptions with one documented failure taxonomy.
- [x] **C2:** Enforce one processing plus three waiting jobs atomically per account.
- [x] **C3:** Implement oldest-eligible backend selection without a new queue authority.
- [x] **C4:** Make reservation, success consumption, cancellation, and full refunds idempotent.
- [x] **C5:** Enforce three total infrastructure attempts and five client/input attempts.
- [x] **C6:** Preserve claim/lease fencing while handling duplicate, late, and stale operations.
- [x] **C7:** Pass concurrency, recovery, compatibility, client-state, and end-to-end gates.

### D. Account abuse and API limits

- [x] **D1:** Add compact typed abuse events with aggregation and bounded retention.
- [x] **D2:** Apply account, IP, endpoint, and service budgets to cost-creating operations.
- [x] **D3:** Add audited manual account restrictions and safe backend enforcement.
- [x] **D4:** Add dashboard event filters and manual restrict/restore controls.
- [x] **D5:** Bound Redis/MongoDB growth and define fail-closed expensive-operation behavior.
- [x] **D6:** Pass authorization, rate, outage, privacy, dashboard, and capacity gates.

### E. Account deletion and cleanup

- [ ] **E1:** Replace the three-month policy with one exact fifteen-day recovery contract.
- [ ] **E2:** Enforce read-only recovery state without resetting quota or duplicating work.
- [ ] **E3:** Permanently purge owned S3, jobs, policy, usage, restriction, device, and identity data.
- [ ] **E4:** Make multi-provider cleanup leased, resumable, idempotent, and privacy-safe.
- [ ] **E5:** Update Android, iOS, dashboard, public copy, and operations documentation.
- [ ] **E6:** Pass recovery/deletion integration, interruption, privacy, client, and build gates.

## 3. Per-checkpoint completion rule

A checkpoint is complete only when all of these are true:

- the task exit condition is implemented;
- focused tests for normal, boundary, unauthorized, duplicate, and failure behavior
  pass or are explicitly marked unavailable;
- the evidence report records the command, exit code, environment, and observation;
- the task, roadmap, manifest, and changelog agree;
- no legacy path remains active beside the replacement;
- the diff contains no unrelated worker/provider/deployment work.

## 4. Branch gates

Every branch must pass the relevant focused tests plus:

- backend format, lint, typecheck, unit tests, E2E tests, secrets scan, and build;
- the owning isolated MongoDB/Redis integration suite;
- dashboard format, lint, typecheck, unit tests, and build when dashboard code changes;
- Android build/lint/unit tests when Android code changes;
- iOS formatting and tests on the single authorized simulator when iOS code changes;
- documentation formatting, links, JSON validation, and `git diff --check`.

Real Atlas, S3, Firebase, VPS, or deployed-system checks are separate and remain
`NOT_RUN` unless explicitly authorized and actually performed.

## 5. Handoff per branch

Create `evidence/<task-number>-<short-name>.md` from the checkpoint template. It
must identify the parent and tested SHA, delivered behavior, removed legacy paths,
tests actually run, security/compatibility review, provider steps still pending,
and residual risks.

The branch ends with a PR into `codex/backend-security-cost-hardening`. Stop for
review. Do not create the successor until the predecessor is merged and the
maintainer explicitly continues the roadmap.
