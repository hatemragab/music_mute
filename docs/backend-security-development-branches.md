# MusicMute backend security development branches

**Status:** All five implementation branches merged; A1–E6 complete
**Collection branch:** `codex/backend-security-cost-hardening`
**Direct parent:** `codex/worker-rebuild`

The detailed, resumable implementation package is in
[backend-security/START-HERE.md](backend-security/START-HERE.md).

## Accepted branch order

1. [`hatem/account-quotas-admin-controls`](backend-security/tasks/01-account-quotas-admin-controls.md)
   — account-only 120-minute UTC monthly usage, global policy, one account override,
   administrator controls, and replacement of the old quota engine.
2. [`hatem/media-s3-cost-protection`](backend-security/tasks/02-media-s3-cost-protection.md)
   — 20-minute/50-MB media policy, upload/download grants and bytes, retained
   storage, Intelligent-Tiering, cleanup, and service cost ceiling.
3. [`hatem/job-queue-retries-refunds`](backend-security/tasks/03-job-queue-retries-refunds.md)
   — one processing plus three waiting jobs, oldest eligible picking, three total
   infrastructure attempts, five input attempts, and full failure refunds.
4. [`hatem/account-abuse-api-limits`](backend-security/tasks/04-account-abuse-api-limits.md)
   — compact typed events, layered limits, manual account restrictions, dashboard
   review, and MongoDB/Redis growth protection.
5. [`hatem/account-deletion-cleanup`](backend-security/tasks/05-account-deletion-cleanup.md)
   — exact fifteen-day recovery followed by permanent, resumable account and S3
   cleanup.

Every branch starts from the updated collection tip after the preceding branch is
reviewed and merged. Every PR targets `codex/backend-security-cost-hardening`.
Neither `main` nor `codex/worker-rebuild` is the implementation target.

## Package entry points

- [Accepted decisions and exact limits](backend-security/DECISIONS.md)
- [Roadmap and checklists](backend-security/ROADMAP.md)
- [Current-code replacement map](backend-security/REPO-STUDY-MAP.md)
- [Implementation agent rules](backend-security/AGENT-RULES.md)
- [Machine-readable branch state](backend-security/branch-manifest.json)
- [Test and evidence strategy](backend-security/architecture/06-test-strategy.md)
- [Manual provider/VPS checklist](backend-security/runbooks/PROVIDER-CONSOLE-CHANGES.md)
- [Official sources](backend-security/reference/SOURCES.md)

## Launch simplifications

- One free standard plan; paid plans are deferred.
- Quota belongs to accounts, not devices.
- All monthly limits use UTC calendar months.
- No advanced fair queue, priority, or subscription scheduling.
- No automatic abuse scoring or bans.
- No optional slow S3 archive tiers.
- No worker rebuild, machine-management, scaling, backup, or disaster-recovery work.
- Existing conflicting product rules are replaced, while proven auth, ownership,
  admin audit, transaction, Redis, S3, cleanup, and worker-fencing foundations are
  reused and tested.

## Review boundary

All five branches are merged into the collection branch with A1–E6 complete.
Provider changes and deployments remain outside the local branch workflow.
