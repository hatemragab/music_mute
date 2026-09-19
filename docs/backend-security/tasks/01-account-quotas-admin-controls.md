# Branch 1: account quotas and administrator controls

**Branch:** `hatem/account-quotas-admin-controls`
**Create from:** current accepted `origin/codex/backend-security-cost-hardening`
**PR base:** `codex/backend-security-cost-hardening`
**Checkpoints:** A1–A6
**Status:** `READY_FOR_REVIEW`
**Current checkpoint:** complete; waiting for maintainer review
**Evidence:** `../evidence/01-account-quotas-admin-controls.md`

## Assignment

Replace the old allowance/settings behavior with one account-only UTC-calendar-month
policy. Deliver global administrator settings, one optional account override,
atomic usage/reservation accounting, and clear backend/dashboard/client contracts.

Do not implement S3 grant counters, queue changes, abuse restrictions, or deletion
changes here. Define their policy fields only where needed by the shared resolver.

## Prerequisites

- [x] Read `START-HERE`, `AGENT-RULES`, `DECISIONS`, the repo study map, and
      architecture 01/06.
- [x] Confirm no predecessor feature branch is required.
- [x] Record collection SHA and branch SHA in a new evidence report.
- [x] Run focused existing processing-usage/settings tests and record the baseline.
- [x] Confirm the branch is isolated from active worker worktrees.

## A1. Inventory and replacement boundary

- [x] Trace every caller of the 3,600-second allowance, usage ledger, legacy
      processing settings, user allowance endpoints, dashboard allowance dialog, and
      mobile usage response.
- [x] Classify each affected file as `delete`, `replace`, `reuse`, or `extend`.
- [x] Record the final public/admin route and DTO compatibility plan.
- [x] Add tests that expose the old rolling/temporary behavior being replaced.
- [x] Confirm Firebase auth, ownership, admin guard/audit, transactions, and device
      history remain reused foundations.
- [x] Record obsolete local fields, collections, and indexes without deleting data.

**Exit:** evidence contains the complete caller/removal map and no unresolved dual
engine design.

## A2. Standard-plan policy

- [x] Add one validated revisioned global `standard` policy with accepted defaults.
- [x] Add a deterministic effective-policy resolver.
- [x] Reject invalid, partial-corrupt, unsafe, or stale-revision admin writes.
- [x] Record administrator, reason, revision, and audit event on changes.
- [x] Ensure unfinished later-branch fields cannot accidentally enable behavior.
- [x] Test all numeric boundaries and concurrent stale revisions.

**Exit:** one global policy is authoritative and legacy processing settings no longer
decide account quota.

## A3. UTC-month usage and processing reservation

- [x] Add unique account/period accounting using UTC calendar months.
- [x] Give a new account the full current-month 7,200-second limit.
- [x] Calculate next reset without a bulk reset job or carryover.
- [x] Implement atomic reserve, consume, release/refund, and idempotent replay.
- [x] Attach reservation to one job and accepted policy snapshot.
- [x] Reconcile interrupted terminal transitions without double settlement.
- [x] Add bounded closed-period retention without losing active reservations.
- [x] Test exact boundary, last-day signup, month rollover, duplicate requests, and
      two concurrent last-capacity reservations.

**Exit:** `used + reserved` cannot exceed the effective limit and infrastructure
failure can release the complete reservation exactly once.

## A4. Per-account override

- [x] Add at most one active partial replacement record per account.
- [x] Support optional expiry, reason, admin identity, times, and revision.
- [x] Ignore expiry at resolution time without relying on a scheduler.
- [x] Implement protected create/update/clear operations with expected revision.
- [x] Prevent direct counter editing and stacked/additive bonuses.
- [x] Test active, expired, cleared, reduced-below-usage, concurrent update, wrong
      permission, stale auth, and missing account behavior.

**Exit:** effective policy is explainable as global or global-plus-one-override and
every mutation is audited.

## A5. API, dashboard, and client contract

- [x] Replace `GET /processing-usage` with the versioned period/effective response.
- [x] Keep `GET /processing-policy` safe and client focused.
- [x] Add global account-policy settings UI with revision conflict handling.
- [x] Replace the allowance dialog with one override editor and clear action.
- [x] Show limit, used, reserved, released, remaining, reset, source, and expiry.
- [x] Keep installation/session history visibly separate from account quota.
- [x] Update Android/iOS response models only as required; no device enforcement.
- [x] Update backend/dashboard API and behavior documentation.

**Exit:** a searched account and the signed-in client receive the same effective
account-period explanation.

## A6. Remove legacy paths and verify

- [x] Remove old allowance computation, temporary allowance endpoints, old settings
      fields, stale dashboard controls, and unused tests/copy.
- [x] Search the repository for 3,600-second defaults and old route names; explain
      every remaining match.
- [x] Prove only one quota engine participates in admission/accounting.
- [x] Run focused unit and Mongo transaction integration tests.
- [x] Run backend `pnpm run format` and `pnpm run verify`.
- [x] Run relevant processing/dashboard integration suites.
- [x] Run the full dashboard gate.
- [x] Run client compile/tests if client contracts changed.
- [x] Run documentation/JSON/link/whitespace checks.
- [x] Update task, roadmap, manifest, evidence, and changelog.

**Exit:** reviewed PR is ready against the collection branch. Stop; branch 2 is not
authorized until this PR is accepted and merged.

## Required acceptance summary

- [x] 120 successful minutes renew each UTC calendar month.
- [x] Quota belongs only to the account and is shared across its devices.
- [x] A second account receives its own full allowance.
- [x] Failed infrastructure work does not consume minutes.
- [x] Admin global and account changes are protected, revisioned, and audited.
- [x] No old quota/settings engine or duplicate dashboard control remains active.
