# Backend security planning changelog

## 2026-09-19 — Branch 1 ready for review

- Replaced the 3,600-second rolling/temporary allowance paths with one account-only
  7,200-second UTC monthly policy.
- Added atomic processing reservations, success consumption, complete failure/cancel
  release, bounded retention, and concurrency coverage.
- Added revisioned global policy and one optional audited account override with
  administrator dashboard controls.
- Updated backend, dashboard, Android, and iOS contracts to explain the same
  effective account usage; device identity remains history only.
- Removed legacy settings/allowance routes and controls while keeping public policy
  schema version 1 compatibility.
- Passed backend, isolated integration, dashboard, Android, iOS focused/static, and
  documentation gates. Further device/UI E2E was deferred by maintainer request.
- Stopped before Branch 2, which remains unauthorized until review and merge.

## 2026-09-19 — Branch 1 started

- Recorded maintainer approval of the execution package.
- Created `hatem/account-quotas-admin-controls` from collection commit
  `0f8fb0572a309029dc6ada24d9da1c0fbfb8e0eb` in an isolated worktree.
- Marked checkpoint A1 in progress before changing application behavior.
- Limited this branch to account policy, monthly processing usage, account
  overrides, administrator controls, and their client contracts.

## 2026-09-19 — Documentation package created

- Replaced the earlier eight-area proposal with five sequential implementation
  branches accepted by the maintainer.
- Fixed account-only UTC calendar-month limits and deferred device enforcement.
- Fixed one-processing/three-waiting queue behavior, oldest-eligible picking, three
  total infrastructure attempts, full failure refund, and five input attempts.
- Fixed S3 upload/download/storage limits, ten-minute grants, Intelligent-Tiering,
  successful-output retention, and provider/manual boundaries.
- Fixed typed abuse events plus manual restrictions, with automatic bans deferred.
- Fixed fifteen-day deletion recovery and permanent account/media cleanup.
- Added checkpoint/task tracking, machine-readable branch state, evidence/PR
  templates, repository replacement map, architecture contracts, test strategy,
  provider runbook, and official sources.
- Marked every implementation checkpoint `NOT_STARTED`. No application code,
  provider setting, deployment, or real data was changed.
