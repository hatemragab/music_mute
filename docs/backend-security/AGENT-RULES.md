# Rules for backend security implementation agents

These rules apply to all five implementation branches. They supplement, and do
not replace, repository-level instructions, `CONTRIBUTING.md`, and any applicable
component `AGENTS.md`.

## Authority and scope

Work only on the explicitly assigned branch and checkpoint. An implementation
assignment permits code changes, isolated tests, local commits, a push of that
branch, and a pull request only when the maintainer explicitly asks for those Git
actions. It does not permit merging, deployment, live-provider changes, production
data changes, secret rotation, or starting the next branch.

All pull requests use `codex/backend-security-cost-hardening` as their base. Never
send these commits to `main`, `codex/worker-rebuild`, or a worker feature branch.
Do not modify worker runtime, machine management, scaling, backup, or disaster
recovery behavior.

## Branch and worktree preflight

Before each branch:

1. inspect status, current branch, remotes, worktrees, and the relevant diff;
2. fetch `origin` and prove the accepted predecessor is in
   `origin/codex/backend-security-cost-hardening`;
3. create or resume the exact branch named in the manifest;
4. use a separate worktree when another task is active in the original checkout;
5. record the parent SHA in the checkpoint evidence report;
6. inspect workflow and deployment triggers before any push.

Never discard unrelated changes, run `reset --hard`, force-push, delete an
untracked file, or reuse a dirty worktree without understanding its owner.

## Progress bookkeeping

Each branch has checkpoint IDs. For every checkpoint:

- leave the checkbox unchecked until its exit criteria and tests have evidence;
- use only `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`, or `SIMULATED`;
- update the task's progress ledger and matching roadmap checkbox;
- update `status`, `currentCheckpoint`, and `lastVerifiedCommit` in the manifest;
- append commands, exit codes, observations, and limitations to the branch
  evidence report;
- do not replace a failing assertion with a weaker one merely to mark it complete.

When a test cannot run, use `NOT_RUN` or `BLOCKED`. A fixture, mock, typecheck, or
local build must not be presented as live S3, Atlas, Redis, Firebase, VPS, device,
or production proof.

## Replace product rules, preserve foundations

This project is in local development. When an old product rule conflicts with the
accepted contract, replace it cleanly rather than layering a second engine beside
it. Old quota, media-limit, retry, admin-control, and deletion-delay paths must not
remain active after their replacement branch.

"Rebuild" does not mean deleting proven infrastructure. Reuse and test these
foundations unless the assigned branch proves that one is defective:

- Firebase authentication and identity verification;
- owner-scoped authorization and job ownership checks;
- administrator admission, permissions, recent-authentication, and audit logging;
- MongoDB transaction helpers and durable job history;
- shared Redis client, hashed keys, and atomic counter script;
- exact-key S3 grants, checksum/size/version validation, and idempotent cleanup;
- installation/session history;
- worker claim, lease, attempt-fencing, and exact-output finalization protocols.

Do not keep legacy and replacement APIs, settings, collections, indexes, or
dashboard controls active together. Remove obsolete code only after its replacement
tests pass and its callers are updated.

## Data and environment safety

- Use synthetic accounts, jobs, audio, and identifiers in tests.
- Use isolated MongoDB databases, Redis namespaces, and S3 test prefixes.
- Never use live services merely because credentials are available locally.
- Never print connection strings, secrets, bearer tokens, presigned URLs, private
  media, or environment values.
- Do not run `FLUSHALL`, broad MongoDB drops, prefix-wide S3 deletion, bucket
  deletion, or user-data cleanup.
- Local development removes the need for production migrations; it does not grant
  permission to delete local or cloud data.
- Production schema behavior may create declared collections and indexes, but must
  not automatically drop indexes or rewrite documents.

## Fixed accounting rules

The backend is authoritative. Client-side checks are early feedback only.

- Account ID is the quota owner. Device/install ID is not a quota key.
- Daily counters use UTC days. Monthly counters use UTC calendar months.
- Idempotent replay of the same accepted request does not consume another grant.
- A newly issued upload or download grant consumes its grant counter even if it is
  never used.
- Confirmed upload bytes are counted once, after exact object verification.
- Download bytes are an estimate charged at grant issuance using the stored object
  size; presigned URL reuse is not observable by the API.
- Processing time is reserved atomically before queue eligibility, consumed only
  after success, and fully released after terminal infrastructure failure.
- Global policy changes do not rewrite the policy snapshot of already accepted
  work.

## API, database, and UI boundaries

Use strict DTO validation and safe public errors. Never expose provider details,
quota-detection internals, raw abuse rules, worker credentials, or internal MongoDB
fields. Maintain idempotency for every mutation that can create cost.

Durable usage, jobs, overrides, restrictions, and cleanup state live in MongoDB.
Redis stores bounded short-lived counters and rate limits; it is not the durable
quota or queue authority. MongoDB remains the job source of truth.

Admin UI controls must call protected backend APIs. The dashboard never edits raw
counters or documents. Every override, restriction, recovery, or destructive
operation records administrator identity, reason, time, and the affected account.

## Provider boundary

Backend branches may produce provider configuration documentation but must not
modify the AWS, Atlas, Redis/VPS, Firebase, CapRover, DNS, or billing consoles.
Use [runbooks/PROVIDER-CONSOLE-CHANGES.md](runbooks/PROVIDER-CONSOLE-CHANGES.md)
for the operator checklist. A provider step stays unchecked until a human executes
and verifies it.

## Required evidence

Every branch report records:

- branch, parent SHA, tested SHA, and PR base;
- exact files and behavior changed;
- code classified as removed, replaced, reused, or extended;
- exact commands and exit codes;
- test environment and whether infrastructure was real, isolated, mocked, or not
  available;
- boundary, duplicate-request, concurrency, authorization, and failure tests;
- compatibility and cleanup review;
- skipped checks, residual risks, and rollback/removal plan.

At branch completion, stop after preparing the reviewed PR and handoff. The next
branch remains unauthorized until the maintainer merges the predecessor and gives
an explicit continuation instruction.
