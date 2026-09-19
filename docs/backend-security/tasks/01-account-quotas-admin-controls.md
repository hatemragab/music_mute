# Branch 1: account quotas and administrator controls

**Branch:** `hatem/account-quotas-admin-controls`
**Create from:** current accepted `origin/codex/backend-security-cost-hardening`
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** A1–A6
**Status:** `NOT_STARTED`
**Current checkpoint:** A1
**Evidence:** `../evidence/01-account-quotas-admin-controls.md`

## Assignment

Replace the old allowance/settings behavior with one account-only UTC-calendar-month
policy. Deliver global administrator settings, one optional account override,
atomic usage/reservation accounting, and clear backend/dashboard/client contracts.

Do not implement S3 grant counters, queue changes, abuse restrictions, or deletion
changes here. Define their policy fields only where needed by the shared resolver.

## Prerequisites

- [ ] Read `START-HERE`, `AGENT-RULES`, `DECISIONS`, the repo study map, and
      architecture 01/06.
- [ ] Confirm no predecessor feature branch is required.
- [ ] Record collection SHA and branch SHA in a new evidence report.
- [ ] Run focused existing processing-usage/settings tests and record the baseline.
- [ ] Confirm the branch is isolated from active worker worktrees.

## A1. Inventory and replacement boundary

- [ ] Trace every caller of the 3,600-second allowance, usage ledger, legacy
      processing settings, user allowance endpoints, dashboard allowance dialog, and
      mobile usage response.
- [ ] Classify each affected file as `delete`, `replace`, `reuse`, or `extend`.
- [ ] Record the final public/admin route and DTO compatibility plan.
- [ ] Add tests that expose the old rolling/temporary behavior being replaced.
- [ ] Confirm Firebase auth, ownership, admin guard/audit, transactions, and device
      history remain reused foundations.
- [ ] Record obsolete local fields, collections, and indexes without deleting data.

**Exit:** evidence contains the complete caller/removal map and no unresolved dual
engine design.

## A2. Standard-plan policy

- [ ] Add one validated revisioned global `standard` policy with accepted defaults.
- [ ] Add a deterministic effective-policy resolver.
- [ ] Reject invalid, partial-corrupt, unsafe, or stale-revision admin writes.
- [ ] Record administrator, reason, revision, and audit event on changes.
- [ ] Ensure unfinished later-branch fields cannot accidentally enable behavior.
- [ ] Test all numeric boundaries and concurrent stale revisions.

**Exit:** one global policy is authoritative and legacy processing settings no longer
decide account quota.

## A3. UTC-month usage and processing reservation

- [ ] Add unique account/period accounting using UTC calendar months.
- [ ] Give a new account the full current-month 7,200-second limit.
- [ ] Calculate next reset without a bulk reset job or carryover.
- [ ] Implement atomic reserve, consume, release/refund, and idempotent replay.
- [ ] Attach reservation to one job and accepted policy snapshot.
- [ ] Reconcile interrupted terminal transitions without double settlement.
- [ ] Add bounded closed-period retention without losing active reservations.
- [ ] Test exact boundary, last-day signup, month rollover, duplicate requests, and
      two concurrent last-capacity reservations.

**Exit:** `used + reserved` cannot exceed the effective limit and infrastructure
failure can release the complete reservation exactly once.

## A4. Per-account override

- [ ] Add at most one active partial replacement record per account.
- [ ] Support optional expiry, reason, admin identity, times, and revision.
- [ ] Ignore expiry at resolution time without relying on a scheduler.
- [ ] Implement protected create/update/clear operations with expected revision.
- [ ] Prevent direct counter editing and stacked/additive bonuses.
- [ ] Test active, expired, cleared, reduced-below-usage, concurrent update, wrong
      permission, stale auth, and missing account behavior.

**Exit:** effective policy is explainable as global or global-plus-one-override and
every mutation is audited.

## A5. API, dashboard, and client contract

- [ ] Replace `GET /processing-usage` with the versioned period/effective response.
- [ ] Keep `GET /processing-policy` safe and client focused.
- [ ] Add global account-policy settings UI with revision conflict handling.
- [ ] Replace the allowance dialog with one override editor and clear action.
- [ ] Show limit, used, reserved, released, remaining, reset, source, and expiry.
- [ ] Keep installation/session history visibly separate from account quota.
- [ ] Update Android/iOS response models only as required; no device enforcement.
- [ ] Update backend/dashboard API and behavior documentation.

**Exit:** a searched account and the signed-in client receive the same effective
account-period explanation.

## A6. Remove legacy paths and verify

- [ ] Remove old allowance computation, temporary allowance endpoints, old settings
      fields, stale dashboard controls, and unused tests/copy.
- [ ] Search the repository for 3,600-second defaults and old route names; explain
      every remaining match.
- [ ] Prove only one quota engine participates in admission/accounting.
- [ ] Run focused unit and Mongo transaction integration tests.
- [ ] Run backend `pnpm run format` and `pnpm run verify`.
- [ ] Run relevant processing/dashboard integration suites.
- [ ] Run the full dashboard gate.
- [ ] Run client compile/tests if client contracts changed.
- [ ] Run documentation/JSON/link/whitespace checks.
- [ ] Update task, roadmap, manifest, evidence, and changelog.

**Exit:** reviewed PR is ready against the collection branch. Stop; branch 2 is not
authorized until this PR is accepted and merged.

## Required acceptance summary

- [ ] 120 successful minutes renew each UTC calendar month.
- [ ] Quota belongs only to the account and is shared across its devices.
- [ ] A second account receives its own full allowance.
- [ ] Failed infrastructure work does not consume minutes.
- [ ] Admin global and account changes are protected, revisioned, and audited.
- [ ] No old quota/settings engine or duplicate dashboard control remains active.
