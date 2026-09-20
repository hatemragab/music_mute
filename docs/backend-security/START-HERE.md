# MusicMute backend security and cost work: start here

**Collection branch:** `codex/backend-security-cost-hardening`
**Direct parent:** `codex/worker-rebuild`
**Package status:** Branches 1–4 merged; Branch 5 E1–E6 are ready for review
**Implementation authority:** the maintainer authorized execution on 2026-09-19

## Purpose

This directory is the durable execution package for the accepted backend security
and cost work. It turns the product discussion into five sequential branches with
fixed decisions, code boundaries, checklists, tests, and evidence rules.

The implementation agent must be able to stop after any checkpoint and resume
without guessing. Progress is therefore recorded in four places:

1. the checkbox in [ROADMAP.md](ROADMAP.md);
2. the matching checkbox in the branch task file;
3. the branch status and `currentCheckpoint` in
   [branch-manifest.json](branch-manifest.json);
4. the actual command and result in a branch evidence report created from
   [templates/CHECKPOINT-REPORT.md](templates/CHECKPOINT-REPORT.md).

A checkbox is never evidence by itself.

## Read this package in this order

1. [AGENT-RULES.md](AGENT-RULES.md)
2. [DECISIONS.md](DECISIONS.md)
3. [REPO-STUDY-MAP.md](REPO-STUDY-MAP.md)
4. [ROADMAP.md](ROADMAP.md)
5. the one assigned file under [tasks/](tasks/)
6. the architecture file linked by that task
7. [architecture/06-test-strategy.md](architecture/06-test-strategy.md)
8. [runbooks/PROVIDER-CONSOLE-CHANGES.md](runbooks/PROVIDER-CONSOLE-CHANGES.md)
   only when preparing the operator handoff

Do not read a later task as authorization to start it.

## Decisions already settled

| Area                    | Accepted launch decision                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| Plan                    | One free standard plan; paid plans are deferred                                  |
| Quota identity          | Account only; installations are tracked but do not own quota                     |
| Processing              | 120 successful minutes per UTC calendar month, no carryover                      |
| Media                   | Maximum 20 minutes and 50,000,000 prepared bytes                                 |
| Upload grants           | 30 per UTC day and 200 per UTC calendar month                                    |
| Upload bytes            | 1,000,000,000 confirmed bytes per UTC calendar month                             |
| Queue                   | One processing job plus at most three waiting jobs per account                   |
| Picking                 | Oldest eligible queued job; no advanced fairness engine for launch               |
| Infrastructure failures | At most three total processing attempts; no user charge on failure               |
| Client/input failures   | At most five newly issued attempts for the same logical audio                    |
| Download grants         | 150 per UTC calendar month                                                       |
| Download estimate       | 10,000,000,000 bytes per UTC calendar month                                      |
| Signed URLs             | Maximum ten-minute validity and bucket signature age                             |
| Retention               | Successful output remains until job/account deletion; temporary input is cleaned |
| S3 class                | Intelligent-Tiering through Frequent, Infrequent, and Archive Instant Access     |
| Abuse response          | Typed events and manual account restriction; no automatic bans at launch         |
| Deletion                | Fifteen-day recovery period, followed by permanent cleanup                       |
| Admin override          | One active per-account replacement record with optional expiry                   |
| Devices                 | History only; no device quota, download limit, or device ban at launch           |

Exact units, counter timing, and boundary behavior are fixed in
[DECISIONS.md](DECISIONS.md).

## Branch chain

Every pull request targets `codex/backend-security-cost-hardening`. A later branch
starts only after its predecessor is reviewed, merged into the collection branch,
and the collection branch is fetched again.

```text
codex/worker-rebuild
└── codex/backend-security-cost-hardening
    ├── hatem/account-quotas-admin-controls
    ├── hatem/media-s3-cost-protection
    ├── hatem/job-queue-retries-refunds
    ├── hatem/account-abuse-api-limits
    └── hatem/account-deletion-cleanup
```

The diagram shows delivery order, not five branches created from the same old
commit. Each branch must start from the updated remote collection tip after the
previous merge.

## Resume protocol

Before changing code, the assigned agent must:

- [ ] read the repository and component instructions;
- [ ] run `git status --short --branch` and preserve unrelated work;
- [ ] fetch the remote without changing another worktree;
- [ ] confirm the assigned branch and collection ancestry;
- [ ] confirm the predecessor is merged into the collection branch;
- [ ] read the manifest, roadmap, assigned task, and existing evidence report;
- [ ] set only the assigned branch to `in_progress` in the manifest;
- [ ] record the exact starting SHA and current checkpoint;
- [ ] inventory affected code as `delete`, `replace`, `reuse`, or `extend`;
- [ ] run or record the focused pre-change tests that establish current behavior.

While working, update the task and evidence after each checkpoint. At branch end,
run the required branch gate, update the changelog, prepare the pull-request text,
and stop for maintainer review.

## Source-of-truth order

When documents appear to disagree, use this order:

1. the user's latest explicit instruction;
2. repository `AGENTS.md` and `CONTRIBUTING.md` rules;
3. [DECISIONS.md](DECISIONS.md);
4. the assigned task file;
5. architecture documents;
6. older top-level planning documents.

Do not silently resolve a real product conflict. Record it as `BLOCKED` if the
latest instruction and this accepted contract cannot both be satisfied.

## Current state

- Branch 1 checkpoints A1–A6 are merged into the collection branch.
- Branch 2 checkpoints B1–B7 are merged into the collection branch.
- Branch 3 completed C1–C7 and merged into the collection branch.
- Branch 4 completed D1–D6 and merged into the collection branch as PR #13.
- Branch 5 completed E1–E6 in `hatem/account-deletion-cleanup` and is ready for
  collection-branch review.
- No provider console, live database, Redis, S3, Firebase, deployment, or user data
  was changed.
- Device-based quota enforcement and automatic bans remain deferred.
